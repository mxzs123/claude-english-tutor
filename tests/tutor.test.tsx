import { expect, test } from 'claude-code/testing'

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
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } },
} as const

const REPLY = JSON.stringify({
  mode: 'check',
  natural: 'When the agent answers me, I want to translate it.',
  fixes: [{ from: 'anwser', to: 'answers', why: '拼写错误，且主语第三人称单数' }],
  words: [],
  note: '',
})

const FOLLOW_REPLY = 'it 是形式主语，指前面说的那件事。\nI want to translate it.'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
// Waits for the queue the plugin's timer drains, a few seconds at most.
async function until(check: () => boolean) {
  for (let i = 0; i < 60 && !check(); i++) await wait(50)
}

function stub(on: any) {
  const sent: string[] = []
  const store = new Map<string, unknown>()
  const opened: string[] = []
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'tutor' } }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Stands for the engine's own (empty) band.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', async (_, e) => {
    sent.push(e.prompt)
    const text = String(e.system).includes('follow-up') ? FOLLOW_REPLY : REPLY
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })

  return { sent, opened }
}

test('on from the start: reviews with bounded context', async ($, on) => {
  const { sent, opened } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['english-tutor'])

  await $.turn.complete({ answer: 'x'.repeat(5000) + 'END', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.prompt.submit({ text: '我想重构这个函数' })
  await $.prompt.submit({ text: 'when agent anwser me, I want translate it' })
  await wait(2000)

  const done = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: /thinking/ })).toBeUndefined()
  await done.unmount()

  expect(sent.length).toBe(2)
  const last = sent[1]!
  expect(last).toContain('<mode>check</mode>')
  expect(last).toContain('User: 我想重构这个函数')
  expect(last).toContain('END')
  expect(sent[0]).toContain('<mode>tutor</mode>')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  await $.prompt.submit({ text: '/tutor off', command: { name: 'tutor', args: 'off' } })
  await $.prompt.submit({ text: 'this one is not reviewed' })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'tutor-on' })
  await band.unmount()
  expect(opened.length).toBe(2)

  await $.prompt.submit({ text: 'and this one is reviewed' })
  await wait(2000)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('and this one is reviewed')
})

test('/tutor never reaches the conversation', async ($, on) => {
  const ran: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('command.run', (_, e) => { ran.push(e.command); return { text: '' } })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const r = await $.prompt.submit({ text: '/tutor off', command: { name: 'tutor', args: 'off' } })
  expect(r.drop).toContain('已关闭')
  expect(ran.length).toBe(0)
})

test('each block of a card asks about itself: a thread goes on, or starts again from the feedback', async ($, on) => {
  const { sent } = stub(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'x'.repeat(5000) + 'END', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.prompt.submit({ text: 'when agent anwser me, I want translate it' })
  await until(() => sent.length === 1)

  // Unfocused, as the pane is when the person's click lands.
  const at = { ...PANE, surface: 'terminal' } as const
  let pane = await $.ui.mount(at)
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
  pane = await $.ui.mount(at)
  expect(await pane.findAll({ type: 'Button' })).toHaveLength(2)
  expect((await pane.find({ type: 'Button', key: 'press:1:1' }))?.text).toContain('it 是形式主语')
  expect((await pane.find({ type: 'Input' }))?.key).toBe('follow:1:1')
  await pane.input({ key: 'follow:1:1', text: '为什么' })
  await pane.unmount()
  await until(() => sent.length === 3)
  expect(sent[2]).toContain('<earlier>\nQ: 这里 it 指什么\nA: it 是形式主语')

  // Choosing the feedback again asks about it alone.
  pane = await $.ui.mount(at)
  await pane.press({ key: 'press:1:0' })
  await pane.input({ key: 'follow:1:2', text: 'translate 还能换成什么' })
  await pane.unmount()
  await until(() => sent.length === 4)
  expect(sent[3]).toContain('<question>\ntranslate 还能换成什么\n</question>')
  expect(sent[3]).not.toContain('<earlier>')

  // The next prompt closes the empty field.
  await $.prompt.submit({ text: 'ok thanks' })
  pane = await $.ui.mount(at)
  expect(await pane.find({ type: 'Input' })).toBeUndefined()
  await pane.unmount()
})
