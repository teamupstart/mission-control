# Native Keep Awake provider - phased implementation

## Source plan and human decision

Source: `docs/plans/keep-awake-native-provider/plan.md`.

The user selected recommendation 1 from the archived Keep Awake alternatives report and asked to
schedule it through the phased-plan workflow. The fixed goal is a daemon-owned, in-process macOS
IOKit assertion that preserves normal screen dimming and locking. Electron ownership, synthetic
activity, display-sleep inhibition, persistence, and an automatic `caffeinate` fallback remain out
of scope.

## Investigated repository findings

1. `src/server/keep-awake.ts` currently combines transition serialization, status publication,
   child-process control, and provider selection. The manager seam must be extracted without
   creating a second owner.
2. `KeepAwakeStatus.provider` in `src/shared/types.ts` is currently `"caffeinate" | null`. It is
   carried in snapshot and SSE state but is not persisted and is not used by React to branch
   behavior. Appending `"iokit"` is wire-compatible with the current browser implementation.
3. `src/server/index.ts` already constructs exactly one manager before routes accept traffic and
   stops it during ordered shutdown. The native provider belongs there through the existing
   manager, not in routes, the Registry, or Electron.
4. The packaged daemon runs as an Electron `utilityProcess` executing `dist/server/index.mjs` with
   Electron 43's Node 24 runtime. Standalone and LaunchAgent modes use Node 24 or newer. A stable
   Node-API addon can serve both without binding to V8 or an Electron ABI.
5. esbuild cannot inline `.node` binaries. `electron-builder.yml` includes `dist/**/*` and excludes
   `node_modules`, so the build must copy the compiled addon into `dist/native/` and load it by an
   explicit runtime path.
6. Vite clears `dist/web`, not all of `dist`, so a native artifact built before or beside the web
   bundle is not erased.
7. `node-gyp` exists only transitively in the lockfile. The native build must declare it directly
   rather than depending on electron-builder's dependency graph.
8. Linux CI and Playwright intentionally redirect Keep Awake through
   `MISSION_KEEP_AWAKE_BIN`. Retaining that explicit command provider avoids native compilation on
   Linux and preserves full UI coverage without altering host power settings.
9. Ordinary tests must never call real IOKit. The real assertion, locked-screen behavior, and
   process-death release remain a manual macOS receipt.
10. No UI, route, SSE event name, database schema, saved config, or startup restore needs to move.

## Sizing estimate

Estimated non-test implementation: **320-480 lines**.

Assumptions:

- 90-150 lines for a raw Node-API Objective-C++ addon and binding definition;
- 60-100 lines for conditional build, copy, and runtime loading;
- 130-190 lines to extract the provider boundary and adapt the manager while retaining the
  command fixture; and
- 40-60 lines across shared types, smoke/package checks, and runtime documentation comments.

Tests and product documentation are excluded from that range. Native lifecycle, dual Node
runtimes, packaging, and policy-bounded live verification add complexity beyond the line count.

## Phase-count decision

Create exactly **one implementation phase**.

Although the estimate is above 200 lines, splitting the addon from its manager consumer would land
an unused native binary and packaging contract. Splitting the manager refactor first would either
retain the failing production provider or create a temporary second source of truth. The addon,
provider switch, package path, tests, docs, and real-Mac receipt form one reviewable vertical slice
with one rollback boundary.

## Phase graph

| Phase | Outcome | Direct dependencies | Concurrency |
|---|---|---|---|
| 1. Native macOS assertion provider | Mission Control holds the exact idle-system assertion in the daemon process, packages it safely, preserves all existing UI and lifecycle contracts, and proves behavior on a real managed Mac | This planning PR merged | No other implementation phase exists |

```text
planning PR merge
       |
       v
Phase 1: native macOS assertion provider
       |
       v
reviewable implementation PR + automated gates + real-Mac receipt
```

## Merge order and release gate

Phase 1 depends directly on the planning session that publishes these artifacts. Its Mission
Control task must remain backlogged until the planning PR merges to the default branch. The one
implementation PR then lands the complete provider replacement; no preparation or cleanup phase
is expected.

## Cross-phase contracts

There is one phase, so these are integration contracts inside the vertical slice:

- The daemon remains the sole Keep Awake owner in packaged, browser, adopted-daemon, `npm start`,
  and LaunchAgent modes.
- The production macOS default is IOKit in process. The command provider exists only when the
  explicit test override is present and is never an automatic fallback after native failure.
- Only user-idle system sleep is inhibited. Display sleep and user activity are never asserted.
- `on` follows successful IOKit creation; `off` follows successful release; failures are visible
  and bounded.
- The mode stays transient and starts off after every daemon start or restart.
- The native module is side-effect free on load and uses stable Node-API rather than V8 APIs.
- Linux builds and tests do not compile or call IOKit.
- No database, saved config, route, SSE event name, or UI ownership changes.
- A denied native assertion stops the rollout and produces evidence; it does not trigger evasive
  process, input, audio, or display fallbacks.

## Final verification strategy

Phase 1 owns all proof introduced by the provider replacement:

- provider and manager unit tests with injected native and command fakes;
- existing HTTP, Registry/SSE, reducer, render, and Electron lifecycle tests;
- the existing Keep Awake Playwright vertical slice through the Linux-safe command fixture;
- `npm run typecheck`, `npm run lint`, and `npm test`;
- `npm run build` and `npm run smoke` on Linux and macOS;
- `npm run package` on macOS arm64, followed by a packaged-daemon load check; and
- a real managed-Mac receipt proving the display locks, work continues, disable releases, daemon
  death releases, restart returns off, and no `caffeinate` child exists.

## Final compatibility audit

- Every approved source-plan requirement is owned by Phase 1.
- The provider boundary is introduced in the same merge unit as its native implementation and
  package path, so no dead API or unused binary lands.
- Retaining the explicit command override keeps Linux browser coverage and avoids real power
  changes in automated tests.
- Appending `iokit` changes only live wire vocabulary; no historical row or archive is rewritten.
- The phase ends operable and does not depend on undocumented later cleanup.
- All task-referenced paths are relative to the repository root and will be verified in the pushed
  planning commit before task creation.

## Artifact index

- `docs/plans/keep-awake-native-provider/plan.md`
- `docs/plans/keep-awake-native-provider/plan.html`
- `docs/plans/keep-awake-native-provider/phased-plan.md`
- `docs/plans/keep-awake-native-provider/phased-plan.html`
- `docs/plans/keep-awake-native-provider/phase-1-native-macos-assertion-provider.md`
