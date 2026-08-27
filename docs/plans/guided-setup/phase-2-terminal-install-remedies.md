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

3. **The pair-availability check is enforced in the launcher, not in the picker**, and this
   phase must not add a second copy of it. `launchTerminal` (`src/server/terminal/targets.ts:235`)
   is the first thing every launch goes through, and it re-derives the answer per call:

   ```ts
   const view = terminalTargetViews(deps).find((v) => v.id === backend);
   if (!view) return { ok: false, label: backend, error: "no such terminal", status: 404 };
   if (view.unavailable) {
     return { ok: false, label: view.label, error: view.unavailable, status: 409 };
   }
   ```

   So a request naming a backend that cannot open a window - stale, crafted, or simply a machine
   whose emulator was uninstalled between the picker's read and the click - is refused **before
   anything is spawned**, with that backend's own `unavailable` sentence. It goes further than a
   presence test: for a multiplexer whose detached session starts but cannot be raised, it cleans
   the session up and returns `502` with "session started but no terminal could show it", which is
   the invisible-terminal failure this whole module exists to prevent.

   `GET /api/terminal-targets` (`routes.ts:2791`) answers the same question for the browser, and
   the picker reads it so the UI does not *offer* a target that must fail. That is a courtesy, not
   the boundary - the boundary is the launcher, one implementation shared with the pipelines
   install route and every other caller. **What this phase owes is not a third check but faithful
   propagation:** see the launch step below.

4. **`PipelineInstallerLaunchSchema` (`src/shared/protocol.ts:2700`)** is the schema shape to
   follow for the new body, and `parseBody(c, Schema)` is the parsing contract.

5. **The e2e harness can drive this without installing anything.** `CMUX_BIN` points at a fake
   that records the `new-workspace --command` it was handed (`e2e/fixtures/fake-agents.ts`), so a
   spec can assert the exact command line a click asked a terminal to run - which is the only
   assertion that actually proves the argv boundary from the outside.

## Implementation steps

### 1. The argv guard - do this first

In `src/shared/setup-catalog.ts`'s neighbourhood or a small `src/server/setup/argv.ts`, a
predicate over a **closed grammar of whole invocations** - not an allowlist of programs. Checking
`argv[0]` alone is not a boundary: `npm uninstall`, `npm publish`, `npm run <script>`,
`npm exec` / `npx`, `brew uninstall`, and `brew services stop` all begin with an allowlisted
program, carry no shell metacharacters, and would each be launched in a terminal. Several of them
execute arbitrary code from the repository or registry, which is the opposite of "a
package-manager invocation with a fixed package name".

So the grammar names the whole shape, program by program:

```ts
/** The only invocation shapes a `command` remedy may express. Closed; see below. */
const INSTALL_GRAMMAR = [
  { program: "brew", subcommand: "install", allowedFlags: ["--cask"], operands: 1 },
  { program: "npm",  subcommand: "install", allowedFlags: ["-g", "--global"], operands: 1 },
] as const;
```

The accepted argv is an **ordered shape**, not a bag of permitted tokens:

```
argv = [ program, subcommand, ...flags, operand ]
```

Positional, because "any remaining element may be a flag or the operand" is a materially weaker
rule that admits `npm install pkg -g` and `npm install -g -g pkg`. An argv is accepted only when
**all** of these hold:

- it is a non-empty array of plain strings, and `argv[0]` matches a grammar entry's `program`
  exactly;
- `argv[1]` equals that entry's `subcommand` **literally**. No aliases: `i`, `add`, `x`, and
  `exec` are not `install`, and accepting them would reopen the hole this rule closes;
- **every flag appears in `argv[2..n-1]`, before the operand, and each allowed flag at most
  once.** A flag after the operand is refused, and so is a repeated flag - both are accepted by
  the looser reading, and neither has a legitimate catalog use. An unrecognised flag is refused
  too, rather than ignored: flag injection is how `--ignore-scripts`-style behavior gets flipped;
- **the operand is the last element, and there is exactly one** (`operands`, which is `1` for
  every entry today). Trailing-position is what makes "flags before, package last" checkable in
  one pass instead of inferred from what did not match a flag;
