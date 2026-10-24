import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TextProps } from 'claude-code'

import type { Entry, FollowUp, Word } from '../types'

const PANE = 'english-tutor'
const TITLE = 'English tutor'
// Prompts longer than this are usually pasted logs or code: not worth a call.
const MAX_CHARS = 600
// Context sent with each prompt, held to fixed sizes so one call stays cheap:
// the agent's last reply (its tail) and the previous prompts.
const REPLY_TAIL = 600
const PREV_PROMPTS = 2
const PREV_CHARS = 200
const MAX_FIXES = 4
const MAX_WORDS = 3
const LOG_LINES = 1000
// A follow-up carries only its card and the card's last few questions.
const FOLLOW_ROUNDS = 3

// On in every session from its start; the person's close of the pane turns
// it off for that session alone, and nothing is reviewed while it is off.
const isOn = atom({ plugin: 'english-tutor', key: 'isOn' } as const, true)
const useContext = atom({ plugin: 'english-tutor', key: 'useContext' } as const, true)
// Prompts sent and not yet reviewed, oldest first: drawn with a spinner.
const pending = atom({ plugin: 'english-tutor', key: 'pending' } as const, [], { shape: 'pending-1' })
const frame = atom({ plugin: 'english-tutor', key: 'frame' } as const, 0)
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// One timer both picks up the queue and turns the spinner.
const TICK_MS = 120
const entries = atom({ plugin: 'english-tutor', key: 'entries' } as const, [], {
  shape: 'entries-1',
})
const followField = atom({ plugin: 'english-tutor', key: 'followField' } as const, null, {
  shape: 'follow-field-3',
})
// Follow-ups sent and not yet answered, oldest first: drawn with a spinner.
const followPending = atom({ plugin: 'english-tutor', key: 'followPending' } as const, [], {
  shape: 'follow-pending-1',
})

const SYSTEM = `You are the English tutor that runs beside a Chinese developer's coding sessions. The developer's native language is Simplified Chinese; they are learning English. You review ONE prompt they just sent to their coding assistant. You are not that assistant: never answer or act on the prompt.

Input:
- <prompt>: the text to review.
- <context> (optional): recent conversation, cut short. Use it only to understand what the developer means. Never review or translate it.
- <mode> (optional): "check" or "tutor" decided for you. When present, use it.

The developer often types by voice. A word that makes no sense where it stands (e.g. "spiritual" where "它们" fits) is a speech-recognition error: read it by its intended meaning and never correct, teach or mention it.

Step 1, decide the mode (when <mode> is absent) by which language carries the grammar of the prompt, not by how many English words appear:
- "tutor": the sentences are built in Chinese, even with English words, terms, code or file names inside. Examples: "帮我 fix 一下 login 的 bug"; "spiritual 都放到 utils 文件夹里"; "可以，config 放 src 下面".
- "check": the developer is trying to write English, even with Chinese names inside. Examples: "Please move 用户设置 into the settings folder"; "Yeah, name is ok, and remove number:".
- Whole sentences in both languages: the language of most of the text.

Step 2, by mode:
- "check": "fixes" lists only real mistakes or clearly unnatural phrasing, at most ${MAX_FIXES}. Each fix covers its own part of the prompt: no two fixes overlap and no fix repeats another inside a longer span. Never list a part that is already fine. "from" is the original fragment, "to" the replacement, "why" one short Chinese sentence. "natural" is the whole prompt as a native developer would type it. Any Chinese inside an English prompt is something the developer could not yet say in English: give each Chinese fragment its own fix, "from" the Chinese, "to" the English that fits the sentence, "why" a short Chinese note on the word. Use mode "clean" (everything else empty) only when the prompt is all English and already natural.
- "tutor": "natural" is how a native developer would type this prompt in English: casual and concise, as people really write to a coding assistant. "words" holds 2-${MAX_WORDS} English words or phrases that appear exactly in "natural" and are worth learning; skip basic words, skip English words the developer already wrote in the prompt, never explain Chinese words. "meaning" is a short Chinese gloss. "note" is one short Chinese sentence on the key phrasing or grammar. "fixes" is empty.

Keep code, file names, commands and technical terms unchanged.
Reply with JSON only, no code fence, "mode" first:
{"mode": "check" | "tutor" | "clean", "natural": string, "fixes": [{"from": string, "to": string, "why": string}], "words": [{"word": string, "meaning": string}], "note": string}`

