# Phase 2: Herdr multiplexer vertical slice

## Outcome and value

Mission Control supports stable Herdr as a first-class multiplexer through the same registry and
capability interface used by tmux and cmux. Operators can discover Herdr-hosted agent sessions,
send text and keys, paste multiline input safely, capture pane text, focus internally, launch a new
workspace, rename it, close it, and detach or reattach through the full Herdr client.

The first release targets only Herdr's default local server session. Because stable Herdr does not
expose attached-client terminal identities, Focus selects the target inside Herdr and uses Mission
Control's existing new-client fallback. It never takes over an existing direct attachment.

## Entry criteria and direct dependencies

- The planning PR and Phase 1 are merged to the default branch.
- Phase 1's exact PID-ancestry and `DetachedSessionSpec.select` contracts pass their full gates.
- Direct dependency: Phase 1, `phase-1-generic-multiplexer-foundation.md`.
- The Mission Control task also depends directly on the planning session so all plan paths resolve.
- The approved root-plan decisions remain unchanged.

## Scope

- Add a bounded, validated Herdr newline-delimited JSON socket client.
- Add workspace-creation-only headless server readiness with injected command and spawn seams.
- Implement every required `Multiplexer` method and each approved optional capability.
- Register `herdr` after `tmux` and before `cmux`.
- Preserve shell PID and null tty so Phase 1 correlation can bind real sessions.
- Support the default Herdr server namespace only and isolate inherited namespace selectors.
- Extend generic HTTP, setup, menu, home, focus, launch, test-helper, and serialization coverage.
- Add fake-only browser E2E coverage and stable-Herdr manual verification.
- Document supported behavior, minimum compatibility, and known focus and namespace limits.

## Non-goals

- Do not enumerate named Herdr server sessions or widen durable identity with a server namespace.
- Do not infer attached client ttys or add a parallel client registry.
- Do not use direct terminal attach with `--takeover`.
- Do not depend on the unpublished raw `pane.focus` operation.
- Do not add a Herdr branch to React, routes, actions, home selection, or focus composition.
- Do not add SQLite state, migrations, polling caches, a long-lived socket, or an external npm
  dependency.
- Do not claim arbitrary pane processes survive a full Herdr server stop.
- Do not edit `CHANGELOG.md` or generated files.

## Repository findings and inherited contracts

- `MULTIPLEXER_IDS` is the source for the TypeScript ID union, terminal request Zod enums,
  `NameSource`, target ordering, setup choices, and exhaustive registry maps. The correct order is
  `tmux`, `herdr`, `cmux`: tmux may be nested inside Herdr, while Herdr is a persistent terminal-native
  multiplexer and cmux is the outer self-hosting GUI fallback.
- `multiplexers(exec)` in `src/server/terminal/registry.ts` is a factory because policy tests inject
  the command seam. The Herdr adapter must be constructed there and must not be a singleton hidden
  elsewhere.
- `Multiplexer` already separates stable session address from display name and accepts null
  `clients` and `paneMode`. Herdr needs no new vendor-specific capability.
- Phase 1 provides the only new generic behavior: null-tty panes correlate through actual shell-PID
  ancestry, and creation receives an explicit `select` intent.
- `terminalTargetViews`, `homeBackends`, `bindPane`, focus composition, setup checks, Worktree
  settings, Pipeline controls, and launch menus are generic consumers. Registration should activate
  them automatically; tests should catch any hidden two-entry assumption.
- `TerminalExec` is suitable for `herdr status server --json`. The raw socket and detached server
  need additional narrow injected seams local to the Herdr client module.
- The E2E daemon installs fake cmux through `CMUX_BIN` and makes other terminal binaries explicitly
  absent. It must similarly point `HERDR_BIN` at a controlled fake or a known missing path in each
  fixture mode.

## Implementation steps

### 1. Define the Herdr binary and default-session environment

Define `HERDR_BIN` beside the adapter, following the cmux pattern:

- environment override: `HERDR_BIN`;
- PATH fallback: `herdr`;
- drop inherited `HERDR_SESSION`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and
  `HERDR_PANE_ID` from every adapter-owned CLI and server-start environment;
- wrap the full-client attach argv with portable `env -u` entries for the same variables, because
  `MuxSessions.attachArgv` carries no environment and the emulator otherwise inherits the daemon's
  namespace selectors.

Use `resolveBin`, `binEnv`, and `binPresent` rather than adding another binary resolver. The adapter
must not cache the result so installing or changing Herdr does not require a Mission Control restart.

Choose a single-character glyph consistent with existing multiplexer rows. Keep the accessible and
visible name `Herdr`; do not add an image or vendor-specific CSS.

### 2. Build a bounded socket client

Create `src/server/terminal/herdr-client.ts` with a narrow dependency-injected API. Its production
implementation uses Node's local socket support and existing Zod, while tests inject connection,
clock or timeout, CLI execution, and detached-spawn behavior.

Scope this phase to POSIX hosts. The supported transport is Herdr's Unix socket, and full-client
attach uses POSIX `env -u` environment scrubbing. Windows named-pipe transport and Windows-compatible
environment scrubbing are explicit future compatibility work, not an implied part of this phase.

For each logical operation:

1. Run and validate `herdr status server --json` to establish running state, socket address,
   protocol compatibility, and actionable failure text.
2. Open one socket connection for the operation or batch.
3. Allocate unique request IDs, serialize one JSON request per line, and correlate every response by
   ID rather than arrival order.
4. Enforce maximum request count, line length, total buffered bytes, and an operation deadline.
5. Validate only fields Mission Control consumes with strict-enough Zod schemas that accept additive
   fields but reject missing IDs, identity type changes, incompatible status, truncated lines,
   duplicate response IDs, and unknown response IDs.
6. On normal completion, close the socket after the bounded batch settles. On a deadline,
   disconnect, framing or parse error, partial final line, duplicate or unknown response ID, or
   schema failure, atomically mark the batch terminal, settle every unresolved request exactly once,
   clear all deadline and per-request timers and socket listeners, destroy the socket exactly once,
   and ignore every late response or event. Do not create a daemon-wide persistent connection or a
   discovery cache.

Expose typed helpers only for the operations the adapter needs: session snapshot, pane process info,
pane read, raw text, keys, bracket-aware input, agent focus, workspace create, workspace rename,
workspace close, command delivery, and optional split creation.

Classify outcomes deliberately:

- Parsed Herdr application errors are confirmed refusals with `outcomeUnknown: false`.
- A read timeout, invalid response, or disconnect returns no panes or null capture for this backend
  and leaves other terminal enumeration untouched.
- Track whether each mutation request was written to the socket. Every subsequent terminal response,
  framing, correlation, or validation failure returns `outcomeUnknown: true`, including a deadline,
  disconnect, truncated line, malformed JSON, duplicate or unknown response ID, and schema mismatch;
  callers must not replay it.
- A pre-connect or pre-write refusal is known not to have landed and returns
  `outcomeUnknown: false`.
- Error messages name Herdr, the operation, and the operator action when compatibility or startup is
  the issue, without exposing raw socket payloads.

Keep discovery read deadlines below Mission Control's 1.5-second sweep cadence. Reuse existing
terminal user-action timeout conventions for creation, rename, and close.

### 3. Add workspace-creation-only server readiness

Implement `ensureReady` in the Herdr client boundary:

1. Probe `herdr status server --json` in the default-session environment.
2. If a compatible server is running, reuse it.
3. If no server is running and `spawnDetached` is creating a workspace, spawn `herdr server`
   detached with stdin, stdout, and stderr ignored, then poll status to a fixed deadline.
4. Treat an address-in-use losing starter as success when the shared follow-up probe becomes healthy.
5. If the running client/server pair is incompatible, return an actionable update or restart error.
   Never stop, replace, or signal that server.
6. Never auto-start from passive `list`, capture, write, paste, focus, rename, or close. Those
   operations target state that cannot be live on a stopped server and return their bounded empty
   result or refusal without creating new state.

