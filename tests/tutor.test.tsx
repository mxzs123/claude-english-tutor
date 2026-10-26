import { expect, test } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

// The test runtime has timers; the module's typings, written for hooks, do not.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const PANE = {
  plugin: 'english-tutor',
  component: 'Pane',
  requestId: 'english-tutor',
  props: {
    title: 'English tutor',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'english-tutor',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const REPLY = JSON.stringify({
  mode: 'check',
  natural: 'When the agent answers me, I want to translate it.',
  fixes: [{ from: 'anwser', to: 'answers', why: '拼写错误，且主语第三人称单数' }],
  words: [],
  note: '',
})

const FOLLOW_REPLY = 'it 是形式主语，指前面说的那件事。\nI want to translate it.'

const wait = (ms: number) => new Promise(r => setTimeout(() => r(undefined), ms))
// Waits for the queue the plugin's timer drains, a few seconds at most.
async function until(check: () => boolean) {
  for (let i = 0; i < 60 && !check(); i++) await wait(50)
}

// A prompt as the person sends it at the terminal, or from elsewhere.
function typed(text: string, origin: PromptOrigin['kind'] = 'composer') {
  return { text, wait: false, origin: { kind: origin } as PromptOrigin }
}
function command(name: string, args: string) {
  return { ...typed(`/${name} ${args}`), command: { name, args } }
}

const AT = { ...PANE, surface: 'terminal' } as const

// The pane's text as drawn, its presses joined line by line.
const shown = (buttons: readonly { text: string }[]) => buttons.map(b => b.text).join('')

function stub(on: On, reply: (prompt: string) => string = () => REPLY) {
  const sent: string[] = []
  const store = new Map<string, unknown>()
  const opened: string[] = []
  const runs: string[][] = []
  const played: string[] = []
  // Whether the surface draws the pane: an unasked open on a narrow terminal
  // waits undrawn, one the person asked for is drawn.
  const surface = { isWide: true }
  let isPaneDrawn = false
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: 'QUJD' } }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('audio.play', (_, e) => {
    if (e.clip.base64 !== undefined) played.push(e.clip.base64)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'tutor' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    isPaneDrawn = surface.isWide || opened.length > 1
    return { value: isPaneDrawn ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.panes', () => ({
    value: [{ id: 'english-tutor', title: 'English tutor', isShown: isPaneDrawn, isFocused: false, isPlaced: isPaneDrawn }],
  }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  // Stands for the engine's own (empty) band.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', async (_, e) => {
    sent.push(e.prompt)
    const text = String(e.system).includes('follow-up') ? FOLLOW_REPLY : reply(e.prompt)
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })

  return { sent, opened, surface, runs, played }
}