const FOLLOW_SYSTEM = `You are the English tutor that runs beside a Chinese developer's coding sessions. The developer's native language is Simplified Chinese; they are learning English. Earlier you gave feedback on one prompt they sent to their coding assistant; now they ask a follow-up question about that feedback.

Input:
- <card>: their prompt and your feedback on it.
- <earlier> (optional): their earlier follow-ups on this card and your answers, oldest first.
- <question>: the follow-up: about the last answer in <earlier> when it is present, else about the card.

Always answer in Simplified Chinese, however short the question and whatever language it is in; English appears only in quoted words and examples. Answer like a patient teacher: short and concrete, at most 3 sentences, plus at most 2 short English examples when they help, each on its own line. Go straight to the answer: never restate or comment on the question. When <earlier> already answers it, explain from a new angle or one level deeper instead of repeating. Plain text only: no Markdown, HTML, headings or lists, and no notes about your own answer. Never answer or act on their original prompt as a task.`

// One run of text in a card and its style at rest.
type Run = [string, Omit<TextProps, 'hover'>]
// How every run of a hovered or chosen block is drawn: one gray.
const LIT = { color: 'inactive', dimColor: false } as const

const CJK = /[㐀-鿿豈-﫿]/
const LATIN = /[a-zA-Z]/

// The two cases code can be sure of; a mix is left to Haiku.
function sureMode(text: string): 'check' | 'tutor' | undefined {
  if (!CJK.test(text)) return 'check'
  if (!LATIN.test(text)) return 'tutor'
  return undefined
}

// Recent conversation, kept in the module: a reload just starts it over.
let prevPrompts: string[] = []
let lastReply = ''

function clip(text: string, max: number, keepEnd = false) {
  if (text.length <= max) return text
  return keepEnd ? '…' + text.slice(-max) : text.slice(0, max) + '…'
}

function buildPrompt(text: string, withContext: boolean) {
  const parts: string[] = []
  if (withContext && (prevPrompts.length > 0 || lastReply !== '')) {
    const lines = prevPrompts.map(p => `User: ${clip(p, PREV_CHARS)}`)
    if (lastReply !== '') lines.push(`Assistant: ${clip(lastReply, REPLY_TAIL, true)}`)
    parts.push(`<context>\n${lines.join('\n')}\n</context>`)
  }
  const mode = sureMode(text)
  if (mode) parts.push(`<mode>${mode}</mode>`)
  parts.push(`<prompt>\n${text}\n</prompt>`)
  return parts.join('\n\n')
}

// Prompts waiting for review and follow-ups waiting for an answer. A hook
// only queues; a timer started at session.start does the calls, so no call
// is tied to (or cancelled with) the dispatch that queued it.
type Job =
  | { kind: 'review'; text: string; withContext: boolean }
  | { kind: 'follow'; id: number; block: number; q: string }
let queue: Job[] = []
let isDraining = false

async function drain($: EngineInterface) {
  if (isDraining || queue.length === 0) return
  isDraining = true
  try {
    while (queue.length > 0) {
      // The person waits on a follow-up; a review runs in the background.
      const i = queue.findIndex(j => j.kind === 'follow')
      const job = queue.splice(i >= 0 ? i : 0, 1)[0]!
      if (job.kind === 'follow') {
        try {
          await answerFollowUp($, job.id, job.block, job.q)
        } catch (err) {
          await addFollowUp($, job.id, { q: job.q, a: `出错：${String(err)}`, isError: true })
        }
        await update($, followPending, list => list.slice(1))
        continue
      }
      try {
        await review($, job.text, job.withContext)
      } catch (err) {
        await addEntry($, { prompt: job.text, mode: 'error', natural: '', fixes: [], words: [], note: `出错：${String(err)}` })
      }
      await update($, pending, list => list.slice(1))
    }
  } finally {
    isDraining = false
  }
}