Inject the detached-spawn seam. Unit and E2E tests must prove they launch only fakes and clean up any
temporary socket server they own.

### 4. Implement `herdrMultiplexer`

Create `src/server/terminal/herdr.ts` and implement the interface from stable public operations:

- `list`: request `session.snapshot`, then batch one `pane.process_info` request per pane on the same
  socket. Map workspace ID and label to `session` and `sessionName`, tab number and label to
  `windowIndex` and `windowName`, public pane ID to `paneId`, `shell_pid` to `panePid`, tty to null,
  and `foreground_cwd ?? cwd` to cwd. Reject malformed or duplicate identities rather than guessing.
- `write.text`: use raw `pane.send_text`.
- `write.keys`: translate every shared `Key` through an exhaustive `Record<Key, string>` and send the
  documented Herdr key operation.
- `write.paste`: use `pane.send_input` with text and no keys so Herdr observes the pane's live
  bracketed-paste mode. Do not manufacture escape markers.
- `capture`: use `pane.read` and return visible text, or null on a bounded read failure.
- `paneMode`: declare null because writes address the owned PTY directly and Herdr exposes no
  equivalent blocking multiplexer mode.
- `select`: use documented `agent.focus` with the public pane ID. Surface a confirmed refusal when
  the pane is not an agent target; do not fall back to unpublished exact pane focus.
- `clients`: declare null because stable Herdr exposes no attached-client terminal list.

Implement `sessions`:

- `spawnDetached` calls workspace-creation readiness and creates a workspace with `cwd: spec.cwd`
  plus Phase 1's `spec.select`. It shell-encodes `spec.argv` once through the existing `shellCommand`
  and submits it to the returned root pane. A requested convenience split is best-effort, uses the
  same `spec.cwd`, and never steals selection from the agent root.
- If command delivery is a confirmed refusal after workspace creation, close only that returned
  workspace. If delivery is uncertain, preserve the workspace and unknown outcome rather than
  issuing a destructive replay or cleanup.
- `attachArgv` returns `env -u` entries for every Herdr namespace selector followed by the resolved
  full client binary, guaranteeing the approved default server even when Mission Control was started
  inside a named Herdr session.
- `rename` and `kill` address the workspace ID, never its display label.
- Use `PLAIN_NAMES` unless live stable-Herdr verification proves a stricter label grammar. Do not
  invent restrictions from tmux.

### 5. Register Herdr and audit generic consumers

Append `herdr` to `MULTIPLEXER_IDS` between `tmux` and `cmux`, and update the ordering comment in
`src/shared/terminal.ts`. Add `herdrMultiplexer(exec)` to the exhaustive record in
`src/server/terminal/registry.ts`.

Fix compile-time inventory failures without weakening record types:

- update `test/helpers/terminal-fakes.ts` so every test registry has an explicit third multiplexer;
- update hand-built terminal maps, snapshots, expected target counts, request-schema cases, setup
  tests, home ordering tests, and name-source serialization tests;
- keep browser components consuming `TerminalTargetView` and shared IDs with no Herdr conditionals;
- verify an installed but stopped Herdr is launchable because workspace creation can start it,
  while passive enumeration and existing-target operations remain empty or refuse without starting;
- verify missing Herdr costs only the existing `binPresent` filesystem probe.

No migration is expected. If investigation reveals persisted terminal-backend configuration rather
than request-only values, document its downgrade behavior and add the narrow compatibility handling
at the existing owner instead of introducing Herdr storage.

### 6. Add transport and adapter tests

Create `test/herdr-client.test.ts` with fake Unix socket servers and injected process seams. Cover:

- newline framing, partial chunks, several responses in one chunk, and response order independent
  from request order;
- unique and matching IDs, duplicate or unknown IDs, truncated JSON, schema violations, size bounds,
  deadlines, and socket close;
- a non-responsive server and an unterminated partial line, asserting every operation settles, every
  pending request settles exactly once, timers and listeners are cleared, the socket is destroyed,
  and late responses are ignored;