test('on from the start: reviews with bounded context', async ($, on) => {
  const { sent, opened } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['english-tutor'])

  await $.turn.complete({ answer: 'x'.repeat(5000) + 'END', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.prompt.submit(typed('我想重构这个函数'))
  await $.prompt.submit(typed('when agent anwser me, I want translate it'))
  await until(() => sent.length === 2)

  const done = await $.ui.mount(AT)
  expect(await done.find({ type: 'Text', text: /thinking/ })).toBeUndefined()
  await done.unmount()

  const last = sent[1]!
  expect(last).toContain('<mode>check</mode>')
  expect(last).toContain('User: 我想重构这个函数')
  expect(last).toContain('END')
  expect(sent[0]).toContain('<mode>tutor</mode>')

  const pane = await $.ui.mount(AT)
  expect(shown(await pane.findAll({ type: 'Button' }))).toContain('When the agent answers me, I want to translate it.')
  await pane.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button' })).toBeUndefined()
  await band.unmount()
})

test('off reviews nothing; the band button turns it back on', async ($, on) => {
  const { sent, opened } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // The test kit cannot raise the person's ×; /tutor off turns off the same way.
  await $.prompt.submit(command('tutor', 'off'))
  await $.prompt.submit(typed('this one is not reviewed'))

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // What else the band holds stays drawn under the button.
  expect(await band.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await band.press({ key: 'tutor-on' })
  await band.unmount()
  expect(opened.length).toBe(2)

  await $.prompt.submit(typed('and this one is reviewed'))
  await until(() => sent.length === 1)
  await wait(200)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('and this one is reviewed')
})

test('/tutor never reaches the conversation', async ($, on) => {
  const ran: string[] = []
  stub(on)
  on('command.run', (_, e) => { ran.push(e.command); return { text: '' } })

  const r = await $.prompt.submit(command('tutor', 'off'))
  expect('drop' in r && r.drop).toContain('已关闭')
  expect(ran.length).toBe(0)
})

test('only what the person typed is reviewed; /clear drops the old context', async ($, on) => {
  const { sent } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('a loop prompt nobody typed', 'scheduled-trigger'))
  await $.prompt.submit(typed('a notification from a task', 'task-notification'))
  await $.prompt.submit(typed('a script run through the sdk', 'sdk'))
  await $.prompt.submit(typed('the old conversation prompt'))
  await $.turn.complete({ answer: 'OLD REPLY', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await until(() => sent.length === 1)
  expect(sent[0]).toContain('the old conversation prompt')

  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  await $.prompt.submit(typed('a fresh start after clear'))
  await until(() => sent.length === 2)
  await wait(200)
  expect(sent.length).toBe(2)
  expect(sent[1]).not.toContain('<context>')
})

test('what the person types in a question dialog is reviewed, the options are not', async ($, on) => {
  const { sent } = stub(on)
  const answers: Record<string, string> = {}
  on('tool.call', (_, e) => ({
    result: { questions: e.tool === 'AskUserQuestion' ? e.questions : [], answers, annotations: { Which: { notes: '先别动 billing 那个' } } },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ask = (questions: { question: string; labels: string[]; multiSelect?: boolean }[]) =>
    $.tool.call({
      tool: 'AskUserQuestion',
      questions: questions.map(q => ({
        question: q.question,
        header: 'Trash',
        options: q.labels.map(label => ({ label, description: '' })),
        multiSelect: q.multiSelect ?? false,
      })),
    })

  answers['What should I delete?'] = 'what else left under trash?'
  answers['Which'] = 'Only the skill'
  answers['Also?'] = 'Empty all, Keep pdfs, and keep the billing folder'
  await ask([
    { question: 'What should I delete?', labels: ['Only the skill', 'Empty everything'] },
    { question: 'Which', labels: ['Only the skill', 'Empty everything'] },
    { question: 'Also?', labels: ['Empty all', 'Keep pdfs'], multiSelect: true },
  ])
  await until(() => sent.length === 3)
  await wait(200)
  expect(sent.length).toBe(3)
  expect(sent[0]).toContain('<prompt>\nwhat else left under trash?\n</prompt>')
  // The question is the context the answer is read in.
  expect(sent[0]).toContain('Assistant: What should I delete?')
  expect(sent[1]).toContain('<prompt>\n先别动 billing 那个\n</prompt>')
  expect(sent[2]).toContain('<prompt>\nand keep the billing folder\n</prompt>')
  expect(sent.join('')).not.toContain('<prompt>\nOnly the skill')
})

test('a deletion is a fix, and a tutor answer with no English is said', async ($, on) => {
  const { sent } = stub(on, prompt =>
    prompt.split('<prompt>')[1]!.includes('really')
      ? JSON.stringify({ mode: 'check', natural: 'please fix it', fixes: [{ from: 'really ', to: '', why: '多余的词' }], words: [], note: '' })
      : JSON.stringify({ mode: 'clean', natural: '', fixes: [], words: [], note: '' }),
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('please really fix it'))
  await $.prompt.submit(typed('帮我看看这个'))
  await until(() => sent.length === 2)
  await wait(200)

  const pane = await $.ui.mount(AT)
  // The prompt line draws it too; the fix's is struck through.
  const fix = (await pane.findAll({ type: 'Text', text: 'really' })).find(t => t.props.strikethrough)
  expect(fix?.props.color).toBe('red')
  expect(await pane.find({ type: 'Text', text: '✓' })).toBeUndefined()
  expect(shown(await pane.findAll({ type: 'Button' }))).toContain('没有给出英文说法')
  await pane.unmount()
})

test('an undrawn pane still reviews, and /tutor shows it', async ($, on) => {
  const { sent, opened, surface } = stub(on)
  surface.isWide = false
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('reviewed before the pane is seen'))
  await until(() => sent.length === 1)
  expect(sent[0]).toContain('reviewed before the pane is seen')

  let band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button', key: 'tutor-on' })).toBeDefined()
  await band.unmount()

  const r = await $.prompt.submit(command('tutor', ''))
  expect('drop' in r && r.drop).toContain('已开启')
  expect(opened.length).toBe(2)
  band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button', key: 'tutor-on' })).toBeUndefined()
  await band.unmount()

  const pane = await $.ui.mount(AT)
  expect(shown(await pane.findAll({ type: 'Button' }))).toContain('reviewed before the pane is seen')
  await pane.unmount()
})

test('a long paste is left out and the words typed around it are reviewed', async ($, on) => {
  const { sent } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const spec = '::CHECK{typography|standard:award_tier}\n'.repeat(20)
  await $.prompt.submit(typed(`\n\n<pasted_content id="dd40">\n${spec}</pasted_content id="dd40">\n\n\n设计TOMATO的管理页面`))
  // A short paste, as voice typing leaves one, is the person's own words.
  await $.prompt.submit(typed('试试吧，<pasted_content id="dd40">\n我希望它好开关\n</pasted_content id="dd40">'))
  await until(() => sent.length === 2)

  expect(sent[0]).toContain('<prompt>\n设计TOMATO的管理页面\n</prompt>')
  expect(sent[0]).not.toContain('CHECK')
  expect(sent[1]).toContain('试试吧，\n我希望它好开关')
  expect(sent[1]).not.toContain('pasted_content')
})

test('two characters of Chinese are reviewed, two of English are not', async ($, on) => {
  const { sent } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('hi'))
  await $.prompt.submit(typed('好'))
  await $.prompt.submit(typed('可以'))
  await until(() => sent.length === 1)
  await wait(200)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('<prompt>\n可以\n</prompt>')
})

test('each block of a card asks about itself: a thread goes on, or starts again from the feedback', async ($, on) => {
  const { sent } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'x'.repeat(5000) + 'END', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.prompt.submit(typed('when agent anwser me, I want translate it'))
  await until(() => sent.length === 1)

  // Unfocused, as the pane is when the person's click lands. A press beside
  // the words of the feedback asks about it.
  let pane = await $.ui.mount(AT)
  expect(await pane.find({ type: 'Button', key: 'ask:1:1:0:0' })).toBeUndefined()
  await pane.press({ key: 'ask:1:0:0:0' })
  expect((await pane.find({ type: 'Input' }))?.key).toBe('follow:1:0')
  await pane.input({ key: 'follow:1:0', text: '这里 it 指什么' })
  await pane.unmount()
  await until(() => sent.length === 2)
  expect(sent[1]).toContain('Natural English: When the agent answers me, I want to translate it.')
  expect(sent[1]).toContain('<question>\n这里 it 指什么\n</question>')
  expect(sent[1]).not.toContain('END')
  expect(sent[1]).not.toContain('<earlier>')

  // The answer is a block of its own, chosen for the next question.
  pane = await $.ui.mount(AT)
  expect(shown(await pane.findAll({ type: 'Button' }))).toContain('it 是形式主语，指前面说的那件事。')
  expect((await pane.find({ type: 'Input' }))?.key).toBe('follow:1:1')
  await pane.input({ key: 'follow:1:1', text: '为什么' })
  await pane.unmount()
  await until(() => sent.length === 3)
  expect(sent[2]).toContain('<earlier>\nQ: 这里 it 指什么\nA: it 是形式主语')

  // Choosing the feedback again asks about it alone.
  pane = await $.ui.mount(AT)
  await pane.press({ key: 'ask:1:0:0:0' })
  await pane.input({ key: 'follow:1:2', text: 'translate 还能换成什么' })
  await pane.unmount()
  await until(() => sent.length === 4)
  expect(sent[3]).toContain('<question>\ntranslate 还能换成什么\n</question>')
  expect(sent[3]).not.toContain('<earlier>')

  // A notification leaves the empty field open; the person's next prompt closes it.
  await $.prompt.submit(typed('a task finished', 'task-notification'))
  pane = await $.ui.mount(AT)
  expect(await pane.find({ type: 'Input' })).toBeDefined()
  await pane.unmount()
  await $.prompt.submit(typed('ok thanks'))
  pane = await $.ui.mount(AT)
  expect(await pane.find({ type: 'Input' })).toBeUndefined()
  await pane.unmount()
})

test('/tutor and its reply are blanked in what the model reads', async ($, on) => {
  stub(on)
  const row = (text: string, uuid: string) => ({
    message: { type: 'system' as const, name: 'local_command', role: 'user' as const, content: [{ type: 'text' as const, text }] },
    door: 'command' as const,
    origin: { kind: 'engine' as const },
    uuid,
  })
  const blank = { type: 'text', text: '<local-command-stdout></local-command-stdout>' }

  const asked = await $.session.append(row('<command-name>/tutor</command-name>\n<command-args>off</command-args>', 'a'))
  expect(asked.message?.content).toEqual([blank])
  const answered = await $.session.append(row('<local-command-stdout>english-tutor: ✏ English tutor 已关闭</local-command-stdout>', 'b'))
  expect(answered.message?.content).toEqual([blank])
  // Every other command is kept as it is.
  const other = await $.session.append(row('<command-name>/effort</command-name>', 'c'))
  expect(other.message?.content).toEqual([{ type: 'text', text: '<command-name>/effort</command-name>' }])
})

test('a press on an English word speaks it, a phrase to learn whole, each fetched once', async ($, on) => {
  const { sent, runs, played } = stub(on, () =>
    JSON.stringify({ mode: 'tutor', natural: "How's it going?", fixes: [], words: [{ word: "How's it going", meaning: '问近况' }], note: '' }),
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('怎么样了'))
  await until(() => sent.length === 1)

  const pane = await $.ui.mount(AT)
  const going = await pane.find({ type: 'Button', text: 'going' })
  expect(going?.key).toMatch(/^say:/)
  await pane.press({ key: going!.key! })
  await until(() => played.length === 1)
  const fetch = runs.find(argv => argv.includes('--text'))!
  expect(fetch.slice(0, 3)).toEqual(['uvx', '--quiet', 'edge-tts'])
  expect(fetch).toContain('en-US-AndrewMultilingualNeural')
  expect(fetch[fetch.indexOf('--text') + 1]).toBe('going')

  await pane.press({ key: (await pane.find({ type: 'Button', text: "How's it going" }))!.key! })
  await until(() => played.length === 2)
  const phrase = runs.filter(argv => argv.includes('--text')).pop()!
  expect(phrase[phrase.indexOf('--text') + 1]).toBe("How's it going")
  // No press on the words asks about the card.
  expect(await pane.find({ type: 'Input' })).toBeUndefined()
  await pane.unmount()
})

test('lines wrap at the pane width with every word kept whole and each other character a press', async ($, on) => {
  const natural = 'Please move the user settings into the settings folder and then rename it.'
  const { sent } = stub(on, () => JSON.stringify({ mode: 'tutor', natural, fixes: [], words: [], note: '把设置移到设置文件夹里' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('把用户设置挪到 settings 文件夹然后改名'))
  await until(() => sent.length === 1)

  const pane = await $.ui.mount({ ...AT, props: { ...AT.props, bodyColumns: 20 } })
  const words = (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('say:1:0:'))
  // Each word of the sentence is one press, on the line it is drawn on.
  expect(words.map(b => b.text).filter(t => t !== 'settings').slice(0, 5)).toEqual(['Please', 'move', 'the', 'user', 'into'])
  const lineOf = (text: string) => Number(words.find(b => b.text === text)!.key!.split(':')[3])
  expect(lineOf('Please')).toBe(lineOf('user'))
  expect(lineOf('rename')).toBeGreaterThan(lineOf('folder'))
  // The Chinese note wraps by its two-cell characters: 11 of them, 20 cells a line.
  // Each other character is a press of its own.
  const between = (await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('ask:1:0:'))
  expect(between.every(b => Array.from(b.text).length === 1)).toBe(true)
  const note = between.slice(-11)
  expect(note.map(b => b.text).join('')).toBe('把设置移到设置文件夹里')
  const lines = note.map(b => Number(b.key!.split(':')[3]))
  expect(new Set(lines.slice(0, 10)).size).toBe(1)
  expect(lines[10]).toBe(lines[0]! + 1)
  await pane.unmount()
})
