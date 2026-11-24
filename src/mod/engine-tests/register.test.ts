// @ts-nocheck
// The engine-level test of the hooks module, run by `claude plugin test` (see
// `scripts/test-mod-engine.mjs`). It is not part of `npm test` or the type check: the kit it
// imports is the engine's own, which this repository does not carry. The controller's rules are
// covered in `test/home-dispatch-mod-core.test.ts`; this proves the adapter wires them to the
// engine's `$`: the session starts, the daemon is reached over `$.http`, the pane is opened, and
// the glance layer draws.
import { expect, mock, test } from 'claude-code/testing'

const HEALTH = (on) => JSON.stringify({ ok: true, service: 'mission-control', version: '2.3.0', capabilities: on ? ['home-dispatch-v1'] : [] })
const registration = (minModApi, n = 0) => JSON.stringify({
  sessionId: 's1', repoRoot: '/repo' + n, created: true, offerLauncher: false,
  counts: { running: 0, waiting: 1 }, daemonVersion: '2.3.0', minModApi, dashboardUrl: 'http://127.0.0.1:7317/',
  banner: ['◆ Mission Control   ● Claude Code', 'Dispatch, check on and answer tasks without leaving this session', '0 running | 1 waiting on you | /mission-dispatch opens the menu'],
})
const INBOX = JSON.stringify({
  items: [{ taskId: 'mc-1', title: 'logging cleanup', kind: 'ship', state: 'waiting', origin: 'home-session', changedAt: 1, canMessage: true, agent: 'claude', runtime: 'sdk',
    pending: { reviewId: 'r1', kind: 'question', question: 'Keep?', allowsText: true, dashboardOnly: false } }],
  needsYou: ['mc-1'], counts: { waiting: 1, blocked: 0, ready: 0, running: 0, queued: 0, shelved: 0, failed: 0 }, slots: { used: 1, ceiling: 4 }, dashboardOnly: 0,
})

