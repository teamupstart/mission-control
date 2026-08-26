# Phase 1 - Setup catalog, detection, and the Setup panel

Part of [`phased-plan.md`](phased-plan.md). Approved goal: [`plan.md`](plan.md).

## Outcome

An operator opens Settings → Setup and reads, in one place, every external dependency Mission
Control uses: whether this machine has it, what it unlocks, the evidence behind that answer, and
a link or copyable command that fixes it. Nothing on the page is a placeholder for a later
phase.

## Entry criteria and dependencies

None. This is the first phase, and it introduces every contract the other two inherit.

## Scope

- `src/shared/setup-catalog.ts` - the pure half of the catalog.
- `src/server/setup/` - the probes, the dependency bag, and the view composer.
- `GET /api/setup/checks` and its client fetch.
- The `setup` Settings category and `SetupPanel.tsx`, rendering all five v1 families.
- Deterministic e2e overrides for the two terminal backends that currently have none.
- Unit tests, one e2e spec, and the docs updates for the surface this adds.

### Non-goals

- **No execution.** A `command` remedy renders as copyable text only. Phase 2 owns the route and
  the button. This phase defines the `command` variant's argv in the catalog so Phase 2 changes
  no shared contract, but nothing in this phase runs it.
- **No banner and no tour.** Phase 3.
- **No rail dot.** See finding 7: `settings-dots.ts` derives every dot from `SettingsStatus`,
  which is a fixed struct of the daemon's own config emitted on config writes. Putting a machine
  probe on that path is a separate decision.
- **No change to `ENVIRONMENT_CHECK_IDS`**, its route, or its dispatch-form note.
- **No git/Node rows.** Out of v1 by decision; the tuple stays appendable.

## Repository findings this phase must honor

1. **Resolve through the override chain.** `resolveBinSpec` (`src/server/harness/bin.ts`) reads
   `MISSION_` then `FLEET_` then `HARNESS_`; `resolveBin` (`src/server/terminal/bin.ts`) reads a
   backend's own `spec.env` and then its candidate paths; `ghBin()` (`src/server/config.ts:236`)
   reads `MISSION_GH_BIN`; the conductor provider reads its own override in `binForPresence()`.
   Ask those functions. A probe that called `onPath("gh")` directly would report the operator's
   real machine while every dispatch used the override, and would make the e2e spec below
   impossible.

2. **`onPath` versus `resolveBinPath` is a deliberate distinction**, documented at
   `src/server/util/exec.ts:29-46`. `onPath` walks `PATH` with `existsSync`: no subprocess, tests
   existence rather than executability. `resolveBinPath` spawns `which` and yields the resolved
   path with the system resolver's authority. This panel wants the resolved path as its evidence
   string, and `agentBinPresent` already uses `hasBin`, so prefer `resolveBinPath` for the rows
   whose evidence is a path - but keep the whole route's cost bounded, which step 2 does with
   concurrency plus a per-probe timeout rather than with a cache.

3. **Reuse `terminalTargetViews` for the pair row.** `src/server/terminal/targets.ts` exists
   because a detached tmux session with no emulator to raise it is a control that reports success
   and puts nothing on screen. Do not restate that logic.

4. **The check-registry shape to copy.** `src/server/environment/{index,types}.ts` is the model:
   an `Info` half in `src/shared/`, an `Impl` half that spreads it and adds the machine read, a
   `Record<Id, Impl>` whose exhaustiveness is the enforcement, a `Deps` bag whose whole purpose is
   that tests never read the developer's real home, a bounded `readText`, and a `runCheck` wrapper
   that turns a thrown probe into that row's own warning.

5. **Settings surfaces already pinned.** `SETTINGS_CATEGORIES` is read by the router, the page,
   the search index, the dots, and `settings-sidebar-render.test.ts`, which fails on a duplicate
   `data-anchor` or an anchor whose prefix is not a category id.

## Implementation steps

### 1. `src/shared/setup-catalog.ts`

Pure, browser-safe, no `node:` imports - `src/shared/` is a controlled path.

- `SETUP_DEPENDENCY_IDS`, append-only, with the change-contract comment the other append-only
  tuples carry: `["claude-cli", "codex-cli", "pi-cli", "tmux", "cmux", "wezterm", "ghostty",
  "gh-cli", "gh-auth", "claude-plugins", "claude-skills", "ai-conductor"]`.
- `SETUP_FAMILY_IDS` in panel order: `["agents", "terminals", "github", "extensions",
  "pipelines"]`, each with a label and a one-line description.
