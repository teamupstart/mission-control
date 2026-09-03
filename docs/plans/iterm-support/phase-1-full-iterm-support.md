# Phase 1: Full iTerm2 Support

Parent plan: [Full iTerm Support](plan.md)

Phase index: [phased-plan.md](phased-plan.md)

## Outcome

Mission Control supports iTerm2 as a first-class terminal emulator from end to end. Operators can discover, name, write to, paste prompts into, capture, focus, spawn, and retitle iTerm2 sessions; compose iTerm2 with tmux; bind terminal hooks by `ITERM_SESSION_ID`; see setup and launch choices; and recover from macOS Automation failures without affecting other terminal backends.

This phase document is the proposed implementation route, not a substitute for repository truth. Follow it where the repository agrees, use engineering judgment where it does not or where a better implementation is available, and record material deviations and their reasoning in the implementation pull request. The approved outcome and compatibility contracts remain fixed.

## Entry Criteria and Dependencies

- The planning pull request containing `plan.md`, `phased-plan.md`, and this file is merged to the default branch.
- The implementer has read `AGENTS.md`, `docs/README.md`, `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`, `docs/ensembles.md`, and `e2e/README.md`.
- No implementation phase precedes this one.
- The existing terminal registry, hook, setup, build, and browser suites pass at the starting revision, or any base-branch failure is identified before feature work.
- Live macOS acceptance has access to an iTerm2 installation and an operator who can respond to Automation permission prompts. Automated adapter tests must remain hermetic and must not launch or control the operator's real application.

## Scope

- Append and register the `iterm` terminal backend and setup dependency.
- Add filesystem-only iTerm2 availability detection and host-process-gated enumeration.
- Implement list, text, keys, bracketed paste, capture, pane-level focus, new-window spawn, and tab retitle capabilities.
- Correlate iTerm2 to processes and tmux clients by normalized TTY.
- Capture and bind `ITERM_SESSION_ID`, including the exact identity-normalization contract proven against a live session.
- Remove inherited iTerm2 identity from every daemon-owned SDK, one-shot, and headless agent launch path.
- Expose setup status, installation remedy, and launch targeting through existing registry-driven surfaces.
- Add unit, route, Playwright, live macOS, and packaged-app verification.
- Update terminal, session, setup, and configuration documentation.

## Non-Goals

- Replacing or widening the terminal emulator abstraction beyond what verified iTerm2 behavior requires.
- iTerm2 profile administration, badges, triggers, shell-integration installation, Python API plugins, or a resident helper.
- Changing existing automatic emulator priority or default terminal selections.
- Adding a database migration, feature flag, background worker, browser-side vendor branch, or second terminal registry.
- Editing archived mockups, historical plans, generated files, `CHANGELOG.md`, CI, signing, release, or deployment configuration without a separately reviewed, evidence-backed scope expansion.
- Changing Ghostty transport or runtime behavior while extracting a shared AppleScript quoting helper.

## Repository Findings and Inherited Contracts

### Stable registries

`src/shared/terminal.ts` declares `EMULATOR_IDS` and derives terminal backend schemas from it. `src/server/terminal/registry.ts` uses `Record<EmulatorId, TerminalEmulator>`, so appending an ID forces a complete adapter at typecheck. Append `iterm` after `ghostty`; do not reorder existing IDs.

`src/shared/setup-catalog.ts` is also append-only and its info record is key-order tested. Append the `iterm` dependency at the absolute end even though that breaks physical family contiguity. `setupChecksView` already performs family-first projection, so update the test to pin rendered grouping instead of mutating the durable identity order.

### Adapter contract

`TerminalEmulator` already owns availability, enumeration, write, capture, focus, spawn, retitle, and naming. `TerminalExec` supports an `input` option for standard input. Reuse these contracts and their `TerminalResult` uncertainty semantics. Do not expose AppleScript exit codes or application objects above the adapter.

`EmulatorPane.paneId` is the action target and `tty` is the strong correlation key. Use iTerm2's session `unique ID` and TTY. A tab index may help describe the containing tab but cannot be the durable target because it changes when tabs move or close.

