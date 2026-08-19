# Phase 1: Native macOS assertion provider

## Outcome

Mission Control's Keep Awake switch holds a daemon-owned macOS IOKit assertion instead of
spawning `/usr/bin/caffeinate`. The display continues to dim, turn off, and lock normally while
user-idle system sleep is inhibited. Every existing launch mode, live status path, transient
lifecycle, and safety boundary remains intact.

## Entry criteria and direct dependency

- The planning PR containing `docs/plans/keep-awake-native-provider/plan.md`,
  `phased-plan.md`, their HTML renderings, and this phase file is merged to the default branch.
- Read those three Markdown files, `AGENTS.md`, `docs/agent-guides/architecture.md`, and
  `docs/agent-guides/change-contracts.md` before editing.
- Reconfirm the current Keep Awake implementation and package scripts. The file-level route below
  is proposed, not a specification; adapt it if the repository has changed while preserving the
  fixed outcome and contracts.

No other implementation phase is a prerequisite.

## Scope

- A Darwin-only raw Node-API addon that creates and releases
  `kIOPMAssertionTypePreventUserIdleSystemSleep`.
- A daemon provider abstraction with native IOKit as the macOS production default.
- Retention of the explicit command-provider override for Linux-safe unit and browser tests.
- Native build, copy, bundle loading, Electron packaging, smoke checks, and clear failure behavior.
- Focused unit and integration coverage plus existing Keep Awake end-to-end coverage.
- Updated product documentation and a revised real-macOS verification runbook.

## Non-goals

- UI, route, SSE event-name, or database changes beyond appending the live provider identifier.
- Display-sleep inhibition, synthetic user activity, silent audio, `pmset noidle`, or another
  process-based fallback.
- Persistence, automatic restart enablement, automatic provider retry, or coupling to Away mode.
- Electron `powerSaveBlocker` ownership or daemon-to-Electron IPC.
- Windows or Linux production providers.
- Remote execution architecture.
- Changes to signing, release, CI, or deployment policy beyond what is strictly required to ship
  and verify the addon. Do not broaden those surfaces speculatively.

## Repository findings and inherited contracts

### One owner and one truth path

`src/server/index.ts` constructs one `KeepAwakeManager`, seeds Registry before serving, and stops
the manager during ordered shutdown. Keep that owner. Routes call the manager, Registry publishes
its observations, and browsers reduce snapshot plus `keep_awake_status`. Do not add Electron IPC,
browser polling, or a second assertion owner.

### Existing transition semantics

The manager serializes every transition, makes repeated requests idempotent, bounds external error
text, and refuses to claim `on` before observing provider success. Preserve those behaviors while
separating provider mechanics from manager state. A release failure must retain the native handle
and report `error`, allowing an explicit later disable to retry rather than forgetting an assertion
that may still be active.

### Runtime and package boundary

The same server bundle runs under standalone Node 24+ and Electron 43's Node 24 utility process.
Use stable raw Node-API only. esbuild cannot inline a `.node` binary, while electron-builder already
ships `dist/**/*`; the native build must place the artifact at a deterministic path outside the
server bundle. Importing the addon must not create an assertion.

### CI and browser coverage

CI and Playwright run on Linux. `MISSION_KEEP_AWAKE_BIN` currently redirects the built daemon to a
fake process that records start and exit. Preserve this explicit override as a command-provider
test seam. Without it, non-Darwin hosts remain unsupported and never compile or call IOKit.

### Live provider vocabulary

`KeepAwakeStatus.provider` is not persisted, but it crosses the snapshot and SSE wire. Append
`"iokit"`; retain `"caffeinate"` for the explicit command fixture. Do not rename the existing value
or branch React behavior on it.

## Implementation steps

### 1. Add a minimal side-effect-free Node-API addon

Create a narrow native source directory, expected at `native/keep-awake/`, with Objective-C++ and a
`binding.gyp` target that links IOKit and CoreFoundation only on Darwin.

Use raw Node-API rather than V8, NAN, or an Electron-specific ABI. Expose a typed JavaScript surface
equivalent to:

```ts
interface NativeKeepAwakeBinding {
  create(reason: string): unknown;
  release(handle: unknown): void;
}
```

Requirements:

- `create` validates a non-empty bounded UTF-8 reason, calls `IOPMAssertionCreateWithName` with
  `kIOPMAssertionTypePreventUserIdleSystemSleep` and `kIOPMAssertionLevelOn`, and returns an opaque
  handle only on `kIOReturnSuccess`.
