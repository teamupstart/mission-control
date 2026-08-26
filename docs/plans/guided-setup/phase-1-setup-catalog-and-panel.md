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
  `remedy`. Its `requirement` is this source's declaration of the level, read by the view composer
  and by nothing else; see `SetupRowView` below for why that is a projection rather than a rival
  field.
- The full `SetupRemedy` union: `link`, `command`, `provider-installer`, `skill`. **All four
  variants ship here**, including `command.argv`, so Phase 2 adds no shared type.
- `SetupStatus` - the four states. `satisfied` carries `evidence`; `missing` carries nothing;
  `needs-setup` and `unknown` carry **both** `why` (the sentence) and `evidence`
  (`string | null` - where to look if you disagree with the sentence). Both fields, because a
  folded environment check has a `warning` **and** a `detail`, and a status carrying only `why`
  would discard that detail at the boundary - leaving the panel unable to name the file it read,
  which is the whole point of `EnvironmentCheckView.detail`. Map `warning -> why` and
  `detail -> evidence`.
- `SETUP_DEPENDENCY_INFO: Record<SetupDependencyId, SetupDependencyInfo>` - the exhaustiveness
  enforcement, so a new id does not compile until it has said what it is and how to get it.
- `SetupRowId`, the discriminated identity every row carries, so no code has to guess which id
  space a row's id came from and the spaces can never collide:
  ```ts
  export type SetupDerivedRowId = "terminal-pair";

  export type SetupRowId =
    | { source: "dependency"; id: SetupDependencyId }
    | { source: "environment-check"; id: EnvironmentCheckId }
    | { source: "derived"; id: SetupDerivedRowId };
  ```
  **Three sources, one row type.** The derived source exists because the terminal pair row is not
  a dependency - no binary is named `terminal-pair` - and yet it is the `required` row in the
  Terminals family. Giving it its own view type instead is what left it invisible to anything
  that iterates "dependencies", which is a defect Phase 3's banner condition hit directly.
- `ENVIRONMENT_ROW_METADATA: Record<EnvironmentCheckId, { family; requirement; remedy }>` - what a
  folded environment warning is beyond what the check itself says. An `EnvironmentCheckView`
  carries a label, a warning, and a detail and has **no** family, requirement, or remedy, so
  without this the folded row is unrepresentable and the panel grows per-id branching to paper
  over it. `Record<EnvironmentCheckId, ...>` is the same enforcement used everywhere else here: a
  check appended to that tuple does not compile until it has said where its row belongs and what
  fixes it. For the one check that exists today: family `extensions`, requirement `optional`,
  remedy `{ kind: "skill", command: "/upstartclaw-core:setup" }` - which is where the `skill`
  variant of the remedy union earns its place.
- `SetupRowView` - ONE row shape every source produces: `rowId`, `label`, `family`,
  `requirement`, `enables`, `remedy`, `status`. The panel renders a list of these and never
  branches on an id. A dependency row fills it from `SETUP_DEPENDENCY_INFO`; a folded row from the
  check's own label plus `ENVIRONMENT_ROW_METADATA`; the derived row from its own definition.

  **`SetupRowView.requirement` is a projection, not a second opinion.** Each source declares the
  level for the rows it produces - `SETUP_DEPENDENCY_INFO[id].requirement`,
  `ENVIRONMENT_ROW_METADATA[id].requirement`, and the derived row's own - and `setupChecksView`
  copies that value onto the row it builds. One-to-one: there is no override, no precedence rule,
  and no case where the two could disagree, because only one of them is ever written by hand for
  a given row.

  **Only the view composer reads a source-level `requirement`. Every consumer reads
  `row.requirement`** - the panel, the banner condition, and anything later. That is the rule that
  makes "which value do I use" have one answer, and it is why the level can be declared per source
  without becoming two sources of truth.
- `SetupChecksView` as the route's answer: `{ rows: SetupRowView[] }`. **Every** row is in that
  one list - dependency, folded environment check, and derived - so a consumer asking "what is
  required and not satisfied here" gets a complete answer from one iteration and cannot miss a
  class of row by construction. The terminal pair row is a `SetupRowView` with
  `source: "derived"`, family `terminals`, requirement `required`, its `enables` sentence, a
  status of `satisfied` naming the emulator that would do the raising or `missing` when no pair
  exists, and a `link` remedy to install an emulator.