### No-auto-launch boundary

`enumerateTerminals` skips an emulator list call when its declared host process is not running. Declare `hostProcess.commands = ["iTerm2"]`. Do not add a private System Events liveness probe or call AppleScript during availability checks. The application bundle proves installation; the process snapshot proves whether passive enumeration is safe.

### Session binding boundary

`captureTerminalEnv`, `EnvSchema`, and `overlayKeyFromEnv` are the intended vendor-specific edge for terminal-provided pane variables. Add optional `itermSession` sourced from `ITERM_SESSION_ID`. Preserve current precedence: tmux first, WezTerm second, iTerm2 third. The discovered session and hook payload must produce an identical backend pane token.

Claude SDK environment construction is shared with the Codex SDK, while Claude and Codex one-shot runners have their own headless environment helpers. Extend every existing terminal-identity scrub and its comments and tests. Do not broaden this into general environment filtering.

### User surfaces

Setup checks, terminal target views, settings controls, launch routes, focus, rename, prompt injection, and tmux composition already operate over registry capabilities. New React conditionals are a warning that a shared registry or capability was bypassed. Add user-visible Playwright coverage even when the production React diff is zero.

## Ordered Implementation Steps

### 1. Pin the live iTerm2 scripting contract

Before changing behavior, validate the installed application at the same boundary an operator experiences:

- read the installed scripting dictionary and record the actual bundle ID, GUI process basename, window/tab/session hierarchy, writable title property, session unique ID, TTY, content property, session selection, text write, and create-window command;
- in a disposable iTerm2 session, compare raw `ITERM_SESSION_ID` to the AppleScript session unique ID and establish one exact normalization rule only if they differ;
- record raw PTY bytes for literal text, newline, Enter, Escape, arrows, Tab, Shift-Tab, control keys required by `Key`, and multi-line bracketed paste;
- verify whether `write text ... newline no` preserves control characters and embedded newlines as required, rather than assuming behavior from the dictionary;
- exercise first-use Automation approval and denial without changing global permissions beyond the operator's explicit interaction.

Keep screenshots and transcripts in a gitignored evidence location and attach relevant proof to the implementation pull request. Do not commit operator data or evidence artifacts.

If the live contract contradicts the source plan, keep the approved capability outcome, adapt the implementation behind `TerminalEmulator`, and explain the deviation. Escalate only if iTerm2 cannot safely provide an approved capability.

### 2. Extend IDs, binary resolution, and exhaustive registries

Update the shared and server terminal seams:

- append `iterm` to `EMULATOR_IDS` in `src/shared/terminal.ts`;
- add an `ITERM_BIN` `BinSpec` in `src/server/terminal/bin.ts` with `ITERM_BIN` override, the standard `/Applications/iTerm.app/Contents/MacOS/iTerm2` candidate, and no PATH fallback that could confuse the GUI bundle with an unrelated executable;
- document that `hostProcess` also gates application-addressed enumeration to prevent auto-launch, while retaining its correlation role for backends without TTYs;
- import and register `itermEmulator(exec)` in the exhaustive `emulators()` record;
- extend `test/helpers/terminal-fakes.ts` and any exact test registries with an explicit iTerm2 fake rather than an unsafe default;
- pin registry order, binary override, stale override, absent application, and host-process-gate behavior in focused tests.

Do not cache installation state. An operator who installs iTerm2 or changes `ITERM_BIN` should not need to restart the daemon.

### 3. Implement the iTerm2 adapter

Add `src/server/terminal/iterm.ts`. Extract a neutral `src/server/terminal/applescript.ts` quoting helper only if it reduces duplication without changing Ghostty behavior. Preserve existing Ghostty exports used by tests, or update those imports deliberately.

Use bundle ID `com.googlecode.iterm2` if live validation confirms it. Invoke fixed `/usr/bin/osascript` with script source on standard input and bounded timeouts. Do not place generated scripts, prompt bodies, working directories, or user-authored text in argv. Use existing `shellCommand` or an equally shared quoting primitive to preserve argv boundaries when iTerm2's launch API accepts one shell command.