- read degradation versus exact mutation `outcomeUnknown` classification before and after request
  write, including malformed, duplicate-ID, unknown-ID, and schema-mismatched mutation responses;
- compatible running server reuse, stopped-server start and poll, concurrent starter race,
  startup timeout, and incompatible server refusal;
- one socket batch for snapshot plus per-pane process info;
- cleanup of every fake socket and child seam.

Create `test/herdr-adapter.test.ts` and cover:

- multiple workspaces, tabs, and panes mapped to stable addresses and display names;
- null tty with preserved shell PID and cwd fallback;
- all shared key names, raw text, bracket-aware paste, capture, and documented agent focus;
- default-session environment isolation on every CLI and server start;
- workspace creation with exact cwd and both selection intents, shell-safe argv, optional same-cwd
  no-focus side split, confirmed-refusal rollback, uncertain-delivery preservation, rename, close,
  and attach argv;
- `clients: null`, `paneMode: null`, plain name rules, label, glyph, binary override, and registry
  completeness.

Extend existing registry, enumeration, correlation, home, target, focus-composition, setup, HTTP,
and shared-protocol tests where Herdr changes an exhaustive result. Keep every unit test independent
from an installed Herdr binary.

### 7. Add built-dashboard E2E coverage

Extend `e2e/fixtures/fake-agents.ts` and `e2e/fixtures/daemon.ts` with a controlled fake Herdr binary
and record format. The fake must answer status, emulate the bounded socket protocol or a test-only
injected endpoint, record workspace and pane operations, and never start a real server or agent.
Make fixture installation explicit so unrelated E2E tests remain cmux-first and deterministic.

Add `e2e/specs/herdr-multiplexer.spec.ts` against the built dashboard. It must prove user-visible
consequences through roles, labels, and text, with no `data-testid`:

- Herdr appears in the terminal chooser in registry order with an accurate availability sentence.
- Choosing Herdr for a shell launches in the exact worktree cwd and records `select: true`.
- The success state is visible, and an incompatible fake status produces an actionable visible
  refusal rather than a silent menu close.
- A discovered Herdr-shaped agent session can use Focus: the adapter records internal agent focus,
  and generic focus hands the full-client attach argv to the fake emulator path because
  `clients: null`.
- Repeated focus never records direct attach or takeover.

Use existing fake agent binaries for any resumed conversation and assert that no real agent command
or Herdr server was launched. If the spec opens a modal, apply the repository's modal inset helper;
otherwise do not add unrelated geometry coverage.

### 8. Document and verify the supported boundary

Update `README.md` and `docs/harnesses-and-terminals.md` to state:

- Herdr is a supported multiplexer through the same adapter registry as tmux and cmux;
- the supported stable compatibility floor and `HERDR_BIN` override;
- v1 controls only the default local Herdr server session;
- Mission Control supports create, discover, write, paste, capture, internal focus, rename, close,
  detach, and reattach;
- stable Herdr exposes no client tty list, so Focus may open another normal client when no existing
  host can be raised;
- Mission Control never uses direct-attach takeover;
- normal client detach keeps pane processes, while a full server stop is not process persistence.

Perform a live verification with the supported stable Herdr release in a disposable workspace. Prove
workspace creation, discovery through PID ancestry, multiline paste without submission, capture,
internal focus, rename, detach/reattach, and close. Keep screenshots, records, and transcripts in a
gitignored evidence location and attach them to the implementation pull request.

## Data, API, migration, and compatibility details

- Adding `herdr` widens registry-derived request schemas and `NameSource`. Update every type-driven
  parser and test together; do not add handwritten parallel enums.
- `MuxHandle` is unchanged. Herdr workspace ID remains `session`, label remains `sessionName`, and the
  next discovery sweep is authoritative.
- No SQLite table, column, or migration is added.
- The adapter speaks only the validated stable protocol reported compatible by Herdr status. Additive
  response fields are tolerated; missing or changed consumed fields are rejected.