- Requirement levels for v1: `claude-cli` recommended (each agent CLI is only required if it is
  the one you dispatch, and the panel says so); `tmux`/`cmux`/`wezterm`/`ghostty` optional
  individually, with the **derived pair row carrying the `required`** level for that family -
  which backend you use is a preference, having none that can open a window is not;
  `gh-cli` required; `gh-auth` required; `claude-plugins`/`claude-skills` optional;
  `ai-conductor` optional. Each of those is a declaration by the dependency source; the derived
  pair row declares `required` in its own definition. Both end up as `row.requirement`, which is
  what lets a family carry `required` through a derived row while its member dependencies stay
  `optional` - not because the row overrides them, but because they describe different rows.

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
  - folds `environmentCheckViews()` in, building each row from the check's own `label` plus
    `ENVIRONMENT_ROW_METADATA`. Do not re-implement `upstartclaw.ts`; call it. Two rules, both
    easy to get wrong and both worth a test:
    - **a row exists only while its warning does.** A null warning is silence, and that silence
      covers both "installed and set up" and "never heard of this tooling", which the check
      deliberately refuses to distinguish. So emit no row - not a `satisfied` one. It is the only
      row in the panel that can vanish entirely, and claiming `satisfied` would invent a fact the
      check declined to assert.
    - **its status is always `needs-setup`**, with the warning as `why` and the check's `detail`
      as `evidence` - both carried, neither summarised. A check that fired has by construction
      found something installed and unfinished, and its detail is the file it read; dropping that
      would leave an operator who disputes the note with nowhere to look.
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
- A `useSetupChecks` hook owned locally by the panel, like `useSkills` and `useHarnesses` -
  correct **while the panel is its only consumer**; Phase 3 adds the first-run banner as a second
  consumer and hoists it to App, so keep the hook's state and its `recheck` passable as props
  rather than reaching for context inside the panel. Mount
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
  - `data-anchor="setup/<slug>"` on every control row, per the registry's anchor contract. Slugs
    must be unique **across both id spaces**, since a dependency and an environment check could
    otherwise slug the same - `settings-sidebar-render.test.ts` fails on a duplicate anchor, so
    derive the slug from `SetupRowId` (source included) rather than from the bare id;
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
  Plus the projection, asserted per source: each composed row's `requirement` **equals** its
  source's declared value - dependency rows against `SETUP_DEPENDENCY_INFO`, folded rows against
  `ENVIRONMENT_ROW_METADATA`, and the derived pair row against its definition. That is what pins
  "one value, copied" rather than leaving a future reader to guess whether the row or the source
  wins.
- `test/setup-probes.test.ts` - each probe against an arranged `SetupDeps`: satisfied with its
  evidence, missing, `needs-setup` (unauthenticated `gh`; unfinished Claw setup), and `unknown`
  distinguished from `missing` for an unreadable file. A probe that TIMES OUT yields `unknown`
  with a reason, and a probe that throws yields that row's
  `unknown` and does not take the view down. The terminal pair row disagreeing with per-backend
  presence (a multiplexer installed, no emulator) is its own case.
- `test/setup-checks-route.test.ts` - the route answers 200 with every row even when a probe
  fails; the folded environment check appears as a `needs-setup` row whose `why` **is** the check's
  warning and whose `evidence` **is** the check's detail, asserted field by field rather than by
  presence, in the family `ENVIRONMENT_ROW_METADATA` names; a check whose detail is null yields
  `evidence: null` rather than an empty string; and **no row at all** appears for that check when
  its warning is null. Anchor slugs are unique across both id spaces.
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
6. `SetupRowId`, `SetupRowView`, and `ENVIRONMENT_ROW_METADATA`: one row shape from three
   sources (dependency, environment-check, derived), discriminated by `source`, all in the single
   `SetupChecksView.rows` list. **`row.requirement` is the only requirement any consumer reads**;
   each source declares its own and the composer projects it, so a later phase must not reach past
   a row into `SETUP_DEPENDENCY_INFO` for a level. A later phase adds a row by adding catalog data, never by
   branching on an id at a render site, and never by pooling the id spaces into one. **Anything
   asking a question about "every required row" iterates that one list** - the pair row is the
   proof of why: it is `required` and it is not a dependency.