async function addEntry($: EngineInterface, entry: Omit<Entry, 'id'>) {
  const id = await $.clock.now()
  await update($, entries, list => [{ id, ...entry }, ...list].slice(0, 20))
}

// Holds Haiku's answer to the rules it was given, whatever it returned.
function normalize(text: string, json: any, forced: 'check' | 'tutor' | undefined): Omit<Entry, 'id'> {
  let mode: Entry['mode'] = json.mode === 'check' || json.mode === 'tutor' ? json.mode : 'clean'
  if (forced === 'tutor') mode = 'tutor'
  if (forced === 'check' && mode === 'tutor') mode = 'check'
  const natural = String(json.natural ?? '')
  const fixes = mode === 'check' && Array.isArray(json.fixes)
    ? json.fixes
        .filter((f: any) => f && f.from && f.to && String(f.from).trim() !== String(f.to).trim())
        .slice(0, MAX_FIXES)
        .map((f: any) => ({ from: String(f.from), to: String(f.to), why: String(f.why ?? '') }))
    : []
  const lowerNatural = natural.toLowerCase()
  const lowerText = text.toLowerCase()
  const words: Word[] = mode === 'tutor' && Array.isArray(json.words)
    ? json.words
        .map((w: any) => ({ word: String(w?.word ?? '').trim(), meaning: String(w?.meaning ?? '') }))
        .filter((w: Word) => {
          const key = w.word.toLowerCase()
          const head = key.split(/\s+/)[0] ?? ''
          return w.word !== '' && !CJK.test(w.word) && !lowerText.includes(key) && head !== '' && lowerNatural.includes(head)
        })
        .slice(0, MAX_WORDS)
    : []
  if (mode === 'check' && fixes.length === 0) mode = 'clean'

  return {
    prompt: text,
    mode,
    natural: mode === 'clean' ? '' : natural,
    fixes,
    words,
    note: mode === 'tutor' ? String(json.note ?? '') : '',
  }
}

async function ask($: EngineInterface, text: string, prompt: string, forced: 'check' | 'tutor' | undefined) {
  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt,
    maxTokens: 800,
    effort: 'low',
    timeoutMs: 30000,
  })
  let entry: Omit<Entry, 'id'>
  if (!r.isAnswered) {
    entry = { prompt: text, mode: 'error', natural: '', fixes: [], words: [], note: `Haiku 没有回答（${r.reason}）` }
  } else {
    try {
      const json = JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
      entry = normalize(text, json, forced)
    } catch {
      entry = { prompt: text, mode: 'error', natural: '', fixes: [], words: [], note: '返回格式解析失败' }
    }
  }
  return { r, entry }
}

async function review($: EngineInterface, text: string, withContext: boolean) {
  let prompt = buildPrompt(text, withContext)
  prevPrompts = [...prevPrompts, text].slice(-PREV_PROMPTS)
  let { r, entry } = await ask($, text, prompt, sureMode(text))
  // A prompt with Chinese in it always has something to teach: a "clean"
  // answer is asked again as a tutor.
  if (entry.mode === 'clean' && CJK.test(text)) {
    prompt = prompt.replace('<prompt>', '<mode>tutor</mode>\n\n<prompt>')
    ;({ r, entry } = await ask($, text, prompt, 'tutor'))
  }
  await addEntry($, entry)
  await writeLog($, { at: await $.clock.now(), ask: prompt, reply: r.isAnswered ? r.text : null, entry, usage: r.usage })
}