- Default namespace isolation is explicit on CLI probes, server startup, and full-client attach.
- Passive discovery and existing-target operations are non-starting. All server startup is owned by
  workspace creation readiness.
- Unknown mutation outcomes are preserved through `TerminalResult`; no caller retries or cleans up an
  operation that may have landed.
- Rollback to an older Mission Control binary cannot understand a live `herdr` wire value. The plan
  adds no persisted default selecting Herdr, so the implementation must avoid writing such a default
  outside existing explicit operator choices and document any persisted setting discovered during
  implementation.

## Tests and verification

Run the new focused tests with the required preload:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/herdr-client.test.ts \
  test/herdr-adapter.test.ts \
  test/correlate.test.ts \
  test/terminal-enumerate.test.ts \
  test/terminal-registry.test.ts \
  test/terminal-home.test.ts \
  test/terminal-target-contract.test.ts \
  test/session-launch-http.test.ts
```

Then run all required gates:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Finally run the disposable live stable-Herdr verification described above. Record exact installed
Herdr version and compatibility status in the pull request evidence, not in committed proof files.

## Merge and exit criteria

- All focused, repository-wide, build, smoke, and E2E gates pass.
- The live disposable verification passes without leaving a Herdr server, workspace, or agent.
- `MULTIPLEXER_IDS` is exactly ordered `tmux`, `herdr`, `cmux`; every exhaustive registry and request
  schema admits the same ID.
- Herdr discovery uses one bounded socket batch and never starts a stopped server.
- Every terminal socket failure settles pending requests once, clears timers and listeners, destroys
  the socket, and ignores late responses.
- Every mutation response, framing, correlation, or validation failure after request write preserves
  `outcomeUnknown: true`; only pre-write failures and parsed application refusals are confirmed.
- Null tty panes bind only through Phase 1's exact PID ancestry.
- Background dispatch records `select: false`; operator launch records `select: true`.
- Workspace creation and any requested side split receive the exact worktree cwd from the launch
  specification.
- Pane I/O, safe paste, capture, documented agent focus, create, rename, close, and full-client attach
  are covered by fake-only automated tests.
- `clients` and `paneMode` remain explicit null capabilities.
- No direct attach takeover, named-server scope, vendor branch outside the adapter, new persistence,
  real-agent E2E spend, committed evidence, generated-file edit, or `CHANGELOG.md` edit lands.
- README and terminal documentation match the shipped compatibility and limitations.
- README and terminal documentation state the initial POSIX-only boundary and do not imply Windows
  named-pipe or environment-scrubbing support.

## Downstream handoff

This is the final implementation phase. Later terminal adapters may reuse the bounded socket-client
patterns, PID-ancestry key, and creation selection intent, but they must not broaden Herdr namespace
identity or outward-focus semantics without a new approved plan.

Release and support work may rely on Herdr being represented only by the existing shared terminal ID,
generic `MuxHandle`, and adapter capabilities. A future Herdr client-list API can implement
`clients()` without changing focus callers. Named Herdr server support remains separate product and
identity work.

## Cross-phase audit record

- Entry audit: every generic behavior this phase consumes is owned by Phase 1. This phase does not
  duplicate or weaken its correlation or selection contracts.
- Ownership audit: this phase alone owns the Herdr client, adapter, registry entry, fake, E2E spec,
  user-visible availability, and documentation.
- Compatibility audit: Herdr remains behind `Multiplexer`; shared wire shapes widen only through the
  source ID tuple; no persistence migration or second source of truth is introduced.
- Reconciliation audit: current spawn contracts required the namespace-scrubbing attach wrapper,
  target-liveness semantics required narrowing server auto-start to workspace creation, and terminal
  launch correctness required carrying `spec.cwd` into workspace creation and any side split.
  Review also made terminal-failure settlement, post-write mutation uncertainty, and the POSIX-only
  platform boundary explicit. These corrections are owned here and are reflected in the root plan
  and phased index.
- Final audit: the approved socket architecture, default-session scope, new-client focus fallback,
  validation bar, and explicit exclusions are all represented in implementation steps and exit
  criteria.