7. `useSetupChecks` is panel-local **only until a second consumer exists**. Phase 3's banner is
   that consumer and is expected to hoist the hook to App and pass its state to both readers; that
   is a planned move, not a contract break. What must not change is the underlying rule - one
   owner, one read, no poll.
8. `GET /api/setup/checks` answers `{ rows }` and is **expected to grow a `banner` field in Phase
   3**, whose composition prunes the dismissal record against the rows just computed. Also a
   planned extension rather than a contract break, and the reason it belongs on this route instead
   of a new one: a second setup endpoint would run a second probe sweep per page load and produce
   a second answer that can drift from this one. Two things it must not change - `rows` stays
   exactly as specified here (the extension is additive), and the route still computes per request
   and caches nothing. The prune is a write on a read path, which Phase 3 justifies; it is not a
   cache.

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
- **Inspector round 17 (major, PR #800).** Phase 3's prune had no surface to happen on, because
  this route was specified as returning rows only and Phase 3 forbade route changes. Added handoff
  clause 8 declaring the additive `banner` extension Phase 3 makes, with the constraints that keep
  it safe (rows unchanged, still per-request, still uncached) and the reason it is an extension
  rather than a second endpoint.
- **Inspector round 15 (major, PR #800).** `requirement` was on `SetupDependencyInfo` while the
  prose said it "sits on the ROW, not on the dependency" - two statements a reader has to
  reconcile, with no rule saying which a consumer should use. Reframed as a projection: each
  source declares the level for the rows it produces, the composer copies it onto the row, and
  **only the composer reads a source-level value**. No override and no precedence, because for any
  given row exactly one source declares it. Added the per-source projection assertion to the
  catalog test and the single-read rule to the handoff, so the ambiguity cannot come back as a
  consumer reaching past a row into the dependency table.
- **Inspector round 9 (major, PR #800).** `SetupStatus.needs-setup` carried only `why`, so a
  folded environment check's `detail` had nowhere to go: the stated shape forced an implementer to
  discard it or widen the contract ad hoc, and the panel would have lost the evidence
  `EnvironmentCheckView.detail` exists to provide. Added `evidence: string | null` to
  `needs-setup` and `unknown`, keeping `why` as the sentence, so the fold maps
  `warning -> why` and `detail -> evidence` losslessly. Reused the name `evidence` rather than
  introducing `detail` alongside it, so the contract has one word for "where to look" across every
  state that can answer it. Route test now asserts both fields by value.
- **Inspector round 4 (major, PR #800).** The derived terminal pair row had its own view type
  (`SetupPairView`) beside the row union, so "every required dependency" - the shape Phase 3's
  banner condition took - could not see the one `required` row in the Terminals family. Folded it
  into `SetupRowView` as a third `source: "derived"`, put every row in one
  `SetupChecksView.rows` list, and stated that `requirement` belongs to the row rather than to the
  dependency, which is what lets a family be required while each of its backends stays optional
  (**refined by round 15 above**: the level is declared per source and projected onto the row, so
  it is one value copied rather than a row-level override of a dependency's).
- **Inspector round 3 (major, PR #800).** The folded environment warning was unrepresentable:
  the only row type extended `SetupDependencyInfo`, while an `EnvironmentCheckView` has no id in
  that space, no family, no requirement, and no remedy - so an implementer would have invented all
  four at the render site. Added `SetupRowId` (discriminated by source), one `SetupRowView` both
  sources produce, and a catalog-owned `ENVIRONMENT_ROW_METADATA`. Also pinned the two properties
  of a folded row that a naive mapping gets wrong - it vanishes when the warning is null rather
  than reading `satisfied`, and its status is always `needs-setup` - and required anchor slugs to
  be derived from the discriminated id so the two spaces cannot collide.
- **Inspector round 2 (major, PR #800).** Phase 3's banner needs the checks before Settings is
  opened, which this phase's panel-local hook cannot serve. Amended the hook bullet and the handoff
  to say panel-local holds only until a second consumer exists, and to keep the hook's state
  prop-passable so Phase 3's hoist is a move rather than a rewrite.
