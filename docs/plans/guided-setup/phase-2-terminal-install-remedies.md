# Phase 2 - Run a remedy in a visible terminal

Part of [`phased-plan.md`](phased-plan.md). Approved goal: [`plan.md`](plan.md).

## Outcome

A missing dependency can be installed from the Setup panel: the operator picks a terminal, a
window opens running the install, and they watch it and read its exit code. The daemon never
runs an install in-process, and the browser never chooses what gets executed.

## Entry criteria and dependencies

**Direct prerequisite: Phase 1.** This phase needs the catalog (including the `command`
variant's argv, which Phase 1 defines), `GET /api/setup/checks`, and the panel's remedy action
slot. It adds no shared type.

## Scope

- `POST /api/setup/install` - id plus terminal backend in, a launch outcome out.
- The argv ownership guard and its test: the one rule this phase exists to get right.
- The backend picker and the "Run in a terminal" control in the panel's remedy slot.
- ai-conductor's remedy delegating to the existing `pipelineInstallerLaunch`, including where
  the verified checkout it needs comes from.
- Unit tests, an e2e spec, and the docs note about what the button will and will not run.

### Non-goals

- **No daemon-side package-manager install.** Decided: an unwatched install with no visible
  output or exit code is not on offer.
- **No shell composed from browser input.** Ever. See the guard below.
- **No new detection and no catalog additions.** Phase 1 owns both.
- **No second ai-conductor installer.** The provider already has one.

## Repository findings this phase must honor

1. **`POST /api/pipelines/install` (`src/server/routes.ts:5627`) is the exact precedent**, and
   its properties are the ones to copy, not merely its shape:
   - only provider, checkout, and backend come from the browser; the provider owns argv, cwd,
     and title. **The `checkout` field is part of that precedent, not an exception to it** - see
     the body schema below for why accepting one is safe;
   - membership and every trust marker are re-checked **in the request**, not at list time -
     `installer.terminalArgv` reverifies before returning argv, so a stale marker is refused
     before the terminal layer sees it;
   - the daemon owns the hold-open wrapper:
     ```sh
     <argv>
     status=$?
     printf '\n[installer exited %s] press enter to close ' "$status"
     read -r _
     ```
     handed to `terminalLauncher` as `[process.env.SHELL || "/bin/sh", "-c", hold]`;
   - the outcome is a three-way `opened` / `maybe-opening` / `refused`, because a 504 from the
     terminal layer means the window may still be opening and reporting that as failure would be
     a lie. Mirror those three.

2. **`shellCommand(argv)` already exists** and is what quotes argv into that wrapper. Use it;
   do not concatenate.

3. **`GET /api/terminal-targets` (`routes.ts:2791`) already answers which backends can actually
   open a window**, pair-aware via `terminalTargetViews`, including the `unavailable` sentence
   per row. The picker reads that route rather than the raw backend list, so it cannot offer a
   multiplexer with no emulator to raise it.

4. **`PipelineInstallerLaunchSchema` (`src/shared/protocol.ts:2700`)** is the schema shape to
   follow for the new body, and `parseBody(c, Schema)` is the parsing contract.

5. **The e2e harness can drive this without installing anything.** `CMUX_BIN` points at a fake
   that records the `new-workspace --command` it was handed (`e2e/fixtures/fake-agents.ts`), so a
   spec can assert the exact command line a click asked a terminal to run - which is the only
   assertion that actually proves the argv boundary from the outside.

## Implementation steps

### 1. The argv guard - do this first

In `src/shared/setup-catalog.ts`'s neighbourhood or a small `src/server/setup/argv.ts`, a
predicate that accepts a `command` remedy's argv only when it is:

- a non-empty array of plain strings, the first being an allowlisted installer program
  (`brew`, `npm`, and nothing else until a decision adds one);
- free of shell metacharacters in every element: no `|`, `&`, `;`, `<`, `>`, `` ` ``, `$`, `(`,
  `)`, newline, or quote;
- free of `sudo` in any position;
- free of any element that parses as a URL or contains `://`.

Anything a catalog entry cannot express that way carries a `link` instead. The install route
refuses an argv that fails this predicate **even though the catalog is committed source** - the
guard's job is to make a bad future catalog edit a refused request rather than a shell
injection, and a check that only runs at authoring time does not do that.

**Scope: `command` remedies only.** A `provider-installer` remedy's argv belongs to the pipeline
provider, which verifies its own checkout and markers at click time, and its `bin/install` is not
a package-manager invocation - running this allowlist over it would refuse the one remedy that
already has a vetted installer. See the route's `switch` below.

### 2. `POST /api/setup/install`

- Body schema in `src/shared/protocol.ts`:
  `{ id: SetupDependencyId, backend: TerminalBackendId, checkout?: string }`.
  **No argv, no cwd, no title, no command string.** Parse with `parseBody`.

  `checkout` is **required when the remedy is `provider-installer` and forbidden otherwise** -
  express that in the schema (a `refine`, or a discriminated body) rather than checking it in the
  handler, so a malformed pairing is refused before any lookup. It exists because
  `pipelineInstallerLaunch(provider, checkout, repoRoots)` is checkout-based: candidates are local
  source checkouts in the workspace catalog, and there is no "the" checkout for the route to
  assume.

  **A checkout is not argv, and accepting one does not weaken the boundary.** It is a *selection
  among candidates the server enumerated*: `pipelineInstallerLaunch` re-derives the verified set
  with `pipelineInstallerCandidates` and refuses any checkout not in it, then cross-checks that
  the provider confirmed the same checkout and cwd
  (`src/server/pipelines/index.ts:653-670`). So the browser cannot name an arbitrary directory,
  and the argv still comes from the provider. This is the same input the pipelines install route
  already takes from its own browser, for the same reason.
- Handler, beside the pipelines install route. **Two remedy kinds are runnable and two are not**,
  so branch on the kind before refusing anything - a refusal that fires first would make
  `provider-installer` unreachable:
  1. look the dependency up in the catalog; 404 for an unknown id;
  2. switch on `remedy.kind`:
     - `link` and `skill`: refuse with 409 and a sentence. There is nothing to run, and that is
       a property of the remedy rather than an error.
     - `provider-installer`: delegate to `pipelineInstallerLaunch(provider, body.checkout,
       await listRepos())` exactly as the pipelines route does, including its reverification,
       rather than reimplementing candidate discovery. Its `{ ok: false, error }` becomes a 409
       carrying that sentence - "no longer a verified installer candidate" is the answer an
       operator needs, and flattening it to a generic refusal throws away the only useful part.
       The argv guard below does not apply - the argv is the provider's, already verified by it,
       and running our package-manager allowlist over `bin/install` would refuse it.
     - `command`: run the argv guard on the looked-up argv and refuse with 409 if it fails, then
       wrap in the hold-open shell with `shellCommand`.
  3. launch via `terminalLauncher` and answer `opened` / `maybe-opening` / `refused` with the
     terminal layer's status code preserved.
  A `switch` over the union rather than a chain of early returns, so a remedy kind added later
  does not compile until this route says what it does with it.
- cwd: the operator's home for a package-manager install (it must not depend on a repository),
  and the provider's own cwd for the delegated path.

### 3. The panel controls

In the remedy action slot Phase 1 defined:

- a backend picker populated from `/api/terminal-targets`, rendering each row's `unavailable`
  sentence rather than hiding it, so a machine with no usable terminal explains itself instead
  of showing an empty menu;
- a "Run in a terminal" button, enabled only for a `command` or `provider-installer` remedy with
  a usable backend selected;
- for a `provider-installer` row, the checkout the button will send, read from the **existing**
  `GET /api/pipelines/installers` route rather than a new one. Three states, because the honest
  answer differs:
  - **no candidate** - no run button. Say that no verified local checkout was found and point at
    Settings → Conductor, which owns this engine's setup. Do not offer a control that must fail.
  - **exactly one** - one click, no picker. Name the checkout beside the button so the operator
    can see what will run.
  - **more than one** - a small select of the verified checkouts, defaulting to none so nothing
    is launched by a stray click.

  This is a *selection* surface over server-enumerated candidates, not a second candidate
  discovery implementation: the route above re-derives and re-verifies the set anyway, so a stale
  list here is refused rather than trusted. Phase 1 renders this row as a pointer to the Conductor
  panel because Phase 1 has no execution at all; this phase upgrades it to a run control and keeps
  the pointer for the no-candidate case.
- after a launch: the outcome sentence, including the `maybe-opening` case, plus a prompt to
  press "Re-check" once the install finishes. **Do not poll for completion** - the daemon has no
  view into that terminal, and a spinner that resolves on a guess would be inventing a fact.
- the copy affordance from Phase 1 stays. The button is an addition, never a replacement: an
  operator who would rather paste it themselves must always be able to.

## Tests and verification

- `test/setup-install-argv.test.ts` - the guard, adversarially: a pipe, a redirect, a backtick,
  `$(...)`, a newline, `sudo` in first and later position, a URL, an empty array, a non-allowlisted
  program, and each legitimate form (`brew install gh`, `npm install -g <pkg>`). This is the
  phase's most important test.
- `test/setup-install-route.test.ts` - unknown id 404; `link` and `skill` remedies refused; **a
  `provider-installer` remedy reaching the delegated launch rather than the refusal** (the
  ai-conductor row is the case, and getting this wrong makes the one dependency with a real
  installer the one that cannot use it); a `provider-installer` request with **no** checkout
  refused by the schema; a checkout that is **not** a verified candidate refused with the
  provider's own sentence and without reaching the terminal layer; a `command` request that
  carries a checkout refused by the schema; a `command` entry whose argv fails the guard refused
  **without** reaching the terminal layer (assert the launcher was not called); the happy path
  handing exactly the wrapped argv to the launcher; the 504 case reported as `maybe-opening`.
- `e2e/specs/setup-install-terminal.spec.ts` - picks the cmux backend, clicks "Run in a terminal"
  on a missing dependency, and asserts against the fake's recorded command line that what the
  terminal was handed is the catalog's argv inside the hold-open wrapper. Also asserts the refusal
  path renders its sentence, and - using the daemon fixture's existing `startsMissing` conductor
  mode plus `e2e/fixtures/conductor-panel.ts` - that the ai-conductor row shows the
  no-candidate sentence rather than a button that must fail. Installs nothing; spends no tokens.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.
- Docs: extend the `docs/setup.md` section Phase 1 added with what the button runs, that argv is
  daemon-owned, and that the terminal is deliberately visible.

## Merge and exit criteria

- A missing dependency installs from the panel on a real machine, in a visible terminal, and
  "Re-check" then shows it satisfied.
- No request body anywhere in this feature carries a command, argv, cwd, title, or shell
  string. The one path-shaped field, `checkout`, is a selection the daemon re-verifies against
  its own enumerated candidates before use.
- The guard refuses every adversarial form in its test, and the route refuses before spawning.
- Full gate green.

## Downstream handoff

Phase 3 does not consume anything this phase introduces. If Phase 3 merges first, this phase
rebases onto a `SetupPanel.tsx` that has gained tour target refs on the family sections and an
App-level banner; neither touches the remedy action slot.

## Cross-phase audit record

- Reconciled against Phase 1: no shared contract changes here, because Phase 1 defines the whole
  `SetupRemedy` union including `command.argv`. Confirmed the panel seam (remedy action slot) is
  the only region this phase edits in `SetupPanel.tsx`.
- Confirmed against Phase 1's non-goals that "renders as copyable text only" in Phase 1 and "the
  button is an addition, never a replacement" here are consistent: the copy affordance survives.
- Moved the argv guard from "a test that checks the committed catalog" to "a predicate the route
  runs per request" during this write-up. The authoring-time-only version would let a later
  catalog edit reach a shell.
- Checked that delegating ai-conductor to `pipelineInstallerLaunch` does not create a second
  source of truth for installer candidates: the pipelines route keeps ownership, this route calls
  it.
- **Inspector round 1 (major, PR #800).** The route sequence refused every non-`command` remedy
  before the step that delegates `provider-installer`, so ai-conductor - the one dependency with a
  real installer - could never have reached it. Rewritten as an exhaustive `switch` over the
  remedy union, so a kind added later does not compile until this route says what it does with it,
  and scoped the argv guard explicitly to `command` remedies (the provider's `bin/install` is not
  a package-manager invocation and the allowlist would refuse it). Added the delegation case to
  the route test list.
- **Inspector round 2 (major, PR #800).** The follow-on hole in that same fix: the body carried
  only `id` and `backend`, but `pipelineInstallerLaunch` is checkout-based, so the delegation had
  nothing to launch. Added `checkout` to the contract - required for `provider-installer`,
  forbidden otherwise, enforced in the schema - and specified where the panel gets it (the
  existing `GET /api/pipelines/installers`, with distinct no-candidate / one / many states).
  Recorded why this does not weaken the argv boundary: the provider re-derives the verified
  candidate set and refuses anything outside it, so a checkout is a selection rather than a path
  the browser can invent. Rejected the alternative of dropping the delegation and deep-linking to
  the Conductor panel instead: it would have narrowed the approved "install it from this page"
  promise for one row, which is a scope decision rather than a defect fix.
