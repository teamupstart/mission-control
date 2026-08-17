# Phase 2: Guided Conductor engine installation

## Outcome

An operator who opens the permanent Conductor settings page without `conduct-ts` sees a native,
machine-scoped setup path. When Mission Control finds a verified local ai-conductor main checkout,
the operator can review that checkout, the user-level locations the upstream installer may change,
and the terminal backend that will open. An explicit **Open installer** action launches the upstream
interactive `bin/install` in a visible hosted terminal.

Mission Control does not answer installer prompts, hide output, download source, or claim the engine
is installed merely because a window opened. The panel keeps checking the real probe and advances to
Phase 1's repository registration state only when `conduct-ts` resolves. When no eligible checkout
exists, the page gives copyable clone/install instructions and an **I installed it, check again**
action.

## Entry criteria and dependencies

- Direct dependency: Phase 1, Always-visible Conductor registration, is merged.
- Direct dependency: the native Conductor onboarding planning artifacts are merged to the default
  branch.
- Read first:
  - `docs/plans/native-conductor-onboarding/plan.md`
  - `docs/plans/native-conductor-onboarding/phased-plan.md`
  - `docs/plans/native-conductor-onboarding/phase-1-always-visible-registration.md`
- Inherited Phase 1 contracts are fixed: provider-owned mutations, unconditional Settings,
  separate registration and observation facts, serialized `useConductor` setup actions, and
  exact-repository Dispatch consent.

## Scope

- Add provider-owned discovery of eligible local installer checkouts.
- Verify main-checkout identity, upstream provenance, and expected ai-conductor markers without
  executing repository code.
- Add a typed read endpoint for installer candidates and a typed terminal-launch endpoint.
- Reuse the existing terminal target registry and launcher.
- Add an explicit confirmation surface naming checkout, possible user-level changes, and terminal.
- Launch the upstream interactive installer in a visible terminal and hold the result open.
- Integrate launch/open/check-again states into Phase 1's commissioning line.
- Provide copyable fallback instructions when no eligible checkout or terminal exists.
- Add focused unit, route, static-render, and Playwright coverage plus final full-suite validation.

## Non-goals

- Cloning or downloading ai-conductor from Mission Control.
- Selecting a release, pinning a version, managing updates, or rolling an installation back.
- Answering upstream installer prompts or interpreting its completion as proof of readiness.
- Running `bin/install --allow-worktree-root` or permitting any worktree-root override.
- Installing from a repository based only on its directory name or files.
- Generalizing Settings into a provider marketplace.
- Changing Phase 1 registration, observation, Runs, Dispatch, or Foreman semantics.

## Repository findings and inherited contracts

### Candidate discovery

`src/server/repos.ts` already scans configured workspace roots and caches the resulting git
repositories. Reuse `listRepos()`; do not walk the filesystem again.

Add an optional installer capability to the server-side `PipelineProvider` rather than adding an
ai-conductor branch to `routes.ts`. A suitable shape is:

```ts
installer?: {
  candidates(repoRoots: readonly string[]): Promise<PipelineInstallerCandidate[]>;
  terminalArgv(checkout: string):
    | { argv: string[]; cwd: string; title: string }
    | { refused: string };
};
```

The shared candidate carries only browser-safe evidence: provider, canonical checkout, recognized
remote label, detected version if readable, and the bounded list of user-level change categories the
confirmation surface explains. It does not carry an executable path chosen by the browser.

For ai-conductor, eligibility requires all of the following on every read and again immediately
before launch:

1. The path is a real git repository from `listRepos()` and resolves to itself through
   `mainRepoRoot()`. A linked worktree or unattributable git directory is refused.
2. A configured remote normalizes exactly to the recognized upstream repository
   `github.com/mancej/ai-conductor`. Accept common SSH and HTTPS spellings, including the current
   `ssh://git@github.com/mancej/ai-conductor`, but not lookalike hosts, suffixes, or arbitrary forks.
3. `bin/install` is a regular executable file inside that physical checkout.
4. `src/conductor/package.json` is a regular file whose parsed package name is
   `@james-stoup-agents/conductor`.
5. `VERSION` is a bounded regular text file. An unreadable version may render unknown, but missing
   required markers refuse the candidate.

Use filesystem reads and fixed git queries only. Never run a checkout's scripts during discovery.
Resolve physical paths before prefix comparisons so symlinks cannot escape the verified checkout.

### Typed routes and terminal ownership

Add `GET /api/pipelines/installers?provider=<id>` beside the other pipeline setup routes. It validates
the provider id, reads the cached workspace catalog, calls only that provider's optional installer
capability, and returns a bounded candidate list. An unsupported provider returns an empty list with
an explanatory capability status, not a guessed command.