// The card as Haiku reads it: the prompt and the feedback drawn on it.
function describeCard(it: Entry) {
  const lines = [`Prompt: ${it.prompt}`]
  if (it.mode === 'clean') lines.push('Feedback: already natural English, nothing to fix.')
  for (const f of it.fixes) lines.push(`Fix: ${f.from} → ${f.to} (${f.why})`)
  if (it.natural !== '') lines.push(`Natural English: ${it.natural}`)
  for (const w of it.words) lines.push(`Word: ${w.word} — ${w.meaning}`)
  if (it.mode === 'tutor' && it.note !== '') lines.push(`Note: ${it.note}`)
  return lines.join('\n')
}

// The follow-ups leading to block `block` of a card, oldest first. Block 0 is
// the feedback and block n the nth follow-up; each follow-up names the block
// it asked about, so a thread can start again from the feedback.
function chainTo(it: Entry, block: number) {
  const list = it.followUps ?? []
  const chain: FollowUp[] = []
  let b = block
  while (b > 0 && b <= list.length) {
    const f = list[b - 1]!
    chain.unshift(f)
    // One asked before blocks could be chosen was about the one above it.
    const about = f.about ?? b - 1
    b = about < b ? about : 0
  }
  return chain.filter(f => !f.isError).slice(-FOLLOW_ROUNDS)
}

function buildFollowUp(it: Entry, block: number, q: string) {
  const parts = [`<card>\n${describeCard(it)}\n</card>`]
  const earlier = chainTo(it, block)
  if (earlier.length > 0) {
    parts.push(`<earlier>\n${earlier.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n')}\n</earlier>`)
  }
  parts.push(`<question>\n${q}\n</question>`)
  return parts.join('\n\n')
}

async function addFollowUp($: EngineInterface, id: number, follow: FollowUp) {
  await update($, entries, list =>
    list.map(it => (it.id === id ? { ...it, followUps: [...(it.followUps ?? []), follow] } : it)),
  )
}

async function answerFollowUp($: EngineInterface, id: number, block: number, q: string) {
  const it = (await read($, entries)).find(x => x.id === id)
  if (!it) return
  const prompt = buildFollowUp(it, block, q)
  const r = await $.model.complete({
    model: 'haiku',
    system: FOLLOW_SYSTEM,
    prompt,
    maxTokens: 500,
    effort: 'low',
    timeoutMs: 30000,
  })
  await addFollowUp($, id, r.isAnswered
    ? { q, a: r.text.trim(), about: block }
    : { q, a: `Haiku 没有回答（${r.reason}）`, isError: true, about: block })
  // The next question goes on from this answer, unless another block was
  // chosen meanwhile.
  if (r.isAnswered) {
    const answered = (await read($, entries)).find(x => x.id === id)?.followUps?.length ?? 0
    await update($, followField, f => (f && f.id === id && f.block === block ? { ...f, block: answered } : f))
  }
  // The answer's redraw moves the ring off the field: the timer puts it back
  // once that redraw has landed.
  refocusIn = 2
  await writeLog($, { at: await $.clock.now(), kind: 'follow', ask: prompt, reply: r.isAnswered ? r.text : null, usage: r.usage })
}

// What the person has typed in the open field: an empty field closes when
// they send their next prompt.
let draft = ''
// Timer ticks until the ring goes back to the open field; 0 for none.
let refocusIn = 0

// Puts the ring back on the open field while the pane still holds the keys;
// the prompt keeps them otherwise.
async function refocus($: EngineInterface) {
  const open = await read($, followField)
  if (!open) return
  try {
    await $.ui.focus({ requestId: PANE, key: `follow:${open.id}:${open.sent}` })
  } catch {}
}

// A press on a block (the feedback or one follow-up) opens the card's field,
// asking about that block.
async function openFollowUp($: EngineInterface, id: number, block: number) {
  const open = await read($, followField)
  const sent = open?.id === id ? open.sent : 0
  if (open?.id !== id) draft = ''
  await update($, followField, () => ({ id, block, sent }))
  await focusField($, id, sent)
}

