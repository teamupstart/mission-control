# Phase 2: Environment checks registry, dispatch-time warning, and the Upstart README section

Implements Track A of [plan.md](plan.md). Read [phased-plan.md](phased-plan.md) for how this
phase relates to the others. This phase is independent of Phases 1 and 3 and may merge in any
order relative to them.

## 1. Outcome

Two deliverables:

1. A README section, "Running Mission Control at Upstart", documenting how MC composes with
   the UpstartClaw plugin set (install `upstartclaw-core`, run its setup interactively once,
   ensure `NODE_EXTRA_CA_CERTS` reaches the daemon so SDK sessions trust VPN-inspected TLS).
2. A **non-blocking** dispatch-time warning: when the operator's machine has UpstartClaw core
   installed but its setup state file does not read `completed`, the Dispatch form shows a
   warning that an unattended dispatched agent will stall on Claw's PreToolUse setup gate.
   The warning never disables dispatch.

## 2. Entry criteria and dependencies

- Direct prerequisite: the planning session's PR (this document reachable on the default
  branch). No other phase is a prerequisite.

## 3. Scope and non-goals

In scope: a small generic environment-checks registry (shared ids + server impls), one
always-200 GET route, the dispatch-modal warning render, one Playwright spec, unit tests, the
README section and a Dispatch-section paragraph.

Non-goals:

- Not a doctor panel, not a Settings category, not part of `SettingsStatus` (a fixed struct of
  the daemon's own config; `src/server/settings-status.ts` module comment) and not
  `ui-config.ts` (which documents that no other module reads it).
- The warning must not gate `submit` (`DispatchModal.tsx:773-780`) or the primary button's
  `disabled` (`:1464-1471`) - that is `selectedWorkflowBlocked`'s blocking behavior, which
  this deliberately is not.
- No detection of whether the dispatched agent actually stalls (the e2e fake agents never
  enforce a PreToolUse gate; only the warning is assertable).
- No `if (upstart)` branches outside a registry entry (plan decision, "What does not fit").

## 4. Repository findings (verified 2026-08-05)

- **There is no environment-check surface today.** No dispatch preflight route exists; the
  only in-form warning (`selectedWorkflowBlocked`, `DispatchModal.tsx:659-662`, rendered
  `:1221-1227` as `.dispatch-workflow-warning`, `styles.css:5566`) is client-derived and
  blocking. The bordered amber note style is `.dispatch-wait-note` (`styles.css:5705`).
- **The registry shape to copy is open-targets**: `OPEN_TARGETS: Record<OpenTargetId, OpenTargetImpl>`
  (`src/server/open-targets/index.ts:21-23`) with browser-safe ids/info in
  `src/shared/open-targets.ts`, injectable `defaultOpenDeps` (`index.ts:25-31`), per-item
  try/catch so a throwing impl becomes its own refusal (`resolveTarget`, `:37-43`), the
  `unavailable: string | null` vocabulary, and **nothing cached** (doc `:45-51`).
- **Read-on-request discipline**: `skillDrift` re-reads the disk on every poll
  (`src/server/skills/reconcile.ts:616-628`); a boot-time cache would make the e2e spec
  unable to arrange both states (the daemon boots before the spec body runs).
- **Home resolution**: the check asks "what is the machine's live install", which is the
  `operatorSkillsDirs` question (`reconcile.ts:117-124`) - `homedir()`, NOT `envVar("HOME")`.
  Node's `homedir()` follows `$HOME` on POSIX, which is exactly how the e2e daemon isolates
  (`e2e/fixtures/daemon.ts:147`, `HOME: home`). For `node:test` isolation, take the
  state-file path from an injectable dep (the `defaultOpenDeps` pattern) or a
  `CLAUDE_SETTINGS_PATH`-style env override (`src/shared/claude-settings.ts:56` precedent) -
  unit tests must never read the developer's real `~/.claude`.
- **The Claw facts** (from the UpstartClaw exploration recorded in plan.md): the state file is
  `~/.claude/upstartclaw-core-setup` with values `no_setup` / `in_progress` / `completed`;
  the plugin's PreToolUse gate blocks its core MCP calls with exit 2 until the file reads
  `completed`. "Plugin installed" is observable as the plugin present under
  `~/.claude/plugins/` (cache/install layout may vary by Claude Code version - detect
  presence tolerantly, e.g. any path component matching `upstartclaw-core` under
  `~/.claude/plugins`; when in doubt, the state file existing at all is itself evidence the
  plugin has run).
- **Warning semantics** (keeps the generic surface honest on a non-Upstart machine):
  - Plugin absent AND no state file -> silent (`warning: null`).
  - State file exists and reads `completed` -> silent.
  - Plugin present (or state file exists) and the value is anything else -> warning naming
    the fix: run `/upstartclaw-core:setup` in an interactive Claude Code session.
- **Route placement**: a new always-200 GET beside the UI-config/cost-config region
  (`routes.ts:3053-3087`). `POST /api/ensembles/preview` (`routes.ts:1752-1760`) is the
  precedent that a validation read is a 200 carrying its own result.
- **Fetch site**: the dispatch modal's existing mount-only effect (`DispatchModal.tsx:736-751`)
  already fetches repos and workflow config with swallow-on-failure; add the third fetch
  there.
- **README placement** (verified section map): the new `##` section goes between
  `## Isolated worktrees per session (treehouse)` (line 5459) and `## Configuration` (5697) -
  the region where the README parks external tooling MC cooperates with - plus a short
  paragraph inside `## Dispatch an agent` (near the After-work warning prose, ~1394-1408)
  linking down. `NODE_EXTRA_CA_CERTS` has no Configuration-table row today; mention it in the
  new section rather than adding a row (it is not an MC variable).

## 5. Implementation steps

1. **`src/shared/environment-checks.ts`** (new, browser-safe, no `node:` imports):
   - `ENVIRONMENT_CHECK_IDS = ["upstartclaw-core-setup"] as const` - append-only, documented
     as such (the id will appear in warning-dismissal or telemetry keys eventually; treat it
     like the other persisted tuples in `docs/agent-guides/change-contracts.md:38-70`).
   - `ENVIRONMENT_CHECK_INFO: Record<EnvironmentCheckId, { label: string; blurb: string }>`.
   - `EnvironmentCheckView = { id; label; warning: string | null; detail?: string }` - the
     wire shape.
2. **`src/server/environment/`** (new):
   - `index.ts`: `ENVIRONMENT_CHECKS: Record<EnvironmentCheckId, EnvironmentCheckImpl>`,
     injectable deps (`readFile`/`exists`/`homedir`), `environmentCheckViews(deps?)` mapping
     every id through a try/catch so a throwing check becomes its own warning ("the check
     failed: ..."), never a 500 and never taking the list down.
   - `upstartclaw.ts`: the one check, implementing the semantics table above. Read the state
     file with a bounded read; treat unreadable-but-present as not-completed (warn), missing
     as plugin-detection-dependent per the table.
3. **Route**: `GET /api/environment/checks` in `routes.ts` (placed in the ~3053-3087 region)
   returning `{ checks: EnvironmentCheckView[] }`, always 200, computed per request.
4. **`src/web/lib/api.ts`**: `fetchEnvironmentChecks()`.
5. **`src/web/components/DispatchModal.tsx`**:
   - Fetch in the mount-only effect (`:736-751`), `.catch(() => {})`, store
     `envWarnings: EnvironmentCheckView[]` filtered to `warning !== null`.
   - Render each warning as a bordered amber note (the `.dispatch-wait-note` shape,
     `styles.css:5705`, or a sibling `.dispatch-env-note` class) above the footer, with the
     check's `label` and `warning` text. Non-blocking: no change to `submit` or the primary
     button.
   - Accessibility: the note is plain text in the dialog flow (no `role="alert"` needed for a
     mount-time fact; follow how `dispatch-wait-note` renders).
6. **Tests**:
   - `test/environment-checks.test.ts`: the registry contract (every id implemented, label
     non-empty, a throwing impl becomes its own warning) and the Claw check's semantics table
     via injected deps (absent/completed/in_progress/no_setup/unreadable).
   - Extend the dispatch-modal render test surface if one exists for the warning region
     (`renderToStaticMarkup` pattern); otherwise the e2e spec is the UI coverage.
7. **Playwright spec** (`e2e/`): a `dispatch-environment-warning` spec.
   - Arrange: `mkdirSync(join(daemon.home, ".claude"), { recursive: true })` and write
     `upstartclaw-core-setup` with `in_progress` (precedent: specs already write into
     `daemon.home`, e.g. `cost-chip.spec.ts:24`). The daemon env sets `HOME: home`
     (`daemon.ts:147`), so `homedir()` resolves there.
   - Open the Dispatch modal (reuse the `openDispatch` shape from
     `scout-after-work-default.spec.ts:21-51`; dispatch nothing) and assert the warning text
     is visible.
   - Flip the file to `completed` and assert (after reopening the modal) the warning is gone -
     this is what forces read-on-request. Assert absence only after having made it present
     (`e2e/README.md` trap list).
8. **README** (same change):
   - New `## Running Mission Control at Upstart` section between treehouse (5459) and
     Configuration (5697): what UpstartClaw is (one paragraph, linking the plan), install
     `upstartclaw-core` and run `/upstartclaw-core:setup` interactively once (OAuth cannot
     complete in a headless dispatched session), `NODE_EXTRA_CA_CERTS` must be present in the
     daemon's environment for SDK sessions behind the VPN, the dispatch warning and what it
     means, and the one-owner-per-concern boundary (disable Claw's `notify` plugin when MC's
     alerts run; MC's statusline wrapper delegates to Claw's statusline). Cross-link
     `## Security` for the guard-hooks angle and the Task sources section for pulling Jira
     work (generic link, not Phase-1-dependent).
   - A short paragraph in `## Dispatch an agent` describing the environment warning, linking
     the new section.

## 6. Data / API / migration

No DB change. One new GET route (read-only, always 200). One new append-only id tuple
(`ENVIRONMENT_CHECK_IDS`).

## 7. Verification

```sh
npm run typecheck
npm run lint
node --test --test-concurrency=2 --import tsx test/environment-checks.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e
```

## 8. Merge and exit criteria

- The warning appears when the state file reads `in_progress`/`no_setup`, disappears when
  `completed` or absent-with-no-plugin, and never blocks dispatch.
- A non-Upstart machine sees nothing: no warning, no chrome, no chip.
- The route recomputes per request (no boot-time cache).
- README section and Dispatch paragraph land in the same change.

## 9. Downstream handoff

Later phases may rely on: `ENVIRONMENT_CHECK_IDS` being append-only; `GET /api/environment/checks`
returning `{ checks: EnvironmentCheckView[] }` with per-check `warning: string | null`; and the
"Running Mission Control at Upstart" README section existing as the anchor for
Upstart-specific documentation (Phase 1's Jira docs live in the Task sources section and may
cross-link it, in either merge order).

## 10. Cross-phase audit record

- 2026-08-05: Initial version. README regions disjoint from Phases 1 and 3 (see Phase 1's
  audit record). The registry deliberately does not touch `SettingsStatus`, `ui-config`, or
  the settings rail dots, so no contract overlap with any settings surface another phase
  edits.