Implement enumeration in one application call:

- traverse every window, tab, and session;
- emit a delimiter-safe record format that rejects malformed records instead of shifting fields;
- set `paneId` to the session unique ID;
- derive `isActive` from the current window/tab/session hierarchy;
- normalize the session TTY through the existing TTY helper;
- use the tab title for `tabTitle` and the window name for `windowTitle`;
- query the session `path` variable or verified equivalent for `cwd`, returning null when shell integration does not provide it;
- return an empty list on expected application, permission, timeout, or parse failures so one backend cannot break global discovery.

All mutations must locate a session by exact unique ID by walking application windows and tabs. Never silently select a similarly titled or currently active session when a target is stale.

Implement the capability surface:

- `write.text` preserves the shared literal typing contract, with embedded newlines producing submissions exactly as verified;
- `write.keys` provides an exhaustive `Record<Key, ...>` and emits the verified byte or AppleScript action for every shared key;
- `write.paste` sends one bracketed-paste sequence around the complete prompt body and preserves an unknown outcome on timeout;
- `capture` reads visible session contents without clipboard mutation or selection side effects;
- `focus.raise` selects the session and containing tab/window, then activates iTerm2, with `granularity: "pane"`;
- `spawn.tab` honors nullable working directory, safely executes the requested argv in a new window, applies the requested title, and returns the new session target;
- `retitle` sets the title of the tab containing the exact session;
- `names` uses the existing plain naming rules unless live iTerm2 validation proves a real restriction.

Add `test/terminal-iterm.test.ts` around a fake `TerminalExec`. Cover script transport, quoting, record parsing, identity, TTY and working-directory normalization, active state, target traversal, literal input, every key, multi-line and long paste, capture, focus, spawn, retitle, stale targets, denied permission, malformed output, nonzero exits, and timeouts. Assert sensitive or long payloads are in `opts.input` and absent from argv.

Extend generic terminal tests where they prove integration rather than adapter syntax:

- `test/terminal-enumerate.test.ts` for installation, process gating, order, and failure isolation;
- `test/correlate.test.ts` for strong TTY matching, iTerm2 naming, and tmux host joins;
- `test/terminal-registry.test.ts`, `test/terminal-target-contract.test.ts`, `test/session-terminals.test.ts`, and route tests for exhaustive IDs, priority, capabilities, and target payloads;
- focus, rename, capture, and prompt-injection tests only where existing generic behavior needs an iTerm2 fixture to prevent vendor regression.

### 4. Add hook identity and prevent inherited-pane impersonation

Update the narrow environment edge:

- add optional `itermSession` to `EnvSchema` in `src/shared/protocol.ts`;
- return it from `captureTerminalEnv()` in `src/shared/harness-runtime.mjs` using `ITERM_SESSION_ID`;
- add an iTerm2 token helper or use `backendPaneToken("iterm", ...)` consistently in `src/shared/pane.ts` and `src/server/registry.ts`;
- extend `overlayKeyFromEnv` with iTerm2 after tmux and WezTerm so nested tmux continues to own the innermost pane;
- centralize any verified formatting conversion between the environment value and AppleScript unique ID, reject empty or ambiguous values, and use that same function on both sides of the comparison.

Add `ITERM_SESSION_ID` deletion alongside existing pane variables in:

- `src/server/harness/claude/sdk-deps.ts`, which also protects the Codex SDK path;
- `src/server/claude-cli.ts` for Claude one-shot/headless runs;
- `src/server/llm/codex.ts` for Codex headless runs;
- any other production launch environment found by the implementation-time search for `TMUX_PANE` and `WEZTERM_PANE`.

Update hook, pane-token, Claude SDK, headless CLI, LLM runner, review-orphan, and fake-agent tests. Extend `e2e/fixtures/fake-claude.mjs`, `e2e/fixtures/daemon.ts`, and `e2e/specs/dispatch-and-converse.spec.ts` so the fake records an inherited iTerm2 identity and the browser scenario proves the daemon's value never reaches the agent process.