function world(on, { flag, minModApi = 1 }) {
  const seen = { registrations: 0, inbox: INBOX, flag, posts: [], urls: [], opened: [], closed: [], order: [], openArgs: [], toasts: [], statuses: [], state: {} }
  // A token file, so every daemon call reads it through `$.fs.read` (a test can hold that read).
  mock.env(on, { MISSION_API_TOKEN_FILE: '/tmp/mission-token' })
  seen.clock = mock.clock(on)
  on('session.id', () => ({ value: seen.ids?.shift() ?? 's1' }))
  on('fs.read', async () => { if (seen.holdRead) await seen.holdRead; return { value: 'a-token' } })
  on('http.fetch', async (_, e) => {
    seen.urls.push(e.url)
    if (seen.holdFirstSessionsReply && e.url.endsWith('/dispatch/sessions') && !seen.heldOnce) { seen.heldOnce = true; await seen.holdFirstSessionsReply }
    if (e.url.endsWith('/dispatch/answers')) {
      const body = JSON.parse(e.init.body)
      seen.posts.push(body)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ reviewId: body.reviewId, taskId: body.taskId, sent: body.option ?? body.text, at: 1 }) } }
    }
    const sent = e.init?.body ? JSON.parse(e.init.body) : null
    if (sent) (seen.bodies ??= []).push({ url: e.url, body: sent })
    const text = seen.reply?.(e.url, sent) ?? (e.url.endsWith('/api/health') ? HEALTH(seen.flag) : e.url.endsWith('/dispatch/sessions') ? registration(minModApi, ++seen.registrations) : seen.inbox)
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('state.get', (_, e) => ({ value: { value: seen.state[e.key], version: 1 } }))
  on('state.set', async (_, e) => { (seen.setKeys ??= []).push(e.key); if (seen.holdSetKey === e.key && seen.holdSet) { const hold = seen.holdSet; seen.holdSet = null; await hold } seen.state[e.key] = e.value; return { value: { isSet: true, version: 2 } } })
  on('ui.open', async (_, e) => { if (seen.failOpen) throw new Error('the engine refused the open'); seen.order.push('open'); seen.opened.push(e.id); seen.openArgs.push(e); if (seen.holdOpen) { const hold = seen.holdOpen; seen.holdOpen = null; await hold }; if (seen.holdOpens?.length) await seen.holdOpens.shift(); if (seen.holdFirstOpen && seen.opened.length === 1) await seen.holdFirstOpen; return { value: { isPlaced: true } } })
  on('ui.close', async (_, e) => { seen.order.push('close:start'); seen.closed.push(e.id); if (seen.holdClose) await seen.holdClose; seen.order.push('close:end'); return { value: undefined } })
  on('ui.toast', (_, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.status', (_, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId ?? 's1' }))
  return seen
}

// The session's start hook does not wait for the daemon, so the test waits until `done()` or 2 s.
async function settle(done) {
  for (let i = 0; i < 40 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
}

const PANE = { plugin: 'mission-control', component: 'Pane', requestId: 'mission', props: { title: 'Mission Control', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }, surface: 'terminal' }
const ABOVE = { plugin: 'mission-control', component: 'AbovePrompt', requestId: 'above', props: { hasSurvey: false }, surface: 'terminal' }

test('flag on: registers, opens the pane, and draws the banner and the band with its 1 button', async ($, on) => {
  const seen = world(on, { flag: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  expect(seen.urls.some((u) => u.endsWith('/dispatch/sessions'))).toBe(true)
  expect(seen.urls.every((u) => u.includes('/api/health') || u.includes('/dispatch/'))).toBe(true)
  expect(seen.opened).toEqual(['mission'])
  expect(seen.statuses.at(-1)).toMatch(/logging cleanup needs you/)

  // A survey owns the band's place: neither the banner nor the band draws over it.
  const surveyed = await $.ui.mount({ ...ABOVE, requestId: 'survey', props: { hasSurvey: true } })
  expect(await surveyed.find({ type: 'Text', text: /Dispatch, check on/ })).toBe(undefined)
  expect(await surveyed.find({ type: 'Button', key: 'open-needs-you' })).toBe(undefined)
  await surveyed.unmount()
  const ui = await $.ui.mount(ABOVE)
  expect((await ui.find({ type: 'Text', text: /Mission Control   / }))?.text).toBe('◆ Mission Control   ● Claude Code')
  const button = await ui.find({ type: 'Button', key: 'open-needs-you' })
  expect(button).toBeTruthy()
  // Pressing the rendered button reopens the pane on Needs you, with focus.
  const pane = await $.ui.mount(PANE)
  // The pane draws the two tabs, Needs you first, with the one waiting item open.
  expect(await pane.find({ type: 'Button', key: 'tab-n Needs you' })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'tab-t Tasks' })).toBeTruthy()
  expect((await pane.find({ type: 'Text', text: /Keep\?/ }))?.text).toBe('Keep?')
  await pane.unmount()
  await ui.press({ key: 'open-needs-you' })
  await settle(() => seen.openArgs.length >= 2)
  expect(seen.openArgs.at(-1).focus).toBe(true)
  expect(seen.state.paneTab).toBe('needs-you')
  await ui.unmount()
})

test('the pane answers through the engine: Tasks tab, then an option press posts the answer', async ($, on) => {
  const seen = world(on, { flag: true })
  seen.inbox = JSON.stringify({ ...JSON.parse(INBOX), items: [{ ...JSON.parse(INBOX).items[0], pending: { reviewId: 'r1', kind: 'question', question: 'Keep?', options: ['Keep', 'Drop'], allowsText: true, dashboardOnly: false } }] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const inline = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns: 100 } })
  expect(await inline.find({ type: 'Input', key: 'answer-text' })).toBeTruthy()
  await inline.press({ key: 'action-2 Drop' })
  await settle(() => seen.posts.length > 0)
  expect(seen.posts).toEqual([{ action: 'answer', sessionId: 's1', cwd: '/repo', taskId: 'mc-1', reviewId: 'r1', option: 'Drop' }])
  await inline.unmount()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'tab-t Tasks' })
  await pane.unmount()
  const again = await $.ui.mount(PANE)
  expect(await again.find({ type: 'Text', text: /Tasks · / })).toBeTruthy()
  await again.unmount()
})