Add a Zod request for `POST /api/pipelines/install` with exactly:

- `provider`: append-only pipeline provider id;
- `checkout`: candidate path selected from the prior read; and
- `backend`: registered `TerminalBackendId`.

The route re-resolves and re-verifies the candidate at click time. A stale, moved, newly linked, or
remote-changed checkout is refused before terminal launch. The provider composes installer argv;
the browser cannot supply flags, environment, a shell, title, or cwd.

Reuse `terminalTargetViews()` and the injected `terminalLauncher` already used by pipeline consoles.
For ai-conductor, the command is the verified physical checkout's `bin/install` with no
`--allow-worktree-root`, `--update`, or provider selection flags. The terminal cwd is the verified
main checkout.

The server may compose its existing trusted hold-open shell wrapper after `bin/install` so success
or refusal does not flash away. That shell text is derived entirely from server/provider output via
`shellCommand`; no browser string enters it. Preserve the terminal launcher's 404, 409, 502, and 504
meanings and repeat its may-still-be-opening language for an unknown outcome.

### Confirmation and progress truth

The confirmation surface must state that installation is machine-wide and may:

- build the engine in the selected checkout;
- link `conduct-ts` under the user's local bin directory;
- link Conductor skills for supported agents;
- update Claude user settings and hooks;
- create or update `~/.ai-conductor` configuration; and
- optionally install global Puppeteer, Markdown-viewer, or Mermaid tooling based on upstream prompts.

This is a bounded summary, not a promise of an exact diff. Link the exact checkout path and command
shown in mono text. Require a second explicit confirmation click before opening the terminal.

A successful terminal launch means only **Installer terminal opened**. `useConductor` keeps its
normal four-second panel poll and Check again action. The commissioning Engine stage becomes complete
only when the provider probe reports `found: true`; neither HTTP 200 nor terminal close is proof.

If no terminal backend is available, show the backend-specific reasons from
`TerminalTargetView.unavailable` and retain copyable instructions. Do not fall back to a detached
process nobody can see.

## Implementation steps

1. **Shared setup contracts**
   - Add `PipelineInstallerCandidate`, installer-capability/read result, launch request, and launch
     result shapes in browser-safe shared modules.
   - Keep new fields/routes additive. Do not alter persisted ids or the Phase 1 registration result.

2. **Provider-owned candidate verification**
   - Add the optional installer capability to `PipelineProvider`.
   - Implement ai-conductor candidate checks in a focused module under
     `src/server/pipelines/conductor/` with injected filesystem/git seams.
   - Normalize recognized remote spellings to one exact owner/repository identity and reject every
     other host/path.
   - Reuse `mainRepoRoot()` and physical path checks. Never execute `bin/install --check` for
     discovery because even a read-only script is repository code.

3. **Read and launch routes**
   - Add provider-neutral orchestration in `src/server/pipelines/index.ts`.
   - Add the installer-candidate GET and typed installer-launch POST in `src/server/routes.ts`.
   - Reverify candidates inside POST, then compose provider argv and call the existing terminal
     launcher with a stable Conductor installer title.
   - Preserve terminal launcher statuses and add dependency injection seams for route tests.

4. **Conductor state and confirmation UI**
   - Extend `useConductor` to fetch installer candidates only while the panel is active and the
     engine probe is confirmed missing. Reject stale candidate responses after a newer probe or
     action.
   - Reuse `useTerminalTargets()` for backend availability and selection; do not add a terminal
     registry.
   - Add the confirmation step inside the existing settings panel rather than a full-page wizard.
   - After a successful or outcome-unknown launch, show what opened and instruct the operator to
     finish there. Let probe results, not UI optimism, advance the Engine stage.
   - Add copy buttons for the fallback checkout/install commands using existing clipboard feedback
     patterns.

5. **Visual and accessibility completion**
   - Keep Phase 1's compact `⇶` commissioning line persistent.
   - Use existing `--working`, `--idle`, and `--attention` tokens plus text labels. Reserve danger
     red for an attempted launch that was definitively refused.
   - Keep confirmation focus order logical, announce launch outcomes, and make terminal choices
     keyboard-operable with visible disabled reasons.
   - At the existing narrow Settings breakpoint, stack confirmation details and terminal rows
     without clipping paths or action labels.

6. **Documentation and tests**
   - Complete `docs/pipelines.md` with the guided install flow, verification criteria, possible
     user-level changes, no-checkout fallback, and no-silent-download boundary.
   - Extend focused provider, route, render, and E2E fixtures as described below.
   - Run the final repository-wide verification ladder because this closes the feature.

## API and compatibility details

