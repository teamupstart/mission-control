// @ts-nocheck
// The engine-level test of the hooks module, run by `claude plugin test` (see
// `scripts/test-mod-engine.mjs`). It is not part of `npm test` or the type check: the kit it
// imports is the engine's own, which this repository does not carry. The controller's rules are
// covered in `test/home-dispatch-mod-core.test.ts`; this proves the adapter wires them to the
// engine's `$`: the session starts, the daemon is reached over `$.http`, the pane is opened, and
// the glance layer draws.
import { expect, mock, test } from 'claude-code/testing'

const HEALTH = (on) => JSON.stringify({ ok: true, service: 'mission-control', version: '2.3.0', capabilities: on ? ['home-dispatch-v1'] : [] })
const registration = (minModApi) => JSON.stringify({
  sessionId: 's1', repoRoot: '/repo', created: true, offerLauncher: false,
  counts: { running: 0, waiting: 1 }, daemonVersion: '2.3.0', minModApi, dashboardUrl: 'http://127.0.0.1:7317/',
  banner: ['◆ Mission Control   ● Claude Code', 'Dispatch, check on and answer tasks without leaving this session', '0 running | 1 waiting on you | /mission-dispatch opens the menu'],
})
const INBOX = JSON.stringify({
  items: [{ taskId: 'mc-1', title: 'logging cleanup', kind: 'ship', state: 'waiting', origin: 'home-session', changedAt: 1, canMessage: true, agent: 'claude', runtime: 'sdk',
    pending: { reviewId: 'r1', kind: 'question', question: 'Keep?', allowsText: true, dashboardOnly: false } }],
  needsYou: ['mc-1'], counts: { waiting: 1, blocked: 0, ready: 0, running: 0, queued: 0, shelved: 0, failed: 0 }, slots: { used: 1, ceiling: 4 }, dashboardOnly: 0,
})

function world(on, { flag, minModApi = 1 }) {
  const seen = { inbox: INBOX, flag, urls: [], opened: [], closed: [], order: [], openArgs: [], toasts: [], statuses: [], state: {} }
  // A token file, so every daemon call reads it through `$.fs.read` (a test can hold that read).
  mock.env(on, { MISSION_API_TOKEN_FILE: '/tmp/mission-token' })
  seen.clock = mock.clock(on)
  on('session.id', () => ({ value: 's1' }))
  on('fs.read', async () => { if (seen.holdRead) await seen.holdRead; return { value: 'a-token' } })
  on('http.fetch', (_, e) => {
    seen.urls.push(e.url)
    const text = seen.reply?.(e.url) ?? (e.url.endsWith('/api/health') ? HEALTH(seen.flag) : e.url.endsWith('/dispatch/sessions') ? registration(minModApi) : seen.inbox)
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('state.get', (_, e) => ({ value: { value: seen.state[e.key], version: 1 } }))
  on('state.set', async (_, e) => { if (seen.holdSetKey === e.key && seen.holdSet) { const hold = seen.holdSet; seen.holdSet = null; await hold } seen.state[e.key] = e.value; return { value: { isSet: true, version: 2 } } })
  on('ui.open', async (_, e) => { seen.order.push('open'); seen.opened.push(e.id); seen.openArgs.push(e); if (seen.holdOpen) { const hold = seen.holdOpen; seen.holdOpen = null; await hold } if (seen.holdFirstOpen && seen.opened.length === 1) await seen.holdFirstOpen; return { value: { isPlaced: true } } })
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
  expect((await pane.find({ type: 'Text', text: /not available in this build/ }))?.text).toMatch(/Mission Control pane/)
  await pane.unmount()
  await ui.press({ key: 'open-needs-you' })
  await settle(() => seen.openArgs.length >= 2)
  expect(seen.openArgs.at(-1).focus).toBe(true)
  expect(seen.state.paneTab).toBe('needs-you')
  await ui.unmount()
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
  expect(await pane.find({ type: 'Text', text: /not available in this build/ })).toBe(undefined)
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
  expect(await pane.find({ type: 'Text', text: /not available in this build/ })).toBe(undefined)
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
// Dialogs (`$.ui.ask`) ride the engine's AskUserQuestion tool call, which this kit answers only
// through a `tool.call` hook; the flows' dialogs are covered with the fake host in
// `test/home-dispatch-mod-flows.test.ts`. This proves the registration and the hooks reach them.

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

test('a pane target write held across a session replacement leaves the replacement\'s target alone', async ($, on) => {
  const seen = dispatchWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.statuses.length > 0)
  let release
  seen.holdSet = new Promise((resolve) => { release = resolve })
  seen.holdSetKey = 'paneTab'
  // The task-row shortcut writes paneTab first; that write is held.
  await $.command.run(COMMAND('mc-1'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  // The session is replaced while it is held, and the replacement opens on Needs you.
  seen.state.selectedTaskId = null
  seen.state.paneView = 'list'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle(() => seen.opened.length >= 2)
  release()
  await new Promise((resolve) => setTimeout(resolve, 250))
  // The old command's remaining writes never reach the replacement.
  expect(seen.state.selectedTaskId).toBe(null)
  expect(seen.state.paneView).toBe('list')
})