The optional schema field must preserve compatibility with older hooks and stored event bodies. Do not make `termProgram` part of pane identity.

### 5. Integrate setup, launch UI, and deterministic browser coverage

Append the setup contract:

- append `iterm` to `SETUP_DEPENDENCY_IDS` and to the matching `SETUP_DEPENDENCY_INFO` key order;
- label it `iTerm2`, mark it optional in the terminal family, describe the terminal capability it enables, and assign the daemon-owned remedy `brew install --cask iterm2`;
- add an exhaustive setup probe using the same terminal availability contract as launch targeting;
- replace the test that assumes physical family contiguity with one that asserts `setupChecksView` renders correct family grouping while stable IDs remain append-only;
- extend setup probe and installation route tests so the browser never supplies command argv, cwd, or display text.

Keep settings and launch rendering registry-driven. Update fixture factories and `e2e/fixtures/daemon.ts` with an absent `ITERM_BIN` default so unrelated tests do not depend on a developer's applications.

Add or extend Playwright scenarios in the most focused existing specs:

- the Setup panel shows `iTerm2`, Missing status, optional meaning, and `brew install --cask iterm2` remedy;
- a deterministic `/api/terminal-targets` response containing iTerm2 produces an accessible launch choice;
- selecting it posts backend `iterm` through the existing route and renders success or failure feedback;
- selectors use role, label, placeholder, or visible text, never `data-testid`;
- inspect the built UI at desktop and narrow widths for row alignment, wrapping, focus, feedback placement, and absence of horizontal overflow.

If the UI requires a production React branch to pass this scenario, stop and first confirm why the shared registry projection is insufficient.

### 6. Update documentation and complete acceptance

Update the current documentation surfaces that enumerate supported terminals or configuration, including `docs/sessions.md`, `docs/configuration.md`, `docs/overview.md`, and `docs/harnesses-and-terminals.md` where applicable.

Document:

- the supported iTerm2 capability set and tmux composition;
- `ITERM_BIN` and standard app detection;
- passive discovery versus explicit launch;
- the macOS Automation prompt, denial symptoms, retry, and System Settings revocation path;
- best-effort working directory when iTerm2 shell integration does not publish `path`;
- failure isolation from other terminals.

Do not edit archived mockups or historical plans that correctly reflect their original date.

## Data, API, and Compatibility Details

- **Persisted data:** no schema or migration. `iterm` is an appended enum value accepted anywhere terminal backend schemas derive from the registry.
- **Hook payload:** `env.itermSession` is optional. Old producers and old event rows remain valid.
- **Backend order:** WezTerm, Ghostty, then iTerm2. Existing automatic choices remain stable.
- **Setup order:** `iterm` is appended to the durable ID tuple; family grouping remains a projection.
- **Session identity:** AppleScript session unique ID is the action key and must match the hook token after one shared normalization step.
- **Working directory:** absent path data becomes null, never an invented directory.
- **Action failure:** denied permission, stale targets, and definite non-delivery return actionable failures. Timeouts preserve `outcomeUnknown` where a write may have landed.
- **Discovery failure:** malformed or unavailable iTerm2 data yields no iTerm2 panes while other backends continue.
- **Security:** browser payloads stay declarative; the daemon owns install commands, AppleScript source, target lookup, quoting, timeouts, and subprocess environment.
- **Packaging:** no entitlement or release change is planned. If packaged validation proves a requirement, document the evidence and seek review before expanding controlled configuration.

## Verification Commands