- The installer candidate and launch routes are additive and localhost-only.
- Candidate results are ephemeral and never persisted. Reverification at launch is authoritative.
- A candidate list becoming empty is not an uninstall signal and never changes observation config.
- A terminal launch does not alter `PipelinesConfig`, publish observation status, or refresh Dispatch.
- Existing Phase 1 registration and config routes remain the only path from engine readiness to
  repository observation.
- The provider installer capability is optional so a future engine without a source-checkout
  installer can still implement probing, registration, observation, and dispatch without inventing
  one.
- No database migration or generated artifact change is required.

## Tests and verification

### Focused unit and route tests

- Candidate verifier accepts the exact upstream SSH and HTTPS remote spellings and refuses lookalike
  hostnames, wrong owners, suffix paths, forks, missing remotes, and malformed git output.
- It refuses linked worktrees, relocated/unattributable git dirs, symlink escapes, missing or
  non-regular installer/package markers, wrong package names, and oversized/malformed VERSION data.
- Discovery never executes a checkout file and bounds every file/query result it returns.
- The GET route validates provider ids, returns supported/unsupported status honestly, uses the
  existing workspace catalog, and bounds/deduplicates candidates.
- The POST route validates all fields, reverifies after candidate staleness, never accepts browser
  argv/flags, composes exact installer cwd/argv/title, and preserves terminal 404/409/502/504
  outcomes.
- Hook/render tests cover missing probe versus missing engine, stale candidate reads, no candidate,
  candidate confirmation, unavailable terminals, launched/maybe-opening/refused outcomes, and probe-
  confirmed transition to registration.

### Browser test

Extend `e2e/specs/settings-conductor.spec.ts` and its fixtures without running the real installer:

1. Seed no eligible checkout and assert copyable fallback plus Check again.
2. Seed a disposable fake checkout with exact markers and a faked recognized remote; assert the
   candidate path and machine-wide change summary.
3. Confirm the installer, select a fake terminal target, and assert the recorded server-composed
   argv/cwd/title. The fixture must intercept before any real terminal or script opens.
4. Change the candidate after GET and before POST; assert reverification refuses it.
5. Return outcome unknown and assert the UI says the terminal may still be opening rather than
   reporting failure.
6. Make the fake probe become installed and assert the same panel advances to Phase 1 registration.
7. Verify the complete Engine -> Register -> Observe path and exact-repository Dispatch gate still
   work after installer UI lands.
8. Capture wide and narrow screenshots with no clipping and no color-only status.

### Commands

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/pipeline-http.test.ts \
  test/settings-sidebar-render.test.ts \
  test/terminal-targets.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Add the implemented installer-verifier and UI test filenames to the focused command. Store browser
evidence in a gitignored location and attach it to the implementation pull request rather than
committing it.

## Merge and exit criteria

- Only verified upstream main checkouts are offered and every launch is reverified.
- The browser never supplies installer argv, shell text, flags, environment, cwd, or title.
- The upstream installer runs only in a visible selected terminal after an explicit confirmation.
- No terminal availability never becomes a detached or background launch.
- The UI claims only that a terminal opened; the real provider probe alone marks Engine complete.
- No checkout yields actionable copyable instructions and a recheck path.
- Phase 1 registration, partial-success recovery, observation, Runs, and Dispatch contracts remain
  intact.
- Focused tests, typecheck, lint, full unit suite, build, smoke, and full Playwright suite are green.
- Documentation describes the machine-wide scope and all safety boundaries.

## Downstream handoff

After this phase, the native Conductor onboarding plan is complete. Future work may add managed
downloads, version/update policy, deregistration, or other providers only as new plans with explicit
trust and compatibility decisions.

Future changes may rely on:

- permanent Settings discovery;
- provider-owned registration and installer capabilities;
- separate registration and Mission Control observation facts;
- reverified local installer candidates;
- visible hosted-terminal installation with no browser-authored commands; and
- exact active-repository gating for Runs and Dispatch.

They must not broaden candidate trust by filename alone, infer installation success from terminal
launch, write provider state directly, or silently acquire executable source.

## Cross-phase audit record

- **2026-08-17 initial audit:** This phase depends directly on Phase 1 because it extends the same
  provider setup seam, hook action state, commissioning UI, and E2E fake. It cannot merge first or
  concurrently.
- **Phase 1 compatibility:** Installer launch never writes observation config and never advances to
  registration optimistically. Phase 1 remains the sole owner of registration, consent, and Dispatch
  readiness.
- **Source-plan reconciliation:** The source plan allowed candidate matching either in provider code
  or a dedicated setup module. The provider's optional `installer` capability is selected because it
  preserves the existing exhaustive provider axis while allowing future providers to omit a
  source-checkout installer honestly.