- The handle owns exactly one `IOPMAssertionID`. `release` calls `IOPMAssertionRelease` exactly once
  and marks the handle inactive only on success.
- A native finalizer releases an accidentally abandoned active handle as a leak backstop. Normal
  enable/disable and shutdown paths remain explicit and testable.
- IOKit failures become JavaScript errors containing a stable operation name and numeric return
  code, with no unbounded OS text.
- Module initialization registers functions only. It never creates a power assertion.
- Do not add display, user-activity, AC-only, or system-wide forced-sleep assertion types.

Pin the Node-API version in the build rather than accepting an accidental host default. Keep the
native code small enough to audit as the complete privileged-power boundary.

### 2. Make native build and loading explicit

Add `node-gyp` as a direct development dependency and update the lockfile. Add a checked-in build
script that:

- exits successfully with a clear skip message on non-Darwin hosts;
- invokes the repository's declared `node-gyp` on Darwin with the active Node 24 headers;
- fails loudly on compiler, SDK, architecture, or copy errors;
- copies the resulting binary to `dist/native/keep-awake.node`; and
- supports the current macOS arm64 package target without pretending to produce another
  architecture.

Wire the script into `npm run build` before the server bundle is smoked, and into daemon development
and `npm start` before the source server loads the binding. Avoid `postinstall`: this repository
deliberately keeps some machine downloads out of install, and a native compile should occur only
when starting or building the relevant runtime.

Add a typed loader, expected near `src/server/keep-awake-native.ts`, that uses `createRequire` and a
path derived from `import.meta.url` to load `dist/native/keep-awake.node` from both source and bundled
execution. Validate the export shape before advertising support. Bound load errors before they can
reach SSE.

Update `electron-builder.yml` comments to state that `dist/**/*` includes one native addon in
addition to bundled JavaScript. Do not enable `asar`, add broad entitlements, or ship `node_modules`.

### 3. Extract the provider contract and select it once

Refactor `src/server/keep-awake.ts` so `KeepAwakeManager` owns state and serialization while an
injected provider owns assertion mechanics. A suitable contract has a stable provider id and
start/release operations; the exact type shape is implementation judgment.

Production resolution order is fixed:

1. If `MISSION_KEEP_AWAKE_BIN` is explicitly set, construct the existing command provider for
   tests on any platform.
2. Otherwise, on Darwin, load and construct the native IOKit provider.
3. Otherwise, report unsupported.

Never fall back to the command provider when native load or IOKit creation fails. That would hide
the policy signal this replacement is meant to evaluate.

Preserve:

- one serialized transition queue;
- idempotent double enable and double disable;
- `starting`, `on`, `stopping`, `off`, and `error` observations;
- `since` set only after successful assertion creation;
- bounded error strings;
- orderly shutdown through `stop()`; and
- the command provider's unexpected-exit and bounded SIGTERM/SIGKILL behavior for the test fixture.

For the native provider, retain the active handle until release succeeds. A create error leaves no
handle. A release error remains visible and retryable. A process crash needs no JavaScript cleanup
because IOKit assertion ownership is process-scoped.

Append `"iokit"` to `KeepAwakeStatus.provider` in `src/shared/types.ts` and rewrite child-specific
comments to describe an OS assertion. Update Registry and render fixtures only where their exact
provider value requires it; do not change UI output.

### 4. Prove source, bundle, and package behavior

Rewrite `test/keep-awake.test.ts` around fake providers while keeping command-provider cases that pin
the explicit override's exact `-i -w <daemon PID>` arguments. Add cases for:

- Darwin selecting IOKit when no override exists;
- override precedence on Darwin and Linux;
- native addon load failure producing unavailable rather than fallback;
- native create success and failure;
- native release success, failure, retained-handle retry, and idempotence;
- serialized opposite requests;
- bounded load and I/O errors;
- shutdown release; and
- unsupported platforms doing nothing.

Keep real IOKit out of `npm test`. If the native functions benefit from a direct integration probe,
make it an explicit Darwin-only manual script that holds the assertion for a short bounded window
and always releases it in `finally`; do not add it to ordinary CI.

Update `scripts/smoke-bundles.mjs` so Darwin builds prove the expected `.node` artifact exists,
loads, and exposes the validated function shape without calling `create`. Linux smoke proves the
intentional skip. Ensure the normal daemon smoke still starts and stops without enabling Keep Awake.

Keep `e2e/specs/keep-awake.spec.ts` on the fake command provider. Update names and comments that claim
production always uses `caffeinate`, but preserve the full click, route, SSE, multi-window, crash,
restart, and topbar assertions. Since the UI contract is unchanged, this is an update to the
existing required UI spec, not a second duplicate spec.