test('the pane carries typed text through the engine Input to the answer', async ($, on) => {
  const seen = world(on, { flag: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const pane = await $.ui.mount(PANE)
  await pane.input({ key: 'answer-text', text: 'Keep it, but trim', kind: 'change' })
  await pane.input({ key: 'answer-text', text: 'Keep it, but trim' })
  await settle(() => seen.posts.length > 0)
  expect(seen.posts).toEqual([{ action: 'answer', sessionId: 's1', cwd: '/repo', taskId: 'mc-1', reviewId: 'r1', text: 'Keep it, but trim' }])
  await pane.unmount()
})

test('flag off: nothing is opened, drawn or toasted', async ($, on) => {
  const seen = world(on, { flag: false })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.urls.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(seen.opened).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.statuses).toEqual([])
  expect(seen.urls.every((u) => u.endsWith('/api/health'))).toBe(true)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Button', key: 'tab-n Needs you' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /Needs you ·/ })).toBe(undefined)
  await pane.unmount()
  const ui = await $.ui.mount(ABOVE)
  expect(await ui.find({ type: 'Text', text: /Dispatch, check on/ })).toBe(undefined)
  await ui.unmount()
})

test('modApi mismatch: the daemon is not polled and the pane and band draw nothing', async ($, on) => {
  const seen = world(on, { flag: true, minModApi: 99 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.urls.some((u) => u.endsWith('/dispatch/sessions')))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(seen.urls.some((u) => u.includes('/dispatch/inbox'))).toBe(false)
  expect(seen.opened).toEqual([])
  expect(seen.statuses).toEqual([])
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Button', key: 'tab-n Needs you' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /Needs you ·/ })).toBe(undefined)
  await pane.unmount()
  const ui = await $.ui.mount(ABOVE)
  expect(await ui.find({ type: 'Text', text: /Dispatch, check on/ })).toBe(undefined)
  await ui.unmount()
})

test('session end stops the scheduled inbox poll', async ($, on) => {
  const seen = world(on, { flag: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const inboxRequests = () => seen.urls.filter((u) => u.includes('/dispatch/inbox')).length
  const first = inboxRequests()
  // While the session runs, the clock's period polls again.
  await seen.clock.advance(5000)
  await settle(() => inboxRequests() > first)
  expect(inboxRequests()).toBeGreaterThan(first)

  await $.session.end({ reason: 'other', sessionId: 's1' })
  const after = inboxRequests()
  await seen.clock.advance(15000)
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(inboxRequests()).toBe(after)
})

test('a new session starts clean: the last session\'s banner and band do not show when the flag is off', async ($, on) => {
  const seen = world(on, { flag: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const before = await $.ui.mount(ABOVE)
  expect((await before.find({ type: 'Text', text: /Mission Control   / }))?.text).toBe('◆ Mission Control   ● Claude Code')
  await before.unmount()

  expect(seen.opened).toEqual(['mission'])
  seen.flag = false
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise((resolve) => setTimeout(resolve, 150))
  // The old session's pane is closed at the boundary, and the flag-off session opens none.
  expect(seen.closed).toEqual(['mission'])
  expect(seen.opened).toEqual(['mission'])
  expect(seen.statuses.at(-1)).toBe(undefined)
  const after = await $.ui.mount(ABOVE)
  expect(await after.find({ type: 'Text', text: /Dispatch, check on/ })).toBe(undefined)
  expect(await after.find({ type: 'Button', key: 'open-needs-you' })).toBe(undefined)
  await after.unmount()
})

test('a stopped session\'s late pane open does not close the pane its replacement opened', async ($, on) => {
  const seen = world(on, { flag: true })
  let release
  seen.holdFirstOpen = new Promise((resolve) => { release = resolve })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.opened.length >= 1)
  // The first session's open is still pending when its replacement starts and opens the pane.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.opened.length >= 2)
  release()
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(seen.opened).toEqual(['mission', 'mission'])
  expect(seen.closed).toEqual([])
})

test('the replacement session opens its pane only after the previous session\'s close completes', async ($, on) => {
  const seen = world(on, { flag: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.opened.length >= 1)
  let release
  seen.holdClose = new Promise((resolve) => { release = resolve })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise((resolve) => setTimeout(resolve, 200))
  // The old pane's close is still pending, so the new session has not opened its pane yet.
  expect(seen.order).toEqual(['open', 'close:start'])
  release()
  await settle(() => seen.opened.length >= 2)
  expect(seen.order).toEqual(['open', 'close:start', 'close:end', 'open'])
})

// The text of a drawn tree, one string per Text or Button, in order: what the person reads.
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out }
  const props = node.props ?? {}
  if (props.label) out.push(`[${props.hotkey ?? ''}] ${props.label}`)
  texts(node.children, out)
  return out
}

test('the glance layer as drawn: banner, band with its 1 button, status, pane, and a toast for a new ask', async ($, on) => {
  const seen = world(on, { flag: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const above = await $.ui.mount(ABOVE)
  const pane = await $.ui.mount(PANE)
  const frame = { banner: texts(await above.drawn()), pane: texts(await pane.drawn()), status: seen.statuses.at(-1), toasts: [] }
  await above.unmount()
  await pane.unmount()

  // A second ask arrives on the next poll.
  const inbox = JSON.parse(INBOX)
  inbox.items.push({ ...inbox.items[0], taskId: 'mc-2', title: 'flaky test', pending: { ...inbox.items[0].pending, reviewId: 'r2' } })
  inbox.needsYou.push('mc-2')
  inbox.counts.waiting = 2
  seen.inbox = JSON.stringify(inbox)
  await seen.clock.advance(5000)
  await settle(() => seen.toasts.length > 0)
  frame.toasts = seen.toasts
  frame.status = seen.statuses.at(-1)
  const again = await $.ui.mount(ABOVE)
  frame.bannerAfter = texts(await again.drawn())
  await again.unmount()
  console.log('GLANCE_FRAME::' + JSON.stringify(frame))
  expect(frame.toasts).toEqual(['Mission Control: "flaky test" asks a question'])
  expect(frame.bannerAfter.join(' ')).toMatch(/2 tasks need you/)
})

// ---------------------------------------------------------------- P11: the command, the tool, the nudge
// The command, the tool and the intent nudge reach the flows through the real hooks module. Dialogs
// (`$.ui.ask`) ride the engine's AskUserQuestion tool call, which this kit answers through a `tool.call`
// hook; the tests near the end of this file complete a dispatch that way (a pick, and text typed under
// Other) through both the registered command and the registered tool. The flows' many branches are
// covered with the fake host in `test/home-dispatch-mod-flows.test.ts`.

function dispatchWorld(on) {
  const seen = world(on, { flag: true })
  seen.registered = []
  seen.tools = []
  on('command.register', (_, e) => { seen.registered.push(e.name); return { value: { command: e.name } } })
  on('tool.register', (_, e) => { seen.tools.push(e.name); return { value: { tool: `mcp__mission-control__${e.name}` } } })
  return seen
}

const COMMAND = (args) => ({ command: 'mission-dispatch', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })

test('the command and the tool are registered, and the inbox argument opens the pane on Needs you', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  expect(seen.registered).toEqual(['mission-dispatch'])
  expect(seen.tools).toEqual(['start_dispatch'])

  const before = seen.openArgs.length
  await $.command.run(COMMAND('inbox'))
  await settle(() => seen.openArgs.length > before)
  expect(seen.openArgs.at(-1).focus).toBe(true)
})

test('the tool refuses a call with no brief', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const empty = await $.tool.call({ tool: 'mcp__mission-control__start_dispatch', brief: ' ' })
  expect(JSON.stringify(empty)).toMatch(/needs a brief/)
})

test('the tool says headless mode is not available while the flag is off', async ($, on) => {
  const seen = dispatchWorld(on)
  seen.flag = false
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.urls.length >= 1)
  const refused = await $.tool.call({ tool: 'mcp__mission-control__start_dispatch', brief: 'x' })
  expect(JSON.stringify(refused)).toMatch(/not available in this session/)
})

test('the intent nudge is attached only when the prompt names Mission Control with a verb', async ($, on) => {
  const seen = dispatchWorld(on)
  // The engine's own end of the prompt: it echoes what entered, as core does.
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const nudged = await $.prompt.submit({ text: 'run this in mission control', origin: { kind: 'composer' } })
  expect(JSON.stringify(nudged)).toContain('Call start_dispatch with intent now')
  const plain = await $.prompt.submit({ text: 'rename the helper', origin: { kind: 'composer' } })
  expect(JSON.stringify(plain)).not.toContain('start_dispatch')
})

test('when the engine refuses prompt.fill, the description is asked in a dialog, not left to a log line (S12)', async ($, on) => {
  const seen = dispatchWorld(on)
  const asks = []
  const fills = []
  on('prompt.fill', (_, e) => { fills.push(e.text); return { isFilled: false } })
  // `$.ui.ask` rides AskUserQuestion; dismissing it ends the flow, and the call itself is the proof.
  on('tool.call', (_, e) => { if (e.tool === 'AskUserQuestion') asks.push(e); return { isError: true, result: 'dismissed', text: 'dismissed' } })
  const draft = JSON.stringify({ draftId: 'd1', repoRoot: '/repo', kind: 'ship', kindLabel: 'ship', afterWork: 'None', afterWorkApplies: true, words: '', context: null, needs: ['description'], brief: '', text: 'Repo: /repo' })
  seen.reply = (url) => url.endsWith('/dispatch/dispatch-options') ? JSON.stringify({ questions: [] })
    : url.endsWith('/dispatch/drafts') ? draft
    : url.endsWith('/confirm') ? JSON.stringify({ choice: 'cancel', taskId: null, started: false })
    : undefined
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  await $.command.run(COMMAND('ship tidy logging'))
  await settle(() => asks.length > 0)
  expect(fills).toEqual(['/mission-dispatch '])
  expect(JSON.stringify(asks[0])).toMatch(/What should this task do/)
})

test('the command stores the pane target before it opens the pane (tab, task row, or as it was)', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const run = async (args) => {
    const before = seen.openArgs.length
    await $.command.run(COMMAND(args))
    await settle(() => seen.openArgs.length > before)
  }
  await run('check')
  expect(seen.state.paneTab).toBe('tasks')
  expect(seen.state.selectedTaskId).toBe(null)
  await run('mc-1')
  expect(seen.state.paneTab).toBe('tasks')
  expect(seen.state.selectedTaskId).toBe('mc-1')
  expect(seen.state.paneView).toBe('item')
  await run('inbox')
  expect(seen.state.paneTab).toBe('needs-you')
  expect(seen.state.selectedTaskId).toBe(null)
  expect(seen.state.paneView).toBe('list')
})

test('a request held by the token read is not sent when the session ends meanwhile', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  let release
  seen.holdRead = new Promise((resolve) => { release = resolve })
  const before = seen.urls.length
  await $.command.run(COMMAND('ship add retries'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  await $.session.end({ reason: 'other', sessionId: 's1' })
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(seen.urls.slice(before).some((u) => u.includes('/dispatch/dispatch-options'))).toBe(false)
})

test('a pane open that finishes after its session ended is taken back, and writes no target', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  let release
  seen.holdOpen = new Promise((resolve) => { release = resolve })
  const openedBefore = seen.opened.length
  await $.command.run(COMMAND('inbox'))
  await settle(() => seen.opened.length > openedBefore)
  await $.session.end({ reason: 'other', sessionId: 's1' })
  const closedBefore = seen.closed.length
  release()
  await settle(() => seen.closed.length > closedBefore)
  // The late open is closed again: no pane stays visible for an ended session.
  expect(seen.closed.length).toBe(closedBefore + 1)
  expect(seen.order.at(-1)).toBe('close:end')
})

test('a stale pane open does not close the pane a replacement session opened, and does not retarget it', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  let release
  seen.holdOpen = new Promise((resolve) => { release = resolve })
  const openedBefore = seen.opened.length
  await $.command.run(COMMAND('check'))
  await settle(() => seen.opened.length > openedBefore)
  // The session is replaced while the open is pending; the replacement opens its own pane on Needs you.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.opened.length >= openedBefore + 2)
  const closedBefore = seen.closed.length
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(seen.closed.length).toBe(closedBefore)
  expect(seen.state.paneTab).toBe('needs-you')
})

test('a pane target write in flight across a session replacement does not change the replacement\'s tab', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  let release
  seen.holdSet = new Promise((resolve) => { release = resolve })
  seen.holdSetKey = 'paneTab'
  // The task-row shortcut writes paneTab first; that write is held in flight.
  await $.command.run(COMMAND('mc-1'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  seen.state.selectedTaskId = null
  seen.state.paneView = 'list'
  // The session is replaced while it is held. Its writes queue behind the one in flight.
  const replacing = $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise((resolve) => setTimeout(resolve, 100))
  release()
  await replacing
  await settle(() => seen.opened.length >= 2)
  await new Promise((resolve) => setTimeout(resolve, 250))
  // The old write lands first and the replacement's Needs you lands after it; nothing else of the old command's does.
  expect(seen.state.paneTab).toBe('needs-you')
  expect(seen.state.selectedTaskId).toBe(null)
  expect(seen.state.paneView).toBe('list')
})

test('a stale pane open that finishes first does not close a replacement open still pending', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  let releaseStale
  let releaseReplacement
  seen.holdOpens = [new Promise((resolve) => { releaseStale = resolve }), new Promise((resolve) => { releaseReplacement = resolve })]
  const openedBefore = seen.opened.length
  await $.command.run(COMMAND('inbox'))
  await settle(() => seen.opened.length > openedBefore)
  // The replacement starts and its own open is pending too.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.opened.length >= openedBefore + 2)
  const closedBefore = seen.closed.length
  releaseStale()
  await new Promise((resolve) => setTimeout(resolve, 200))
  releaseReplacement()
  await new Promise((resolve) => setTimeout(resolve, 200))
  // No close came after the stale open finished: the replacement's pane stays.
  expect(seen.closed.length).toBe(closedBefore)
})

test('a second dispatch while one is open is refused, so only one draft is made', async ($, on) => {
  const seen = dispatchWorld(on)
  const draft = JSON.stringify({ draftId: 'd1', repoRoot: '/repo', kind: 'ship', kindLabel: 'ship', afterWork: 'None', afterWorkApplies: true, words: 'x', context: null, needs: [], brief: 'x', text: 'Repo: /repo' })
  seen.reply = (url) => url.endsWith('/dispatch/dispatch-options') ? JSON.stringify({ questions: [] })
    : url.endsWith('/dispatch/drafts') ? draft
    : url.endsWith('/confirm') ? JSON.stringify({ choice: 'cancel', taskId: null, started: false })
    : undefined
  let release
  const held = new Promise((resolve) => { release = resolve })
  // The confirm dialog (AskUserQuestion) stays open until released.
  on('tool.call', async (_, e) => { if (e.tool === 'AskUserQuestion') await held; return { isError: true, result: 'dismissed', text: 'dismissed' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const drafts = () => seen.urls.filter((u) => u.endsWith('/dispatch/drafts')).length
  await $.command.run(COMMAND('ship add retries'))
  await settle(() => drafts() >= 1)
  const second = await $.tool.call({ tool: 'mcp__mission-control__start_dispatch', brief: 'another task' })
  expect(JSON.stringify(second)).toMatch(/already open/)
  await $.command.run(COMMAND('ship a third'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(drafts()).toBe(1)
  release()
})

test('a command or tool the engine refuses to register is logged on the debug channel', async ($, on) => {
  const seen = world(on, { flag: true })
  const logs = []
  // No command.register or tool.register implementation: the engine refuses both, as it would a bad schema.
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  expect(logs.some((t) => /could not register the mission-dispatch command: /.test(t))).toBe(true)
  expect(logs.some((t) => /could not register the start_dispatch tool: /.test(t))).toBe(true)
})

test('a draft left waiting for its description does not outlive its session', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  seen.state.draftId = 'draft-from-this-session'
  await $.session.end({ reason: 'other', sessionId: 's1' })
  expect(seen.state.draftId).toBe(null)

  // A leftover id from a session that never ended cleanly is dropped at the next start.
  seen.state.draftId = 'draft-left-behind'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.state.draftId === null)
  expect(seen.state.draftId).toBe(null)
})

test('overlapping session starts: the replacement owns dispatch and the held start installs nothing', async ($, on) => {
  const seen = dispatchWorld(on)
  seen.ids = ['s2']
  let release
  // The first start's draftId clear is held in flight.
  seen.holdSet = new Promise((resolve) => { release = resolve })
  seen.holdSetKey = 'draftId'
  const first = $.session.start({ cwd: '/old', surface: 'terminal', isInteractive: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const second = $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  release()
  await Promise.all([first, second])
  await settle(() => seen.statuses.length > 0)
  // Only the replacement registered, and it polls under its own id.
  expect(seen.urls.filter((u) => u.endsWith('/dispatch/sessions')).length).toBe(1)
  expect(seen.urls.some((u) => u.includes('/dispatch/inbox') && u.includes('session=s2'))).toBe(true)
  expect(seen.urls.some((u) => u.includes('session=s1'))).toBe(false)
})

test('a refused pane open from the band button is logged, not left unhandled', async ($, on) => {
  const seen = dispatchWorld(on)
  const logs = []
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const ui = await $.ui.mount(ABOVE)
  seen.failOpen = true
  await ui.press({ key: 'open-needs-you' })
  await settle(() => logs.some((t) => /the 1 button failed: /.test(t)))
  expect(logs.some((t) => /the 1 button failed: /.test(t))).toBe(true)
  await ui.unmount()
})

test('a stopped session\'s late registration reply does not overwrite its replacement\'s state', async ($, on) => {
  const seen = world(on, { flag: true })
  let release
  seen.holdFirstSessionsReply = new Promise((resolve) => { release = resolve })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.urls.some((u) => u.endsWith('/dispatch/sessions')))
  // The first session's registration reply is still held when its replacement registers.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.state.registration !== undefined)
  expect(seen.state.registration.repoRoot).toBe('/repo1')
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(seen.state.registration.repoRoot).toBe('/repo1')
})

test('a session that ends while its pane open waits for the previous close never opens', async ($, on) => {
  const seen = world(on, { flag: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.opened.length >= 1)
  let release
  seen.holdClose = new Promise((resolve) => { release = resolve })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise((resolve) => setTimeout(resolve, 200))
  // The second session is waiting on the first's close; it ends before the close completes.
  await $.session.end({ reason: 'other', sessionId: 's1' })
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(seen.opened).toEqual(['mission'])
})

test('a session end whose draftId clear is overtaken by a replacement start does not clear the replacement\'s draft marker', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  let release
  // An earlier shared write is held in flight, so the clears below wait their turn behind it.
  seen.holdSet = new Promise((resolve) => { release = resolve })
  seen.holdSetKey = 'paneTab'
  await $.command.run(COMMAND('mc-1'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  seen.setKeys = []
  const ending = $.session.end({ reason: 'other', sessionId: 's1' })
  const starting = $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise((resolve) => setTimeout(resolve, 100))
  release()
  await Promise.all([ending, starting])
  // Only the replacement's own start cleared the marker; the end that it overtook stood down.
  expect(seen.setKeys.filter((k) => k === 'draftId').length).toBe(1)
})

test('a command whose pane open is refused tells the person, and the next command opens the pane', async ($, on) => {
  const seen = dispatchWorld(on)
  const notices = []
  on('session.append', (_, e) => { notices.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const before = seen.opened.length
  seen.failOpen = true
  await $.command.run(COMMAND('inbox'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(seen.opened.length).toBe(before)
  seen.failOpen = false
  await $.command.run(COMMAND('inbox'))
  await settle(() => seen.opened.length > before)
  expect(seen.opened.length).toBe(before + 1)
})

// ------------------------------------------------ a dispatch completed through the registered hooks
// The engine's own dialog (`$.ui.ask`) is a `tool.call` of AskUserQuestion: the test answers it there,
// with a label for a pick and with any other text for the dialog's Other field.

const SUMMARY = (words, needs = []) => JSON.stringify({ draftId: 'd1', repoRoot: '/repo', kind: 'ship', kindLabel: 'ship', afterWork: 'None', afterWorkApplies: true, words, context: null, needs, brief: words, text: 'Repo: /repo\nKind: ship\n\nDescription:\n' + words })
const STARTED = JSON.stringify({ choice: 'start', taskId: 'mc-9', started: true })

function dispatchRoutes(seen, { needsDescription = false } = {}) {
  seen.reply = (url, body) => url.endsWith('/dispatch/dispatch-options') ? JSON.stringify({ questions: [] })
    : url.endsWith('/dispatch/drafts') ? SUMMARY(body.words ?? '', needsDescription ? ['description'] : [])
    : url.endsWith('/dispatch/drafts/d1') ? SUMMARY(body.words ?? '')
    : url.endsWith('/confirm') ? STARTED
    : undefined
}

function answerDialogs(on, seen, answerFor) {
  seen.asked = []
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return undefined
    const q = e.questions[0]
    seen.asked.push(q.header)
    const answer = answerFor(q)
    // The engine reads the answer from the tool result's `answers`, keyed by the question's text.
    return { result: { questions: e.questions, answers: { [q.question]: answer } }, text: 'answered' }
  })
}

test('the registered command completes a dispatch: the dialog answer is a pick, a draft and a confirm are sent, and the receipt is shown', async ($, on) => {
  const seen = dispatchWorld(on)
  dispatchRoutes(seen)
  const logs = []
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  answerDialogs(on, seen, (q) => q.header === 'Confirm' ? 'Start now' : q.options[0].label)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  await $.command.run(COMMAND('ship add retries'))
  await settle(() => logs.some((t) => t.startsWith('Started mc-9: ')))
  const draft = seen.bodies.find((b) => b.url.endsWith('/dispatch/drafts'))
  expect(draft.body.words).toBe('add retries')
  expect(draft.body.kind).toBe('ship')
  expect(seen.asked).toEqual(['Confirm'])
  // The summary is one line: the engine draws a newline in a notice as a replacement character.
  const summaryNotice = logs.find((t) => t.startsWith('Repo: /repo'))
  expect(summaryNotice).toBe('Repo: /repo · Kind: ship · Description: add retries')
  expect(logs.some((t) => t.includes('\n'))).toBe(false)
  expect(seen.bodies.find((b) => b.url.endsWith('/confirm')).body.choice).toBe('start')
  expect(logs.some((t) => t.startsWith('Started mc-9: '))).toBe(true)
  expect(seen.toasts.some((t) => t.startsWith('Started mc-9: '))).toBe(true)
})

test('the registered tool completes a dispatch and returns the receipt, with the words and the context sent apart', async ($, on) => {
  const seen = dispatchWorld(on)
  dispatchRoutes(seen)
  answerDialogs(on, seen, (q) => q.header === 'Confirm' ? 'Start now' : q.options[0].label)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const result = await $.tool.call({ tool: 'mcp__mission-control__start_dispatch', brief: 'add retries to the webhook client', context: 'client.ts throws on a 502', intent: 'now' })
  expect(JSON.stringify(result)).toMatch(/Started mc-9: /)
  const draft = seen.bodies.find((b) => b.url.endsWith('/dispatch/drafts'))
  expect(draft.body.words).toBe('add retries to the webhook client')
  expect(draft.body.context).toBe('client.ts throws on a 502')
  expect(draft.body.words).not.toContain('502')
  expect(seen.bodies.find((b) => b.url.endsWith('/confirm')).body.choice).toBe('start')
})

test('text typed under Other reaches the draft as the description, through the real dialog adapter', async ($, on) => {
  const seen = dispatchWorld(on)
  dispatchRoutes(seen, { needsDescription: true })
  // The prompt box cannot be filled, so the description is asked in a dialog; the person types it under Other.
  on('prompt.fill', () => ({ isFilled: false }))
  answerDialogs(on, seen, (q) => q.header === 'Task' ? 'tidy the logging module' : q.header === 'Confirm' ? 'Start now' : q.options[0].label)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  await $.command.run(COMMAND('ship x'))
  await settle(() => seen.bodies?.some((b) => b.url.endsWith('/confirm')))
  expect(seen.asked).toContain('Task')
  const update = seen.bodies.find((b) => b.url.endsWith('/dispatch/drafts/d1'))
  expect(update.body.words).toBe('tidy the logging module')
  expect(seen.bodies.find((b) => b.url.endsWith('/confirm')).body.choice).toBe('start')
})

test('the pane commands drive the drawn pane: check shows Tasks, inbox shows Needs you again', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  const drawn = async () => {
    const pane = await $.ui.mount(PANE)
    const lines = texts(await pane.drawn())
    await pane.unmount()
    return lines
  }
  const waiting = (lines) => lines.includes('Keep?')
  expect(waiting(await drawn())).toBe(true)

  const open = async (args) => {
    const before = seen.openArgs.length
    await $.command.run(COMMAND(args))
    await settle(() => seen.openArgs.length > before)
  }
  await open('check')
  const onTasks = await drawn()
  expect(waiting(onTasks)).toBe(false)
  await open('inbox')
  expect(waiting(await drawn())).toBe(true)
  // A task id that needs the person opens that item.
  await open('check')
  expect(waiting(await drawn())).toBe(false)
  await open('mc-1')
  expect(waiting(await drawn())).toBe(true)
})
