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

function stub(on: On, reply: (prompt: string) => string = () => REPLY) {
  const sent: string[] = []
  const store = new Map<string, unknown>()
  const opened: string[] = []
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
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
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

  return { sent, opened, surface }
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
  expect((await pane.find({ type: 'Text', text: /When the agent answers me/ }))?.text).toContain('translate')
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
  const fix = await pane.find({ type: 'Text', text: /^really $/ })
  expect(fix?.props.strikethrough).toBe(true)
  expect(await pane.find({ type: 'Text', text: '✓' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /没有给出英文说法/ })).toBeDefined()
  await pane.unmount()
})

test('an undrawn pane reviews nothing, and /tutor shows it', async ($, on) => {
  const { sent, opened, surface } = stub(on)
  surface.isWide = false
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('nobody can see this review'))

  let band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button', key: 'tutor-on' })).toBeDefined()
  await band.unmount()

  const r = await $.prompt.submit(command('tutor', ''))
  expect('drop' in r && r.drop).toContain('已开启')
  expect(opened.length).toBe(2)
  band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button', key: 'tutor-on' })).toBeUndefined()
  await band.unmount()

  await $.prompt.submit(typed('now this one is seen'))
  await until(() => sent.length === 1)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('now this one is seen')
})

test('each block of a card asks about itself: a thread goes on, or starts again from the feedback', async ($, on) => {
  const { sent } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'x'.repeat(5000) + 'END', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.prompt.submit(typed('when agent anwser me, I want translate it'))
  await until(() => sent.length === 1)

  // Unfocused, as the pane is when the person's click lands.
  let pane = await $.ui.mount(AT)
  expect(await pane.findAll({ type: 'Button' })).toHaveLength(1)
  await pane.press({ key: 'press:1:0' })
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
  expect(await pane.findAll({ type: 'Button' })).toHaveLength(2)
  expect((await pane.find({ type: 'Button', key: 'press:1:1' }))?.text).toContain('it 是形式主语')
  expect((await pane.find({ type: 'Input' }))?.key).toBe('follow:1:1')
  await pane.input({ key: 'follow:1:1', text: '为什么' })
  await pane.unmount()
  await until(() => sent.length === 3)
  expect(sent[2]).toContain('<earlier>\nQ: 这里 it 指什么\nA: it 是形式主语')

  // Choosing the feedback again asks about it alone.
  pane = await $.ui.mount(AT)
  await pane.press({ key: 'press:1:0' })
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