Run package verification on macOS arm64. Confirm the addon is inside the app bundle, is covered by
the package's signing behavior, and loads from the Electron utility process. A source-only success
is not enough.

### 5. Update the operator contract and obtain the real receipt

Update `docs/sessions.md` and `docs/runbooks/keep-awake.md` in the same change:

- replace the exact `caffeinate` command with a named daemon-owned
  `PreventUserIdleSystemSleep` assertion;
- retain the lock-screen, battery, lid-close, manual Sleep, transient lifecycle, and no-retry
  promises;
- change process checks to verify the daemon owns the assertion and no `caffeinate -i -w` child
  exists;
- preserve disable, crash, and restart receipts; and
- document that a denied native assertion is a visible failure, not a trigger for fallback.

On the managed Mac, align with the endpoint-management owner before treating the alternative as
approved. Then perform the runbook against a packaged build and standalone/adopted daemon paths.
Capture:

1. the IOKit success and `pmset -g assertions` owner/type while on;
2. normal display lock plus continuing non-destructive work;
3. disappearance after disable;
4. disappearance after an abrupt daemon death;
5. off after restart;
6. absence of a `caffeinate` child; and
7. any endpoint denial or policy statement.

Evidence belongs in the pull request, not in committed repository files.

## Data, API, migration, and compatibility

- No database or config write is added. There is no migration, backfill, or startup restore.
- `provider: "iokit"` is an append-only live-wire value. Existing event and route names do not
  change.
- The explicit `caffeinate` provider identifier remains valid for the test command override.
- The native binary is a build artifact, not a source of durable state. It must be reproduced by
  the build and never hand-edited.
- Node-API supplies ABI stability across the supported Node 24 hosts; build and package checks still
  prove the actual artifact path and architecture.
- A daemon downgrade cannot inherit a stale native assertion because the prior process owns and
  loses it on exit.
- Older browsers continue to render the same status because they do not branch on provider id.

## Verification commands

Use the repository's required test preload for focused unit runs:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/keep-awake.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/keep-awake-http.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/keep-awake-sse.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/keep-awake-render.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/keep-awake.spec.ts
npm run package
```

On macOS, add the revised real-host runbook receipt after package verification. If Electron geometry
tests are exercised under `CODEX_SANDBOX=seatbelt`, use the scoped outside-sandbox approval required
by `AGENTS.md`; do not add Chromium flags or bypass the preflight.

## Merge and exit criteria

- The macOS production path creates IOKit assertions in the daemon and never spawns `caffeinate`.
- The display-lock semantics and every stated non-guarantee remain unchanged.
- Native create/release truth reaches the existing Registry, SSE, routes, and UI without a second
  owner or optimistic state.
- The addon builds and loads under standalone Node and the packaged Electron utility process.
- Linux CI skips native compilation deliberately and retains the fake-provider browser proof.
- Relevant focused tests, full unit suite, typecheck, lint, build, smoke, Playwright, and package
  checks pass.
- The real managed-Mac receipt proves assertion ownership, locked-screen work, disable cleanup,
  crash cleanup, restart-off, and no `caffeinate` child, or the PR reports the precise endpoint-policy
  blocker and does not claim completion.
- Documentation matches the shipped mechanism.
- No unrelated files, evidence artifacts, secrets, signing-policy changes, or generated-file edits
  are committed.
- The implementation PR is reviewable, CI-green, and has no unresolved actionable Inspector
  feedback before merge.

## Downstream handoff

There is no later implementation phase. Future platform providers may rely on the provider boundary,
but must preserve daemon ownership, transient enablement, observed status, and the exact screen-lock
promise. They must not infer that a successful macOS IOKit result authorizes sleep inhibition on a
different managed platform.

## Cross-phase audit record

- 2026-08-19: The selected Scout option was reconciled with the existing Keep Awake vertical slice.
  UI, routes, SSE, Registry, and transient lifecycle remain owners once; only provider mechanics
  move.
- 2026-08-19: Linux Playwright coverage was found to depend on `MISSION_KEEP_AWAKE_BIN`. The explicit
  command override stays as a test provider, while production Darwin has no command fallback.
- 2026-08-19: The package ships `dist/**/*` and excludes `node_modules`; the native build therefore
  owns a deterministic `dist/native` artifact and smoke/package proof in the same phase.
- 2026-08-19: The complete audit found no useful merge boundary between the addon, provider switch,
  package path, tests, docs, and live receipt. One vertical phase owns the whole rollback unit.
