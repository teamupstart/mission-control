# Browser end-to-end tests

Playwright specs that drive the real dashboard against a real daemon. This is the only
layer in the repository where a click reaches a route, a route reaches a subprocess, and the
result comes back to the DOM through a server event.

```sh
npm run build      # required: this suite drives dist/, not src/
npm run test:e2e
```

Useful flags:

```sh
npm run test:e2e -- --headed          # watch it run
npm run test:e2e -- --debug           # step through with the inspector
npm run test:e2e -- -g "conversation" # one spec
npx playwright show-trace test-results/<dir>/trace.zip
```

## What this layer is for

The repository already tests UI three other ways, and none of them can reach this seam:

| Layer | Asserts | Cannot see |
|---|---|---|
| `renderToStaticMarkup` (~90 files) | markup shape | whether anything works |
| `node:test` + `buildApp()` (~34 files) | route behaviour in-process | the browser |
| Electron geometry (2 files) | laid-out heights | behaviour, state, the daemon |
| **`e2e/`** | **click → route → subprocess → SSE → DOM** | native shell chrome |

Write a spec here when the thing you changed only breaks when the parts are connected: a
control that fires a request, a server event that has to repaint something, a flow that
crosses more than one screen.

Do **not** write one here for something a cheaper layer already covers. A pure function
belongs in `test/`, a component's markup belongs in a `renderToStaticMarkup` test, and a
route's edge cases belong in an in-process HTTP test where you can enumerate them quickly.

## Why it costs nothing

Nothing in `src/` talks to a model API. There is no `api.anthropic.com`, no
`ANTHROPIC_API_KEY`, and the only `BASE_URL` is the daemon's own loopback address. Every
model interaction is a spawned CLI subprocess resolved through one chain in
`src/server/harness/bin.ts`:

```
MISSION_<AGENT>_BIN ?? FLEET_<AGENT>_BIN ?? HARNESS_<AGENT>_BIN ?? <legacy> ?? "<agent>"
```

The Agent SDK runtime goes through that same chain - `claude/sdk-deps.ts` pins
`pathToClaudeCodeExecutable` to the harness's own resolution rather than the vendor
package's bundled CLI, precisely so an operator's wrapper is honoured. So pointing those
three env vars at fakes closes every route to a real model.

A dispatch uses **two** of them, which is worth knowing before adding a spec:

- `claude -p --output-format json` - the one-shot headless runner (`llm/claude-cli.ts`) used
  by the task titler, Foreman, the goal refiner and the Inspector.
- `claude --input-format stream-json …` - the Agent SDK session.

`e2e/fixtures/fake-claude.mjs` serves both. Faking only the session would still bill a real
account on every dispatch, and `dispatch-and-converse.spec.ts` asserts that both paths landed
on the fake so that regression is caught rather than invoiced.

## Isolation

`startDaemon()` redirects everything the daemon would otherwise reach for:

| Variable | Why |
|---|---|
| `MISSION_HOME` | SQLite DB, token, logs into a temp dir |
| `HOME` | Claude transcripts derive from `homedir()`; without this the fake writes into the operator's real `~/.claude` |
| `MISSION_WORKSPACE_DIRS` | repo discovery sees only the seeded fixture repo |
| `MISSION_CLAUDE_BIN` / `CODEX` / `PI` | every agent launch hits a fake |
| `MISSION_POOL_REAP_MS=0` | the pool sweep is **not** scoped by `MISSION_HOME` - it reaps the shared treehouse worktree pool and will delete a sibling checkout's work |
| `MISSION_POLL_MS=0` | terminal discovery is **not** scoped either - it walks every process on the machine and cards anything that looks like an agent |

Those last two matter most and are the least obvious. Without `MISSION_POLL_MS=0` a daemon
booted on a developer's laptop adopts their real running sessions: the fleet count is
non-deterministic against CI where there are none, and the dashboard's Kill and Reset
controls act on live work. `startDaemon()` also asserts the database landed under the temp
home before any test runs, because `openDb`'s own isolation guard keys on
`NODE_TEST_CONTEXT`, which the `node:test` runner sets and Playwright does not.

## Writing specs

There are no `data-testid` attributes and none should be added - there are 229 `aria-label`s
and 155 `role`s, so `getByRole`/`getByLabel`/`getByPlaceholder` already work and stay
correct through refactors. Four traps, all of which have cost time already:

1. **Never use `{ exact: true }` on a button name.** Keyboard hints render as `<kbd>` inside
   the label and are part of the accessible name: the dispatch button is `"+Dispatch"`.
2. **Never use `getByText` for tooltip prose.** `Tooltip` portals a screen-reader `.tt-desc`
   span into `document.body` for every tooltip in the tree. It is `clip-path`-hidden but has
   a 1x1 box, so Playwright counts it visible and your locator matches two elements.
3. **Press `Escape` after filling the repo combobox.** It portals its listbox over the
   fields below and opens on focus and on every keystroke; the next `fill` otherwise lands on
   a covered control. Its handler calls `stopPropagation`, so this closes the list, not the
   modal.
4. **`expect.poll` for anything outside the DOM.** Playwright auto-waits on locators only. A
   `readdirSync` on the record directory the moment a card appears fails about one run in
   six, because the card is registered before the subprocess it launched has written
   anything.

Each test gets its own daemon (`fixtures/test.ts`). That costs about a second and a half and
buys independence: a spec asserting "exactly one session on the fleet" must not silently
depend on running before the spec that dispatches a second.

## What this layer still cannot see

Playwright drives web contents. Native Electron shell behaviour - drag regions, traffic
lights, window chrome, vibrancy - is invisible to CDP and to synthetic clicks, and stays a
manual check.