- `SetupDependencyInfo` - `id`, `label`, `family`, `requirement`
  (`"required" | "recommended" | "optional"`), `enables` (one sentence, in the product's terms),
  `remedy`.
- The full `SetupRemedy` union: `link`, `command`, `provider-installer`, `skill`. **All four
  variants ship here**, including `command.argv`, so Phase 2 adds no shared type.
- `SetupStatus` - the four states, `satisfied` carrying `evidence`, `needs-setup` and `unknown`
  carrying `why`.
- `SETUP_DEPENDENCY_INFO: Record<SetupDependencyId, SetupDependencyInfo>` - the exhaustiveness
  enforcement, so a new id does not compile until it has said what it is and how to get it.
- `SetupDependencyView extends SetupDependencyInfo` with `status`, plus the derived
  `SetupPairView` for the terminal row, plus `SetupChecksView` as the route's answer.
- Requirement levels for v1: `claude-cli` recommended (each agent CLI is only required if it is
  the one you dispatch, and the panel says so); `tmux`/`cmux`/`wezterm`/`ghostty` optional
  individually with the derived pair row **required**; `gh-cli` required; `gh-auth` required;
  `claude-plugins`/`claude-skills` optional; `ai-conductor` optional.

### 2. `src/server/setup/`

- `types.ts` - `SetupDeps` (homeDir, `readText`, `subdirectories`, plus the seams the probes need:
  `resolvePath`, `installedBackend`, `terminalTargets`, `runCommand`, `plugins`,
  `conductorProbe`), and `SetupProbeImpl extends SetupDependencyInfo` with
  `probe(deps): Promise<SetupStatus>`. Model it on `environment/types.ts`, including the reason
  the bag exists: `test/` must never read the developer's real `~/.claude` or `PATH`.
- `index.ts` - `SETUP_PROBES: Record<SetupDependencyId, SetupProbeImpl>`,
  `defaultSetupDeps()`, and `setupChecksView(deps)` which:
  - runs every probe concurrently (`Promise.all`), so the route costs the slowest probe rather
    than their sum;
  - wraps each in the `runCheck` equivalent, so a thrown probe becomes that row's `unknown` with
    a why that names Mission Control as the fault rather than the operator's machine;
  - appends the derived terminal pair row from `terminalTargets`;
  - folds `environmentCheckViews()` in: each non-null warning becomes a `needs-setup` row in the
    family it belongs to, reusing that check's own `label` and `detail`. Do not re-implement
    `upstartclaw.ts`; call it.
- `probes.ts` (or one file per family if it reads better) - the probes themselves:
  - agents: `agentBinPresent` / `resolveBinPath(resolveAgentBin(agent))` for the evidence path;
  - terminals: `binPresent(spec)` per backend, with the resolved candidate as evidence;
  - `gh-cli`: `resolveBinPath(ghBin())`;
  - `gh-auth`: run `gh auth status` and **parse its output**, never trust the exit code alone -
    the same rule `PipelineProvider.control` states for ai-conductor. `missing` when `gh` itself
    is absent, `needs-setup` when it is present and not logged in, `unknown` when the command
    could not be run at all;
  - `claude-plugins`: `installedPlugins()`, satisfied when the record parses, with the count as
    evidence; `unknown` when the record exists and cannot be read;
  - `claude-skills`: the existing skills reconcile/drift read;
  - `ai-conductor`: `binForPresence()` then `probe()` for the version evidence.
- **Nothing is cached across requests**, for `environmentCheckViews`' documented reason: an
  operator who just installed something must see the change on the next read, and a cached answer
  is a claim about a machine they have since repaired. The two subprocess probes (`gh auth status`
  and the conductor probe) are bounded instead, by `run`'s own `timeoutMs`
  (`src/server/util/exec.ts`, 4s by default); a probe that times out yields `unknown` with a
  reason. Concurrency plus that bound is what keeps the route cheap - not a cache.

### 3. Route and client

- `GET /api/setup/checks` in `src/server/routes.ts`, beside the environment-checks route
  (`routes.ts:5980`), answering `SetupChecksView`, always 200. A probe failure is a row state,
  not a route error.
- `fetchSetupChecks()` in `src/web/lib/api.ts`, in the shape of the existing
  `fetchJson<EnvironmentChecksView>("/api/environment/checks")` at `api.ts:303`.
- A `useSetupChecks` hook owned locally by the panel, like `useSkills` and `useHarnesses`: mount
  read plus an explicit `recheck()`. **No poll and no SSE** - the page refetches when the
  operator asks.

### 4. The Settings category and panel

- Append to `SETTINGS_CATEGORIES` (`src/web/lib/settings-registry.ts`): `id: "setup"`, label
  `Setup`, an icon consistent with its neighbours, a blurb, `group: "sessions"` placed **first**
  within that group, and `scope: "home"` - a remedy can launch an installer that writes outside
  this app, and the scope badge is not allowed to be softer than the truth. Keywords should cover
  what an operator would actually search: install, dependency, terminal, tmux, gh, plugin,
  conductor, missing.
- Add the `case "setup"` arm to `renderCategory` in `SettingsPage.tsx`.
- `src/web/components/SetupPanel.tsx`, in `SkillsPanel`'s register (~210 lines) rather than
  `ConductorPanel`'s (~1079):
  - one `<section>` per family with a **stable element id** (`setup-family-<id>`) - Phase 3
    attaches tour target refs to these;
  - one row per dependency: status chip, label, the `enables` sentence, the evidence or why
    string, a requirement marker for `required` rows, and a **remedy action slot** - Phase 2
    fills it;
  - `data-anchor="setup/<slug>"` on every control row, per the registry's anchor contract;
  - remedy rendering in this phase: `link` as an anchor, `command` as copyable text with the
    existing copy affordance, `provider-installer` as a pointer to the Conductor panel, `skill`
    as the printed slash command;
  - a single "Re-check" button; satisfied rows collapse to a one-line chip so an already-set-up
    machine is quiet.
- Accessible names on every control, no `data-testid` anywhere.

### 5. Deterministic e2e backends (finding 4)

Add `WEZTERM_BIN` and `GHOSTTY_BIN` to the daemon environment in `e2e/fixtures/daemon.ts`
(beside `CMUX_BIN` at line ~302), pointed at a path inside the isolated home that does not
exist, with a comment saying why: without them these two rows read "installed" on a developer's
laptop and "missing" on CI, so any spec asserting on them is flaky by construction. Confirm no
existing spec depends on those backends being resolvable.

## Tests and verification

- `test/setup-catalog.test.ts` - the pure half: every id has info, families are contiguous and
  in panel order, requirement levels are as specified, and every `command` remedy's argv is
  well-formed (the shape rule itself is Phase 2's guard; here just assert the data exists).
- `test/setup-probes.test.ts` - each probe against an arranged `SetupDeps`: satisfied with its
  evidence, missing, `needs-setup` (unauthenticated `gh`; unfinished Claw setup), and `unknown`
  distinguished from `missing` for an unreadable file. A probe that TIMES OUT yields `unknown`
  with a reason, and a probe that throws yields that row's
  `unknown` and does not take the view down. The terminal pair row disagreeing with per-backend
  presence (a multiplexer installed, no emulator) is its own case.
- `test/setup-checks-route.test.ts` - the route answers 200 with every row even when a probe
  fails, and the folded environment check appears as a `needs-setup` row.
- `test/settings-sidebar-render.test.ts` - already walks the registry; confirm it passes with the
  new category and that no anchor collides.
- `e2e/specs/setup-panel.spec.ts` - the required UI spec. Opens Settings → Setup against a daemon
  whose overrides make the answers deterministic; asserts a satisfied row (an agent CLI, via
  `MISSION_CLAUDE_BIN`), a missing row with its remedy control (conductor via the existing
  `startsMissing` mode), the evidence string, and that "Re-check" re-reads the machine rather
  than answering from a snapshot - install nothing, spend no tokens, select by role and label.
- Run: `node --test --import ./test/setup-state.mjs --import tsx test/setup-probes.test.ts` for
  the focused loop, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, and `npm run test:e2e`.
- Docs in this phase: `docs/setup.md` gains the in-app path beside its command-line
  prerequisites; `docs/ui.md` and `docs/skills-and-settings.md` gain the category;
  `docs/harnesses-and-terminals.md` points at it for backend presence.

## Merge and exit criteria

- Settings → Setup renders all five families on a real machine with statuses that match what the
  machine actually has.
- Every remedy is reachable as a link or copyable command; nothing on the page is inert.
- `ENVIRONMENT_CHECK_IDS` is untouched and `dispatch-environment-warning.spec.ts` still passes.
- The full gate is green: typecheck, lint, tests, build, smoke, e2e.

## Downstream handoff

Later phases may rely on, and must not change:

1. `SETUP_DEPENDENCY_IDS` (append-only), `SETUP_FAMILY_IDS`, and the four-state `SetupStatus`.
2. The complete `SetupRemedy` union including `command.argv`.
3. `GET /api/setup/checks` and its per-request, uncached contract.
4. The panel's structure: `setup-family-<id>` sections, `data-anchor="setup/<slug>"` rows, and
   the remedy action slot.
5. The override-chain rule for every probe.

**Seam for the concurrent phases.** Phase 2 edits inside the remedy action slot; Phase 3
attaches tour target refs to the family section wrappers and adds an App-level banner. Disjoint
regions of `SetupPanel.tsx`; either may merge first.

## Cross-phase audit record

- Written first; nothing earlier to reconcile.
- Moved the entire `SetupRemedy` union into this phase after noticing that defining `command`
  in Phase 2 would make Phase 2 a shared-contract change, which would have forced Phase 3 to
  depend on it and destroyed the concurrency.
- Dropped the rail dot from scope after finding that `settings-dots.ts` derives every dot from
  `SettingsStatus`, which is emitted on config writes and folded into the registry snapshot; a
  machine probe there would contradict the plan's no-tick rule.
- Added the e2e `WEZTERM_BIN` / `GHOSTTY_BIN` overrides to this phase rather than Phase 3, since
  this is the phase whose spec would otherwise be flaky.
- **Inspector round 1 (minor, PR #800).** The source plan's risk table claimed the two subprocess
  probes sat behind a short-lived cache, contradicting this phase's per-request contract. Resolved
  in favour of no cache - the policy the plan, this phase, and the approved "fix it and re-check"
  behavior all already rested on - and named the real bound instead: concurrency plus `run`'s
  `timeoutMs`, with a timeout rendering `unknown`. Fixed a stale "see step 4" pointer in finding 2
  found while checking this.