Run focused tests with the repository preload while iterating. Use the actual files changed; this is the expected command set:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/terminal-iterm.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/terminal-enumerate.test.ts test/terminal-registry.test.ts test/terminal-target-contract.test.ts test/correlate.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/hooks.test.ts test/claude-sdk-adapter.test.ts test/claude-cli-headless-env.test.ts test/llm-runner-contract.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/setup-catalog.test.ts test/setup-probes.test.ts test/setup-install-route.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/setup-panel.spec.ts e2e/specs/settings-conductor.spec.ts e2e/specs/dispatch-and-converse.spec.ts
npm run test:e2e
```

If a named test file differs at implementation time, choose the current focused owner rather than creating a duplicate suite. Build must succeed before smoke and Playwright. On macOS under the Codex seatbelt, use the repository-prescribed scoped outside-sandbox approval for Electron-backed tests. Never bypass the preflight or add Chromium sandbox flags.

## Live macOS Acceptance

Use a disposable worktree and shell session, with no model invocation:

1. Close iTerm2 and prove setup checks, terminal target discovery, and enumeration leave it closed.
2. Explicitly launch an iTerm2 target and exercise first-use Automation approval. Repeat with denial and after revocation to verify actionable, backend-local failures.
3. Create multiple windows, tabs, and split sessions. Verify stable unique IDs, TTYs, tab titles, active state, best-effort working directories, and correct session-to-process correlation.
4. Send literal text and every shared key to a raw-byte recorder. Verify long and multi-line bracketed paste arrives once, preserves content, and does not hit argv limits.
5. Capture a normal shell and a full-screen TUI without clipboard mutation. Focus each split precisely and verify stale targets never focus a neighbor.
6. Retitle a tab and confirm both iTerm2 and the next enumeration show the new value.
7. Spawn a titled window into a path containing spaces and shell metacharacters. Verify cwd and argv boundaries and confirm no command injection.
8. Run tmux inside iTerm2. Verify Mission Control focuses an attached client, retitles the host tab where applicable, and opens a fallback attach window when no client exists.
9. Repeat discovery, focus, paste, retitle, and spawn from the packaged Electron app to expose any Automation or packaging difference.

Attach screenshots and concise transcripts to the pull request from a gitignored evidence directory. Do not commit them.

## Merge and Exit Criteria

- Every capability and failure behavior in `plan.md` is implemented or an evidence-backed deviation is explicitly approved.
- `iterm` and its setup dependency are appended without moving existing IDs or changing emulator precedence.
- Passive checks never launch a closed iTerm2.
- Adapter tests pin safe standard-input transport, exact target selection, complete key and paste behavior, capture, focus, spawn, retitle, and failure semantics.
- Hook tests prove exact iTerm2 binding, tmux precedence, older-payload compatibility, and removal of inherited identity from every daemon-owned agent launch mode.
- Setup and launch behavior are registry-driven and covered in the built dashboard without model spend or `data-testid`.
- Typecheck, lint, full unit suite, build, smoke, focused Playwright, and full Playwright are green.
- Live and packaged macOS acceptance passes, including permission denial and revoked-permission recovery.
- Current documentation matches the shipped support and configuration surface.
- No operator data, credentials, generated outputs, evidence artifacts, unrelated changes, or controlled release configuration enters the diff.
- The implementation pull request records any route changes from this proposed phase plan and includes proof-of-work links or attachments.

## Downstream Handoff

There is no later implementation phase. Once this phase merges, all shared consumers may rely on `iterm` as a complete `TerminalEmulator` backend with optional hook identity and the same capability-null semantics as other emulators.

Future iTerm2-only features such as profiles, badges, triggers, or Python API plugins require a new plan. Do not grow those concerns into this adapter or treat AppleScript maintenance status alone as permission to add a resident helper.

## Cross-Phase Audit Record

Audit completed on 2026-09-03 against the approved root plan and phased index:

- one phase owns every source-plan requirement, so there is no duplicate or missing phase responsibility;
- adapter registration, hook binding, setup visibility, browser evidence, and documentation merge together, preventing a temporarily selectable or undocumented partial backend;
- stable ID and optional-schema changes are additive and compatible with the current default branch;
- target identity, process gating, subprocess transport, environment scrubbing, and failure isolation all use existing owners rather than parallel mechanisms;
- no later cleanup or migration phase is required for repository operability;
- final behavior matches the approved root plan after this one merge.