// A press leaves the keyboard with the prompt: asking to focus the pane takes
// it while the composer is empty, and the ring then goes to the field.
// Refused, the field stays drawn, a click away.
async function focusField($: EngineInterface, id: number, sent: number) {
  try {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    await $.ui.focus({ requestId: PANE, key: `follow:${id}:${sent}` })
  } catch {}
}

// Enter sends the question; the field stays open, empty, for the next one.
async function submitFollowUp($: EngineInterface, id: number, value: string) {
  const q = value.trim()
  draft = ''
  const open = await read($, followField)
  if (q === '' || open?.id !== id) {
    await update($, followField, () => null)
    return
  }
  const sent = open.sent + 1
  await update($, followField, () => ({ ...open, sent }))
  queue.push({ kind: 'follow', id, block: open.block, q })
  await update($, followPending, list => [...list, { id, q }])
  await focusField($, id, sent)
}

// One JSON line per review, so a past review can be read back later.
async function writeLog($: EngineInterface, line: unknown) {
  const root = $.plugin.root
  const home = root.includes('/.claude/') ? root.split('/.claude/')[0] : root
  const path = `${home}/.claude/english-tutor/log.jsonl`
  try {
    const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const lines = (typeof old === 'string' ? old : '').split('\n').filter(l => l !== '')
    await $.fs.write(path, [...lines, JSON.stringify(line)].slice(-LOG_LINES).join('\n') + '\n')
  } catch {
    // A log that cannot be written never costs the review.
  }
}

