# Add Herdr as a supported multiplexer

Mission Control should support Herdr through the existing `Multiplexer` registry, not through a
parallel Herdr integration. Herdr's workspaces, tabs, and panes map cleanly to the existing session,
window, and pane model. The adapter can therefore reuse the same generic discovery, pane I/O,
focus, rename, kill, home-liveness, and terminal-launch call sites already used by tmux and cmux.

The fit is strong but not zero-change. Three generic assumptions need to be corrected, and Herdr
needs a bounded local-socket transport inside its adapter:

1. Multiplexer correlation currently requires a pane tty even though `MuxPane` already carries the
   pane's root PID. Herdr 0.8.2 reports the shell PID and no tty, so correlation should fall back to
   an exact process-ancestry match when the tty is absent.
2. `spawnDetached` cannot distinguish a background dispatch from an operator opening a terminal.
   Herdr and cmux both expose an explicit focus flag. Add a backend-neutral selection intent so
   dispatch stays in the background while a requested terminal becomes visible.
3. Binary presence is treated as runtime support. The initial Herdr adapter is POSIX-only, so the
   generic binary availability contract must expose an actionable unsupported-host reason and gate
   discovery, home selection, target launch, and setup before any process or socket work.
4. Herdr's CLI is a wrapper over its newline-delimited JSON socket. A CLI-only discovery pass would
   spawn one process for the snapshot plus one process per pane every 1.5 seconds, and it cannot use
   Herdr's bracket-aware `pane.send_input` operation for a safe multiline paste. A small, validated
   socket client inside the adapter avoids both problems without changing the `Multiplexer` API.

This plan targets the latest stable Herdr release, v0.8.2, and its default local session. Herdr's
named server sessions are a separate namespace problem and are outside the approved first release.

## Recommendation

Build a socket-backed `herdrMultiplexer` adapter, register `herdr` after `tmux` and before `cmux`,
and make only the three generic contract changes above. Keep every Herdr command, response schema,
timeout, and environment rule inside `src/server/terminal/herdr*.ts`. Browser code, actions, routes,
and dispatch code continue to ask capabilities and never branch on `backend === "herdr"`.

Use Herdr's full client as the attach command for the first release. Before an attach, the adapter
selects the target agent pane, so the new client opens on the correct workspace and pane. Herdr does
not currently publish attached client ttys through its stable socket API, so the adapter must
declare `clients: null`. That uses Mission Control's existing honest fallback: select the pane, then
open a new Herdr client in an available emulator. Because `attachArgv` carries no environment, the
adapter returns an environment-scrubbed wrapper argv that removes Herdr namespace selectors before
executing the resolved client binary. The limitation is visible and bounded - Mission Control cannot
raise an already attached Herdr client and repeated Focus actions may open another client. Direct
terminal attach is not the recommended workaround because Herdr permits only one
writable direct-attach controller per terminal; using `--takeover` would close the operator's
existing attachment, which violates Mission Control's no-yank focus rule.

## Why the existing interface is the right home

| Mission Control concept | Herdr concept | Address and display mapping |
|---|---|---|
| Multiplexer session | Workspace | `workspace_id` is the stable address; workspace label is `sessionName` |
| Window | Tab | tab number is `windowIndex`; tab label is `windowName` |
| Pane | Pane | public `pane_id` is `paneId` |
| Pane process | Root shell | `pane.process_info.shell_pid` is `panePid` |
| Pane tty | Not exposed | `tty: null`; correlate through shell-PID ancestry |
| Create home | Create workspace at the requested cwd, run command, optionally split at the same cwd | maps to `sessions.spawnDetached` |
| Attach | Full Herdr client | `attachArgv` returns a namespace-scrubbed wrapper around the resolved Herdr binary |
| Rename home | Rename workspace | maps to `sessions.rename` by workspace ID |
| Kill home | Close workspace | maps to `sessions.kill` by workspace ID |

The stable address versus human name distinction is already in the interface because cmux forced
it. Herdr reuses it directly: workspace IDs remain safe after a label changes, and cards show the
label rather than an opaque ID.

### Capability matrix