- the operand matches that program's package-name pattern:
  - npm: `/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/`
  - brew: `/^[a-z0-9][a-z0-9+._@-]*$/`

  The pattern is what rejects a **path or a remote spec dressed as a package name**, which is the
  subtler half of the same attack: `npm install -g /tmp/evil.tgz`, `npm install -g ../x`,
  `npm install -g git+ssh://host/repo`, and `npm install -g file:./x` each install arbitrary code
  and each fails the pattern (a leading `/`, a `/` outside the scope group, a `:`). A version
  suffix (`pkg@1.2.3`) is also refused for npm: the catalog names bare packages, so allowing `@`
  outside a scope prefix buys nothing and widens the surface;
- no element contains a shell metacharacter (`|`, `&`, `;`, `<`, `>`, `` ` ``, `$`, `(`, `)`,
  newline, or a quote), `sudo`, or `://`. Redundant given the rules above, and kept as the
  belt-and-braces layer that still holds if the grammar is later widened.

**The grammar is closed, and widening it is a plan decision rather than a catalog edit.** That is
the actual escalation path: adding `{ program: "npm", subcommand: "exec" }` is a two-line diff
that turns this route into arbitrary code execution, so it belongs in review as a design change
and the grammar's comment says so.

Anything a catalog entry cannot express this way carries a `link` instead. The install route
re-runs this predicate **even though the catalog is committed source** - the guard's job is to
make a bad future catalog edit a refused request rather than a shell injection, and a check that
only runs at authoring time does not do that.

**The honest limit.** Even an accepted `npm install -g <pkg>` runs that package's install scripts,
which is arbitrary code from the registry. No argv guard can prevent that, and it is not this
guard's claim. What the guard bounds is what Mission Control will *ask* a terminal to do; the
operator watching a visible terminal, and the fact that they would have run the same command
themselves, is what covers the rest. This is why the remedy is never executed inside the daemon.

**Scope: `command` remedies only.** A `provider-installer` remedy's argv belongs to the pipeline
provider, which verifies its own checkout and markers at click time, and its `bin/install` is not
a package-manager invocation - running this allowlist over it would refuse the one remedy that
already has a vetted installer. See the route's `switch` below.

### 2. `POST /api/setup/install`

- Body schema in `src/shared/protocol.ts`:
  `{ id: SetupDependencyId, backend: TerminalBackendId, checkout?: string }`.
  **No argv, no cwd, no title, no command string.** Parse with `parseBody`.

  The schema validates **shape only**: three fields, correct types, `id` a member of
  `SETUP_DEPENDENCY_IDS`, `backend` a member of the terminal backend union, `checkout` a non-empty
  string when present. It deliberately does **not** try to enforce the pairing rule below, because
  it cannot: whether this `id` resolves to a `provider-installer` remedy is catalog knowledge, and
  a schema that reached for it would either fail valid provider installs or relocate catalog
  semantics into the protocol layer.

  `checkout` is **required when the remedy is `provider-installer` and forbidden otherwise**, and
  that pairing is enforced in the handler immediately after the catalog lookup - step 2 below -
  as its own refusal with its own sentence. Ordering matters: shape, then lookup, then pairing,
  then launch. It exists because `pipelineInstallerLaunch(provider, checkout, repoRoots)` is
  checkout-based: candidates are local source checkouts in the workspace catalog, and there is no
  "the" checkout for the route to assume.

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
  1. look the remedy up in the catalog. **There is no not-found arm**, and that is a property
     rather than an omission: the schema already established that `id` is a member of
     `SETUP_DEPENDENCY_IDS`, and `SETUP_DEPENDENCY_INFO` is a total `Record` over that tuple, so
     the lookup cannot miss. An id outside the tuple never reaches here - `parseBody` refuses it
     with a 400, which is what `routes.ts:5615` already does for a provider id outside its closed
     set. Do not add a defensive 404: it would be unreachable, and an unreachable arm invites a
     later widening of the schema that makes it reachable without anyone noticing.

     The body's `id` is a `SetupDependencyId`, so neither a folded environment-check row nor the
     derived terminal-pair row is addressable here by construction - both live in other arms of
     `SetupRowId`, and the folded row's remedy is a `skill` the operator runs in a session, which
     this route refuses anyway;
  2. **enforce the checkout pairing**, now that the remedy is known. A `provider-installer`
     remedy with no `checkout` is a 409 saying which checkout to pick; any other remedy that
     carries one is a 409 saying that remedy takes none. This is the step the schema could not do,
     and doing it here is what keeps catalog knowledge out of the protocol layer. Both refusals
     precede every launch path;
  3. switch on `remedy.kind`:
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
  4. launch via `terminalLauncher` and map its outcome faithfully, **preserving both the status
     and the sentence**. The launcher has already refused an unavailable or unknown backend
     (finding 3), so this route's job is to not lose that answer:
     - `404` (no such terminal) and `409` (that backend cannot open a window) -> `refused`,
       carrying the launcher's own sentence. Do not substitute a generic message: "tmux is
       available but no terminal could raise it" is the only version an operator can act on.
     - `502` (started but nothing could show it) -> `refused` as well, **never `opened`**. The
       launcher has already cleaned the detached session up; reporting success here would be the
       exact invisible-terminal lie the launcher went to the trouble of preventing.
     - `504` (the backend did not report back) -> `maybe-opening`, for the reason finding 1 gives.
     - success -> `opened`.
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

- `test/setup-install-argv.test.ts` - the guard, adversarially. This is the phase's most
  important test, and it is organised by attack rather than by field:
  - **shell escape**: a pipe, a redirect, a backtick, a command substitution, a newline, an
    embedded quote, `sudo` in first and in later position;
  - **wrong program**: an empty array, a non-grammar program, an absolute path to a real
    package manager;
  - **wrong verb, right program** - the case that motivated the grammar: `npm uninstall`,
    `npm publish`, `npm run build`, `npm exec`, `npx`, `brew uninstall`, `brew services stop`,
    plus the aliases `npm i` and `npm add`;
  - **operand that is not a package**: `/tmp/evil.tgz`, `../x`, `git+ssh://host/repo`,
    `file:./x`, `pkg@1.2.3`, a leading-dash operand, zero operands, two operands;
  - **flag injection and ordering**: an unrecognised flag; an allowed flag repeated (`npm install
    -g -g pkg`); a flag after the operand (`npm install pkg -g`) - the two forms the earlier
    unordered wording would have admitted; a flag in place of the operand;
  - **accepted forms**, so the guard is not vacuously strict: `brew install gh`,
    `brew install --cask <name>`, `npm install -g <pkg>`, `npm install -g @scope/pkg`.
- `test/setup-install-route.test.ts` - an id outside `SETUP_DEPENDENCY_IDS` refused **400 by the
  schema**, before any lookup (there is no 404 arm; see step 1); `link` and `skill` remedies
  refused; **a
  `provider-installer` remedy reaching the delegated launch rather than the refusal** (the
  ai-conductor row is the case, and getting this wrong makes the one dependency with a real
  installer the one that cannot use it); a `provider-installer` request with **no** checkout
  refused by the handler's pairing step with a sentence naming what to pick; a `command` request
  that **carries** a checkout refused by that same step; a structurally malformed body (missing
  `backend`, unknown `id` type, empty-string `checkout`) refused by the schema, which is the split
  worth pinning - shape in the schema, catalog-dependent pairing in the handler; a checkout that
  is **not** a verified candidate refused with the provider's own sentence and without reaching
  the terminal layer; a `command` entry whose argv fails the guard refused **without** reaching
  the terminal layer (assert the launcher was not called); the happy path handing exactly the
  wrapped argv to the launcher.

  Then the outcome mapping, one case per status the launcher can return, because losing one of
  these is how a refusal becomes a silent success: a stub launcher returning `409` surfaces as
  `refused` **with the launcher's sentence** rather than a generic one; `404` likewise; **`502`
  surfaces as `refused` and never as `opened`**; `504` as `maybe-opening`. The `409` case is the
  one that covers a request naming a backend that cannot open a window - the route inherits that
  refusal from `launchTerminal` rather than re-checking, so the test asserts the inheritance.
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
- **Inspector round 16 (major, PR #800), partially adopted.** The finding was right about this
  document and wrong about the repository. Finding 3 described the pair-availability check as
  something the browser picker does, which reads as though a crafted or stale `POST` could reach
  `terminalLauncher` with a multiplexer that has no emulator - so the review asked the handler to
  re-check against `terminalTargetViews`. It already cannot: `launchTerminal`
  (`src/server/terminal/targets.ts:235-244`) re-derives the views on every call, refuses an unknown
  backend `404` and an unavailable one `409` before spawning, and for a detached session that
  cannot be raised cleans it up and returns `502`. Adding a second check in this route would be a
  duplicate of the one place that owns the rule, which is what this plan forbids elsewhere for the
  same reason.

  So: corrected finding 3 to say where the enforcement actually lives (with the code), and fixed
  the real gap the finding exposed, which is on this route's side of the boundary - the outcome
  mapping was one clause ("preserve the status code") and is now explicit per status, because the
  way this feature could still show an invisible terminal is a handler that swallows a `409`
  sentence or maps `502` to `opened`. Tests added per status, asserting the inherited refusal
  rather than a re-check.
- **Inspector round 8 (minor, PR #800).** The route said "404 for an unknown id" while the body
  schema was specified to require `id` to be a member of `SETUP_DEPENDENCY_IDS`, so the 404 was
  unreachable and its test unsatisfiable. Resolved in favour of the schema owning membership,
  which is this repository's existing answer for an id outside a closed set (`routes.ts:5615`
  returns 400 for an unknown pipeline provider), and stated why there is no not-found arm at all:
  `SETUP_DEPENDENCY_INFO` is a total `Record` over the tuple, so the lookup cannot miss. Also
  recorded why not to add the arm defensively - an unreachable branch invites a later schema
  widening that quietly makes it reachable.
- **Inspector round 7 (major, PR #800).** The grammar's prose ("every remaining element is either
  an allowed flag or the single operand") contradicted its own test list, which required a
  repeated flag and a flag after the operand to be refused. The loose reading admits
  `npm install pkg -g` and `npm install -g -g pkg`, and prose is what gets implemented when the
  two disagree. Restated the accepted argv as an ordered shape -
  `[program, subcommand, ...flags, operand]` - with flags confined to the middle, each allowed
  flag at most once, and the operand required to be the last and only one. The test names the two
  admitted forms explicitly so the regression is pinned rather than described.
- **Inspector round 6 (major, PR #800).** The body schema was told to enforce "checkout required
  for `provider-installer`, forbidden otherwise", which a schema over `{ id, backend, checkout? }`
  cannot do: whether an id resolves to that remedy kind is catalog knowledge, so the instruction
  would have produced either a schema that rejects valid provider installs or one that copies
  catalog semantics into the protocol layer. Split the responsibilities explicitly - the schema
  validates shape, the handler enforces the pairing in a new step 2 immediately after the catalog
  lookup and before any launch path - and moved the two pairing test cases off the schema onto that
  step, keeping a structural-malformation case on the schema so the split itself is pinned.
- **Inspector round 5 (major, PR #800).** The guard allowlisted `argv[0]` only, so `npm
  uninstall`, `npm publish`, `npm run <script>`, `npm exec` / `npx`, `brew uninstall`, and
  `brew services stop` all passed every stated check - several of them executing arbitrary code,
  which is precisely what the "fixed package name" boundary was supposed to exclude. Replaced the
  program allowlist with a closed grammar of whole invocations (program + literal subcommand +
  allowed flags + exactly one operand matching a package-name pattern), which also closes the
  subtler half the review did not name: a path or remote spec dressed as an operand
  (`/tmp/evil.tgz`, `../x`, `git+ssh://…`, `file:./x`). Recorded that widening the grammar is a
  plan decision rather than a catalog edit, since adding one entry is what would turn this route
  into arbitrary execution, and stated the guard's honest limit - an accepted
  `npm install -g <pkg>` still runs that package's install scripts, which is why the remedy runs
  in a visible terminal and never inside the daemon.
- **Inspector round 3 (PR #800).** Phase 1 gained `SetupRowId`, so this route's `id` field is
  explicitly the dependency half of it - stated in the handler steps so nobody widens the body to
  the row id and makes an environment-check row look launchable.
- **Inspector round 2 (major, PR #800).** The follow-on hole in that same fix: the body carried
  only `id` and `backend`, but `pipelineInstallerLaunch` is checkout-based, so the delegation had
  nothing to launch. Added `checkout` to the contract - required for `provider-installer`,
  forbidden otherwise, enforced in the schema (**revised by round 6 above**: the schema cannot
  know an id's remedy kind, so the pairing moved to the handler) - and specified where the panel
  gets it (the
  existing `GET /api/pipelines/installers`, with distinct no-candidate / one / many states).
  Recorded why this does not weaken the argv boundary: the provider re-derives the verified
  candidate set and refuses anything outside it, so a checkout is a selection rather than a path
  the browser can invent. Rejected the alternative of dropping the delegation and deep-linking to
  the Conductor panel instead: it would have narrowed the approved "install it from this page"
  promise for one row, which is a scope decision rather than a defect fix.