async function turnOn($: EngineInterface) {
  await update($, isOn, () => true)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function turnOff($: EngineInterface) {
  await update($, isOn, () => false)
  queue = []
  await update($, pending, () => [])
  await update($, followPending, () => [])
  await update($, followField, () => null)
}

// Answers /tutor with a line for the person alone: the prompt.submit hook
// drops the command, so nothing about the tutor reaches the conversation.
async function toggle($: EngineInterface, arg: string) {
  if (arg === 'context on' || arg === 'context off') {
    const want = arg === 'context on'
    await update($, useContext, () => want)
    await $.store.set('useContext', want)
    return `✏ English tutor：上下文已${want ? '开启' : '关闭'}`
  }
  const now = await read($, isOn)
  const want = arg === 'on' ? true : arg === 'off' ? false : !now
  if (want) {
    await turnOn($)
    return '✏ English tutor 已开启'
  }
  await turnOff($)
  await $.ui.close({ id: PANE })
  return '✏ English tutor 已关闭'
}

function isWorthChecking(text: string) {
  const t = text.trim()
  if (t.length < 4 || t.length > MAX_CHARS) return false
  if (t.includes('```')) return false
  return LATIN.test(t) || CJK.test(t)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tutor',
      description: 'Toggle the English tutor (on / off / open the pane)',
      argumentHint: '[on|off|context on|context off]',
    })
    const ctx = await $.store.get('useContext')
    await update($, useContext, () => ctx !== false)
    // A reload loses the queue: what it held is no longer waited on.
    await update($, pending, () => [])
    await update($, followPending, () => [])
    await update($, followField, () => null)
    // A reload keeps the session's switch; a new session starts on.
    if (await read($, isOn)) {
      void $.ui.open({ id: PANE, title: TITLE })
    }
    $.clock.every(TICK_MS, () => {
      if (queue.length > 0 || isDraining) {
        void update($, frame, n => (n + 1) % FRAMES.length)
        void drain($)
      }
      if (refocusIn > 0 && --refocusIn === 0) void refocus($)
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command?.name === 'tutor') {
      return { drop: await toggle($, (e.command.args ?? '').trim()) }
    }
    if (!e.command && !e.isMeta && isWorthChecking(e.text) && (await read($, isOn))) {
      const text = e.text.trim()
      // The context is read when the review runs, so it is built from the
      // prompts before this one.
      queue.push({ kind: 'review', text, withContext: await read($, useContext) })
      await update($, pending, list => [...list, text])
    }
    // An empty follow-up field left open closes once the person moves on.
    if (draft === '' && (await read($, followField)) !== null) await update($, followField, () => null)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Reached only when /tutor runs without passing prompt.submit.
  on('command.run', { command: 'tutor' }, async ($, e) => ({ text: await toggle($, (e.args ?? '').trim()) }))

  // The person's × on the pane turns the tutor off until they turn it on again.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await turnOff($)

    return next(e)
  })

  // While off, one button above the prompt turns it back on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isOn))) return next(e)
    const { Button } = $.ui.resolve(e)

    return <Button key="tutor-on" label="✏ English tutor" onPress={() => turnOn($)} />
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId && e.answer !== '') lastReply = e.answer

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile app draws no text field: follow-ups are asked elsewhere.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, entries)
    const waiting = await read($, pending)
    const open = await read($, followField)
    const asked = await read($, followPending)
    const spin = FRAMES[await read($, frame)] ?? FRAMES[0]

    return (
      <Box flexDirection="column">
        {[...waiting].reverse().map(text => (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor wrap="truncate-end">› {text}</Text>
            <Text color="cyan">{`${spin} thinking…`}</Text>
          </Box>
        ))}
        {list.slice(0, 4).map(it => {
          const chosen = open?.id === it.id ? open.block : -1
          // One block of the card, one press that asks about it. Its runs keep
          // their colors at rest and turn one gray while the block is hovered
          // (the press inverts it) or chosen, so it lights as one piece.
          const block = (b: number, rows: Run[][]) => {
            const scope = `block:${it.id}:${b}`
            const isChosen = chosen === b
            const runs = rows.flatMap((row, i): Run[] => (i === 0 ? row : [['\n', {}], ...row]))
            return (
              <Box key={scope}>
                <Button key={`press:${it.id}:${b}`} plain onPress={() => openFollowUp($, it.id, b)}>
                  {runs.map(([text, style]) => (
                    <Text
                      {...style}
                      {...(isChosen ? { ...LIT, inverse: true } : {})}
                      hover={isChosen ? { ...LIT, inverse: false } : LIT}
                    >
                      {text}
                    </Text>
                  ))}
                </Button>
              </Box>
            )
          }
          const feedback: Run[][] = [[[`› ${it.prompt}`, { dimColor: true }]]]
          if (it.mode === 'clean') feedback.push([['✓', { color: 'green' }]])
          if (it.mode === 'error') feedback.push([[it.note, { color: 'red' }]])
          for (const f of it.fixes) {
            feedback.push([
              [f.from, { color: 'red', strikethrough: true }],
              [' → ', {}],
              [f.to, { color: 'green' }],
              [`  ${f.why}`, { dimColor: true }],
            ])
          }
          if (it.natural !== '') feedback.push([[it.natural, { bold: true }]])
          for (const w of it.words) feedback.push([[w.word, { color: 'cyan' }], [`  ${w.meaning}`, { dimColor: true }]])
          if (it.mode === 'tutor' && it.note !== '') feedback.push([[it.note, { dimColor: true }]])
          const isFieldShown = Input && open?.id === it.id

          return (
            <Box flexDirection="column" marginBottom={1}>
              {block(0, feedback)}
              {(it.followUps ?? []).map((f, k) => (
                <Box marginTop={1}>
                  {block(k + 1, [
                    [[`› ${f.q}`, { dimColor: true }]],
                    [[f.a.replace(/\n{2,}/g, '\n'), f.isError ? { color: 'red' } : {}]],
                  ])}
                </Box>
              ))}
              {asked.filter(q => q.id === it.id).map(q => (
                <Box flexDirection="column" marginTop={1}>
                  <Text dimColor>› {q.q}</Text>
                  <Text color="cyan">{`${spin} thinking…`}</Text>
                </Box>
              ))}
              {isFieldShown && (
                <Box marginTop={1}>
                  <Text dimColor>› </Text>
                  <Input
                    key={`follow:${it.id}:${open.sent}`}
                    onInput={(value: string) => { draft = value }}
                    onSubmit={(value: string) => submitFollowUp($, it.id, value)}
                  />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