| `Multiplexer` capability | Herdr implementation | Contract result |
|---|---|---|
| `list` | One socket connection: `session.snapshot`, then correlated `pane.process_info` requests | Required, implemented |
| `write.text` | `pane.send_text` | Required, implemented |
| `write.keys` | `pane.send_keys` with an exhaustive `Record<Key, string>` | Required, implemented |
| `write.paste` | `pane.send_input` with text and no keys, so Herdr applies live bracketed-paste state | Implemented |
| `capture` | `pane.read` with visible text | Implemented |
| `paneMode` | Herdr's API writes directly to the owned PTY and exposes no equivalent blocking pane mode | `null` |
| `select` | `agent.focus` targeted by public pane ID | Implemented for Mission Control's agent sessions |
| `clients` | Herdr supports attached clients, but the stable API exposes no client list or client tty mapping | `null` |
| `sessions` | workspace create/rename/close plus command injection and optional split | Implemented |

## Confirmed Herdr behavior

The plan distinguishes documented contracts from implementation details observed in the stable
source:

- Documented: Herdr is a background server with detachable clients; workspaces contain tabs and
  panes; the CLI uses the same local socket API available to integrations; `session.snapshot`
  returns workspace, tab, pane, layout, and agent records; pane read/write/process methods and
  workspace create/focus/rename/close are public API operations.
- Documented: normal detach keeps pane processes alive. A full server stop does not preserve
  arbitrary live processes, even though Herdr can restore workspace shape and selected native agent
  sessions. This is compatible with Mission Control's definition of a persistent multiplexer - a
  tmux server stop also destroys its panes.
- Observed in v0.8.2 source: `pane.process_info` fills `shell_pid` but sets `tty` to `None`. This is
  why the existing tty-only join cannot discover a Herdr-hosted Mission Control session.
- Documented and observed: `pane.send_input` checks the pane's live bracketed-paste mode, while
  `pane.send_text` sends raw text. Mission Control's multiline composer must use the former for
  paste rather than manufacture unconditional escape markers.
- Documented: workspace and tab creation do not select the new layout unless `focus` is requested.
  That is the distinction Mission Control needs between background dispatch and an operator launch.
- Documented: `herdr status server --json` reports whether the server is running and whether the
  installed client is protocol-compatible. Running `herdr` starts the detached server when needed,
  but the noninteractive workspace commands do not. Mission Control must therefore start and await a
  headless `herdr server` when creating a workspace. Other reads and mutations target existing state
  and must not start a stopped server.
- Observed in the stable schema: an exact raw `pane.focus` method exists, but the published method
  table and CLI expose directional pane focus instead. This plan does not make that unpublished
  method load-bearing. It uses the documented `agent.focus` operation for agent sessions.

Primary sources:

- [Herdr v0.8.2 release](https://github.com/herdrdev/herdr/releases/tag/v0.8.2)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
- [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [Herdr session persistence](https://herdr.dev/docs/session-state/)
- [v0.8.2 pane process implementation](https://github.com/herdrdev/herdr/blob/v0.8.2/src/app/api/panes.rs#L203-L249)
- [v0.8.2 bracket-aware input encoding](https://github.com/herdrdev/herdr/blob/v0.8.2/src/app/api_helpers.rs#L69-L106)

## Architecture and data flow

Today the strong discovery path is:

```text
OS process -> controlling tty -> multiplexer pane -> generic MuxHandle -> Session
```

Herdr adds a second exact key without changing the result:

```text
OS agent process -> parent chain -> Herdr shell pane PID -> generic MuxHandle -> Session
```

Runtime calls stay on the current capability path:

```text
Dashboard or dispatcher
  -> generic action / home / target launcher
  -> MULTIPLEXERS.herdr
  -> validated Herdr socket client
  -> default Herdr server
  -> workspace / tab / pane

Focus continues outward after pane selection:

Herdr agent.focus
  -> attached client lookup is unavailable (`clients: null`)
  -> existing emulator spawn fallback
  -> `herdr` full client
```

No Herdr state is written to SQLite. The existing session handle carries the workspace, tab, and
pane address, and the next discovery sweep remains authoritative.

## Implementation plan

### 1. Prove and add PID-ancestry correlation

Change `src/server/discovery/correlate.ts` so a multiplexer pane with no tty can be paired to an
agent only when its non-null `panePid` appears in that agent's actual parent chain in the same
process snapshot.

Rules:

- A backend-reported tty stays the strongest key and wins unchanged.
- PID fallback applies only to multiplexer panes whose tty is null.
- Pair only an actual descendant relationship, never PID proximity, cwd agreement, or a first hit.
- If more than one pane from one backend is an ancestor candidate, take the closest ancestor. If
  the result is still ambiguous, do not attach that backend handle.
- Preserve multiplexer registry order across different backends. In a Herdr workspace containing an
  inner tmux pane, tmux remains the more specific handle because its tty match is direct and `tmux`
  remains first in the ordered registry.
- Update the `MuxPane.tty` and `panePid` comments in `types.ts`; they currently claim tty is always
  the join and panePid has no reader.

Focused tests in `test/correlate.test.ts` cover a Herdr-shaped pane, an unrelated or recycled PID,
missing ancestors, ambiguity, and nested Herdr plus tmux ordering.

### 2. Give session creation an explicit selection intent

Add `select: boolean` to `DetachedSessionSpec`:

- `launchHome` passes `false`; dispatching work must not change what an attached client is showing.
- `launchTerminal` passes `true`; an operator who picked a backend asked to see the new terminal.
- tmux may ignore the flag because its detached creation is invisible until attach.
- cmux maps the flag to its existing `--focus` argument, fixing the current behavior where an
  operator-created cmux workspace is still created with `--focus false`.
- Herdr maps it to `workspace.create.focus`. Any best-effort side split uses no focus so the agent
  root pane stays selected.

Keep the term `select` consistent with `Multiplexer.select`: it changes what the multiplexer shows
and does not claim to raise an operating-system window.

Update `test/terminal-home.test.ts`, `test/terminal-target-contract.test.ts`, tmux adapter tests, and
cmux adapter tests to pin the two call-site values and each adapter's behavior.

### 3. Add a bounded Herdr socket client and server readiness helper

Create `src/server/terminal/herdr-client.ts` with a deliberately small surface:

- Resolve the socket and compatibility state through `herdr status server --json`.
- Open one local socket connection per logical operation, assign unique request IDs, terminate each
  request with a newline, correlate responses by ID, and close after the bounded batch completes.
- Validate every consumed response with narrow Zod schemas. Ignore additive fields but reject
  missing identities, type changes, mismatched IDs, protocol incompatibility, truncated lines, and
  response-size overflow.
- Treat a deadline, disconnect, framing error, partial final line, duplicate or unknown response ID,
  and schema failure as a terminal batch failure. Settle every unresolved request exactly once,
  clear timers and listeners, mark the batch closed, destroy the socket, and ignore late events.
- Preserve `TerminalResult.outcomeUnknown` by tracking whether each mutation request was written.
  Any terminal batch failure after its bytes were written is unknown, including malformed,
  mismatched, or invalid responses; only pre-write failures and parsed Herdr application refusals
  are confirmed non-delivery. Reads still degrade to no panes or no capture without poisoning other
  terminal backends.
- Keep operation-specific timeouts below the 1.5-second discovery cadence for reads; give workspace
  creation and teardown their existing user-action budget.
- Pin the supported stable protocol/version in one exported constant and return an actionable
  incompatibility message rather than sending unvalidated requests.

The readiness helper is creation-only. It first probes status; when no server is running,
`sessions.spawnDetached` starts `herdr server` as a detached, stdio-ignored child, then polls status
to a fixed deadline. Concurrent starters are safe: an address-in-use loser succeeds if the shared
readiness probe becomes healthy. Discovery, capture, write, focus, rename, and close never start a
stopped server, and Mission Control never stops or replaces an incompatible one.

Inject both the command runner and detached-spawn seam so unit tests never require Herdr and never
leave a real daemon running.

### 4. Implement and register `herdrMultiplexer`

Create `src/server/terminal/herdr.ts`:

- Scope the initial adapter to POSIX hosts. It uses Herdr's Unix socket and a POSIX `env -u`
  full-client attach wrapper; Windows named-pipe transport and environment scrubbing are separate
  compatibility work and must not be presented as supported.
- Extend the generic server-side `BinSpec` availability contract with a host-support check and an
  actionable reason, rather than branching on `herdr` in callers. The Herdr spec reports unsupported
  on `win32`; `binPresent`, discovery, home selection, target launch, and setup consume that same
  result. Keep the ID registered for exhaustive schemas, but render its target row disabled as
  `Herdr integration is supported on POSIX hosts only` and run no Herdr process or socket operation.
- `HERDR_BIN` follows `CMUX_BIN`: an override plus `herdr` on PATH. For the recommended default-only
  scope, remove ambient `HERDR_SESSION`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`,
  and `HERDR_PANE_ID` from adapter subprocesses so starting Mission Control inside a Herdr pane does
  not silently redirect the daemon to a different server namespace.
- `list` requests `session.snapshot`, sends a `pane.process_info` request for every pane on the same
  socket, and joins by pane ID. Map workspace ID/label, tab number/label, pane ID, shell PID, null
  tty, and `foreground_cwd ?? cwd` into `MuxPane`.
- `write.text`, `write.keys`, `write.paste`, and `capture` use the socket operations in the matrix.
  Key mapping is exhaustive and compiled against every shared `Key`.
- `select` uses documented `agent.focus` with the pane ID. Return the Herdr error if it cannot
  identify the agent rather than falling back to an unpublished method.
- `sessions.spawnDetached` ensures the server, creates the workspace with `cwd: spec.cwd` and the
  requested selection intent, shell-encodes the argv once through the existing `shellCommand`,
  submits it to the returned root pane, and optionally creates a no-focus side split rooted at the
  same `spec.cwd`. Close that exact workspace only when a parsed Herdr refusal confirms the command
  was not delivered. Preserve the workspace for every `outcomeUnknown` timeout, disconnect,
  framing, correlation, or schema-failure path so cleanup cannot destroy work that may have started.
- `sessions.attachArgv` returns a POSIX `env -u ...` wrapper followed by the resolved Herdr binary,
  attaching the full client to the default server even when the daemon inherited named-session
  selectors. `rename` and `kill` target workspace ID, not label. Use `PLAIN_NAMES` unless live v0.8.2
  validation proves a stricter label rule.
- Declare `clients: null` and `paneMode: null` with comments that state the measured reason.

Append `herdr` to `MULTIPLEXER_IDS` after `tmux` and before `cmux`, add it to the exhaustive factory
record in `registry.ts`, and update the registry-order comment. The ordered placement preserves the
inner-tmux precedence while preferring a terminal-native persistent Herdr server over the
self-hosting cmux GUI when neither is nested.

### 5. Cover the adapter and existing user surfaces

Add `test/herdr-client.test.ts` for framing, response correlation, schema validation, deadlines,
terminal-failure settlement, outcome uncertainty, batched snapshot/process requests, and
server-start races. Use fake Unix socket servers and injected process spawners only. Include a
non-responsive server and an unterminated partial line, and assert that every operation settles,
every pending request settles exactly once, and every socket closes. Cover malformed, duplicate-ID,
unknown-ID, and schema-mismatched mutation responses both before and after request write so the
`outcomeUnknown` boundary is exact.

Add `test/herdr-adapter.test.ts` for:

- snapshot mapping with multiple workspaces, tabs, and panes;
- null tty plus shell PID preservation;
- exact key names, raw text, bracket-aware paste, capture, and agent focus;
- create with exact cwd, shell-safe argv submission, optional same-cwd side split, rename, close,
  rollback, and attach argv;
- absent-server creation auto-start, compatible running server reuse, and incompatible server
  refusal;
- default-session environment isolation, host support, and names.

Extend binary, enumeration, home, terminal-target, setup, and launch contract tests with an installed
Herdr binary on an injected unsupported host. They must prove the row remains visible but disabled
with the POSIX-only reason, launch revalidation refuses it, discovery and home enumeration skip it,
and no CLI, socket, or server-start seam is invoked.

Extend registry, enumeration, home, target, focus-composition, and setup tests so adding the third
multiplexer changes no generic behavior accidentally. In particular, pin that an installed but
stopped Herdr is launchable because workspace creation can start its server, while passive
enumeration and existing-target operations do not start it.

This is a user-visible backend addition, so add Playwright coverage under `e2e/`:

- Extend the fake-agent fixture with a fake `HERDR_BIN` that records status/start/workspace/input
  calls and returns deterministic JSON without starting a real server or agent.
- Make the daemon fixture explicitly control Herdr installation so existing cmux expectations do
  not change by developer-machine accident.
- Add a focused spec that sees the Herdr row, launches a shell through it, verifies the foreground
  selection intent and exact worktree cwd, and confirms the user-visible success or actionable
  incompatibility sentence.
- Exercise Focus from a discovered Herdr-shaped session and verify the full-client attach command is
  passed to the fake emulator path without spending model tokens.

### 6. Document the supported boundary

Update `README.md` and `docs/harnesses-and-terminals.md`:

- List Herdr as a supported multiplexer.
- State the required stable Herdr version/protocol and `HERDR_BIN` override.
- Explain that v1 controls the default local Herdr session only.
- Explain that Mission Control can create, discover, write, capture, focus internally, rename, and
  close Herdr workspaces.
- State the outward-focus limitation: Herdr does not expose attached client ttys, so Mission Control
  opens a client when it cannot find a raiseable host and may open another on a repeated Focus.
- Describe normal detach versus full server-stop persistence without implying arbitrary processes
  survive a stopped server.

Do not edit `CHANGELOG.md`.

## Failure behavior and safeguards

| Failure | Required behavior |
|---|---|
| Herdr not installed | Registry row is unavailable by name; no subprocess on the discovery tick |
| Herdr installed on an unsupported host | Target and setup rows show the POSIX-only reason; discovery, home, launch, CLI, and socket paths do not run |
| Herdr installed, server stopped | Discovery and existing-target operations do not start it; workspace creation starts and awaits the headless server |
| Installed client and server incompatible | Fail that backend with an actionable restart/update message; never stop the server automatically |
| Socket response invalid or mismatched | Reject the operation; never guess a pane or mutation result |
| Terminal socket failure | Settle pending requests once, clear resources, destroy the socket, and ignore late events |
| Discovery socket timeout | Return no Herdr panes for that tick; tmux/cmux/emulator discovery continues |
| Mutation failure after request write | `outcomeUnknown: true` for timeout, disconnect, framing, ID, or schema failure; callers do not replay |
| Mutation failure before request write | Confirmed non-delivery; `outcomeUnknown: false` |
| Pane has no tty | Pair only through actual shell-PID ancestry; otherwise leave the session handleless |
| Agent focus unavailable | Return the Herdr refusal; do not call an undocumented fallback silently |
| Command launch fails after workspace creation | Close only the newly created workspace when delivery is a confirmed refusal |
| Attached client cannot be located | Select internally, then use the existing attach fallback; never take over an existing direct attachment |

## Validation and done criteria

Implementation is complete only when:

- Focused unit and contract tests pass with the standard test preload.
- `npm run typecheck` and `npm run lint` pass.
- `npm test` passes, including the new socket and ancestry race cases.
- `npm run build`, `npm run smoke`, and `npm run test:e2e` pass because the terminal menu and runtime
  surface change.
- A live manual verification uses stable Herdr on a disposable workspace to prove create, discovery,
  multiline paste without submission, capture, focus, rename, detach/reattach, and close. Evidence
  stays gitignored and is attached to the implementation pull request, not committed.
- The test proves Mission Control launched no real agent binary and left no test Herdr server.
- README and terminal architecture docs match the implemented version and limitations, including the
  initial POSIX-only boundary.
- An installed Herdr binary on `win32` remains unavailable with an actionable reason and cannot
  reach discovery, home, launch, CLI, server-start, or socket work.
- No caller outside the adapter branches on the Herdr ID.

## Decisions taken

1. **Use a socket-backed adapter behind `Multiplexer`.** Keep polling bounded, preserve safe
   multiline paste, and use PID ancestry as the exact fallback when Herdr supplies no tty. Do not
   ship the N+1 CLI-only discovery path or block support on upstream API additions.
2. **Support only Herdr's default local server session in the first release.** Clear Herdr namespace
   overrides at the adapter boundary and defer named-server identity work until Mission Control has
   a product requirement for it.
3. **Use the existing new-client fallback for outward focus.** Return `clients: null`, select the
   target inside Herdr, and open a normal Herdr client when Mission Control cannot raise an existing
   host. Never use direct-attach takeover semantics.
4. **Create and schedule a phased implementation plan.** Derive merge-aware phases from this
   approved source, land their artifacts with the root plan, then create dependency-linked tasks
   whose referenced paths resolve on the default branch before implementation begins.
