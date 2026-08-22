# Phase 2 - The Standing instructions settings panel

Part of [Repository standing instructions](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

An operator can write a standing instruction for a repository in Settings and see it reach the very
next session dispatched into that repository - with the panel stating honestly, per harness and
runtime, which sessions it will and will not touch.

This is the phase that makes the feature exist for a person. Phase 1 built the mechanism; nothing
in the product surfaces it until this merges.

## Entry criteria and dependencies

- **Direct phase dependency: Phase 1.** Its routes, wire types and ETag semantics are consumed
  here as given.
- `npm install`, plus `npx playwright install chromium` once per machine for the e2e suite.
- Read [`plan.md`](plan.md) for the approved goal, [`phased-plan.md`](phased-plan.md) for the
  cross-phase contract, and [`phase-1-store-and-delivery.md`](phase-1-store-and-delivery.md) for
  what is already built.

## Scope

- A new **Standing instructions** settings category and its panel.
- The React state hook, including the stale-response reconcile guard.
- The `api.ts` client functions and the CSS.
- The two read-only markers: the dispatch form's note and the session header's chip.
- The Playwright spec, the panel render test, and the documentation.

## Non-goals

- **Any change to Phase 1's contracts.** The routes, the ETag semantics, the empty-vs-absent rule
  and the longest-match rule are fixed. If the panel seems to want a different one, that is a
  finding to raise in the pull request, not a change to make.
- **Re-deriving the match in the browser.** Call `GET /api/instructions/resolved`. The panel must
  not contain a second implementation of longest-path-match.
- **Editing from the markers.** The dispatch note and the session chip are read-only. One editor,
  in Settings, is the point.
- The standards bundle, adopted sessions, and the composer - all still out of scope per the
  approved decisions.

## Inherited contracts

From Phase 1, relied on and not changed:

| Contract | Meaning |
|---|---|
| `GET /api/instructions` | `StandingInstructionsView` - default, repositories, one opaque ETag |
| `PUT /api/instructions` | CAS on `expectedEtag`; `409` `{error, code, current}`; `413` oversize |
| `GET /api/instructions/resolved?repoRoot=` | effective text, matched key, and delivery mechanism |
| absent key | inherit the machine-wide default → renders the `inherited` chip |
| key present, `""` | send nothing for this repository → still an `override` |
| `null` in a patch | remove the key → what **Use global default** sends |
| `STANDING_INSTRUCTIONS_MAX_LENGTH` | 8,000 - the counter's denominator |

## Repository findings

These are hard gates measured in this repository. Each one fails the build if missed.

### Tests that fail on a bare registry entry

1. **`test/settings-search.test.ts:134-140`** - *"every category has at least one control indexed"*.
   A registry entry alone fails this. You must add a `SETTINGS_CONTROLS` entry in
   `src/web/lib/settings-search.ts` (Conductor's is `:431-437`, 7 lines).
2. **`test/settings-sidebar-render.test.ts:210-229`** - anchors. Every `data-anchor` prefix must be
   a real category id; it must equal the category whose panel rendered it; no anchor may repeat
   anywhere in the app; and **every category must contribute at least one anchor** (`:227`, "has no
   anchored control").
3. **`test/settings-sidebar-render.test.ts:274-296`** - every `<svg>` in every category must
   declare explicit `width` **and** `height` attributes. Relevant if the reach block uses icons;
   text glyphs are unaffected.
4. **`test/tooltip-coverage.test.ts`** - a TypeScript-AST source scan over `src/web/**/*.tsx`. Every
   `<button>`, `<a>`, `<select>`, checkbox, radio, `<summary>` and `role="button|tab|switch"` in the
   new panel must be wrapped in `<Tooltip>`, and **no `title=` attribute anywhere**. This constrains
   how the panel is written, not which tests get edited.

Passing automatically if the registry entry is well formed: `test/settings-route.test.ts:41`,
`test/palette-index.test.ts:601-611`, and the sidebar's rail/group/order/scope walks
(`:113`, `:146`, `:160`, `:169`). Note `:160` asserts **registry order is draw order**, so the new
entry must sit contiguously inside the *Sessions* group.

### The highest-risk part is the hook, not the panel

`src/web/useTaskSources.ts:49-60` documents four separate defects that were all one bug: a poll
response overwriting an in-flight optimistic edit, which the next field commit then persisted -
silently reverting the operator's config. Both config hooks carry a `viewRef`, a sequence counter,
and `readIsCurrent` from `src/web/harnesses-reconcile.ts`.

This panel is **more** exposed than those, because its edit is a long free-text field the operator
may sit in for minutes while a 4-second poll runs underneath. Reuse the existing reconcile
machinery; do not write a fresh one.

Config hooks **poll and do not use SSE** - `useTaskSources.ts:11-14` states the rule: this is
"coarse, rarely-edited chrome, not worth another SSE channel." `POLL_MS = 4000`.

### The dirty/conflict state machine already exists in prose form

`src/web/workflows/ForemanProfileEditor.tsx` (596 lines) is the closest precedent: a
`{loaded, draft, dirty, conflict}` reducer over an ETag'd document, with focus-refresh reconciliation
at `:54-63` and explicit keep-mine / take-theirs transitions at `:69-79`. Read it before designing
this panel's state. The difference is that this panel holds **N+1** such documents - the default plus
one per repository - so the unit of dirtiness is a repository, while the ETag covers the whole
document.

That asymmetry is the design problem of this phase. A single document ETag means saving repository A
while repository B is dirty must not silently discard B. Simplest correct answer: send the whole
`repositories` map on every PUT with the ETag you last read, and surface the `409` as a conflict the
operator resolves - exactly what `ForemanProfileEditor` does for one document.

### Sizing anchors

Panel 300-400 lines (ConductorPanel +326, TaskSourcesPanel +303, WorktreeSettingsPanel +382 at
introduction). Hook 150-200 (useConductor +157, useWorktrees +168). Registry entry 9-24;
`SettingsPage.tsx` 6-8; `settings-search.ts` 7-27; `api.ts` ~15; CSS 60-300 depending on whether the
card reuses `.kb-row` / `.settings-hint` / `.settings-warn` or invents a shape.

## Implementation steps

### 1. Registry entry - `src/web/lib/settings-registry.ts`

Append inside the **Sessions** group, contiguously, after `skills` and before `cost`:

```ts
{
  id: "standing-instructions",
  label: "Standing instructions",
  icon: "✎",
  blurb: "Text every session gets, per repository",
  group: "sessions",
  scope: "machine",
  keywords: ["instruction", "prompt", "repository", "always", "rule", "preamble", "per-repo"],
},
```

`scope: "machine"` is the approved decision and it is the honest badge: the daemon acts locally and
nothing is written to `~/` or sent to GitHub. Do not use `home` - that badge means "Writes ~/",
which Skills and Cost do and this does not.

### 2. `SettingsPage.tsx`

Panel import, hook import, hook call, and one `case` in `renderCategory`. Roughly 6-8 lines,
matching how `worktrees` and `task-sources` are wired.

### 3. The hook - `src/web/useStandingInstructions.ts` (new)

Model on `useTaskSources.ts` / `useConductor.ts`. Poll at 4000ms, gated on the category being
active. Carry `viewRef` + sequence counter + `readIsCurrent`. Expose the view, a per-repository
draft map, dirty flags, the conflict view, and `save` / `revert` / `useGlobalDefault` actions.

### 4. The panel - `src/web/components/StandingInstructionsPanel.tsx` (new)

Layout is specified by the mockups in [`plan.html`](plan.html); read them rather than inventing.

- A machine-wide **Every repository** block at the top with its own counter.
- A repository list below. Each card: disclosure header with `RepositoryName` (leaf plus full path
  in a tooltip - that component's stated rule), an `override` / `inherited` chip, the textarea, an
  `n / 8,000` counter, the **reach** block, and the buttons.
- **Use global default** is disabled unless there is an override to remove, mirroring
  `WorktreeSettingsPanel.tsx:191-193`, and sends `null` for that key.
- Adding a repository uses `RepoCombobox` and resolves through `resolveRepo` before staging, the
  way `TrustPanel` and `CommandLibrary.tsx:560-585` already do. A subdirectory is a legitimate key.

The **reach** block is a required part of this phase, not decoration. It states per harness and
runtime which sessions get the text and by which mechanism, and it is the honest answer to the one
question a standing instruction otherwise leaves an operator guessing at. Its "sessions started
outside Mission Control - not reachable" line is a shipped, tested string, because decision `reach`
made that a deliberate product boundary rather than a gap.

Every interactive element wrapped in `<Tooltip>`; no `title=`. At least one `data-anchor`.

### 5. `api.ts` and `settings-search.ts`

Client functions for the three routes. A `SETTINGS_CONTROLS` entry per anchored control - required,
per the gate above.

### 6. The two markers

- **Dispatch form** (`DispatchModal.tsx`): a read-only note naming the size **and** the mechanism,
  reading `GET /api/instructions/resolved` for the selected repository, agent and runtime. It must
  update when the repository selection changes.
- **Session header**: a chip that reveals the composed text.

Both name the mechanism, not just the fact of delivery: on Claude the text rides the system prompt
and never enters the transcript, so a marker that only said "sent" would send an operator searching
a conversation for something that was never in it.

### 7. Documentation

`docs/skills-and-settings.md` gains the category. While in that file, correct its stale section at
lines 237-250, which still calls Conductor "the one category that is conditional" - contradicting
both the current registry and `docs/agent-guides/change-contracts.md:747-755`.

## Tests

### Node

- A panel render test, `test/standing-instructions-panel.test.ts`, modelled on
  `test/conductor-panel.test.ts` (487 lines) or `test/task-sources-panel.test.ts` (240):
  `inherited` vs `override` chips, the counter, the disabled **Use global default**, the reach
  block's rows, and the empty state.
- Additions to `test/settings-sidebar-render.test.ts` (~30 lines): the conventional pair that every
  recent category added - "Standing instructions is a category of its own: its panel shows, the
  others don't", and "with no answer from the daemon, the panel says so rather than showing an
  empty list."
- Hook reconcile tests: a poll landing mid-edit must not clobber the draft, and must not be
  persisted by the next commit. This is the bug `useTaskSources.ts:49-60` records; pin it here.

### e2e - required

New spec in `e2e/specs/`, read [`e2e/README.md`](../../../e2e/README.md) first. Two models to
combine:

- **`e2e/specs/settings-worktrees.spec.ts`** (216 lines) for the settings half: navigate to
  `#/settings/standing-instructions`, assert the tab is `aria-selected`, drive the real controls,
  read the daemon DB through `withDaemonDb`.
- **`e2e/specs/harness-defaults-propagate.spec.ts`** (314 lines) for the proof that it *arrived*.
  Its assertion shape is exactly what this feature needs: the fake agents record `{argv, cwd}` JSON
  into a record dir, and the spec reads them with `recordsIn<{argv: string[]}>(dir)` to prove a
  setting changed in Settings reached the very next dispatch's command line - with no daemon
  restart.

Cover three things:

1. Write a rule for a repository, save, reload, read it back.
2. Dispatch into that repository and assert the rule arrived - visible in the recorded argv as the
   `--append-system-prompt` value for Claude terminal, and in Pi's argv, whose turn one rides the
   command line via `preparePiLaunch`.
3. Dispatch into a repository with **no** rule and assert it did not.

Two standing constraints: **never spend model tokens** - every agent binary is redirected at a fake
by `e2e/fixtures/fake-agents.ts` - and **never add `data-testid`**. Select by role, label or
placeholder.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

`npm run build` before `test:e2e`: the e2e suite drives the **built** dashboard served by the
**built** daemon.

## Merge and exit criteria

- The category is reachable, and every settings registry gate above passes.
- A rule written in Settings reaches the next dispatch, proven in a browser by the e2e spec.
- A repository with no rule still dispatches without one.
- A poll landing mid-edit does not revert the operator's text.
- The reach block states all five harness · runtime pairs and the two deliberate exclusions.
- Docs updated, including the stale Conductor sentence.
- Typecheck, lint, tests, build and e2e green; one reviewable pull request merged.

## Downstream handoff

Nothing depends on this phase - it is the last. Two things a later change should know:

- The panel is the only editor. A per-session or one-shot override, if it is ever wanted, extends
  the same store rather than adding a second one.
- An injection into adopted sessions was deliberately deferred, not forgotten. It would reuse this
  store and `recordInjection`, and it would make the reach block's `✗` row into a control.

## Cross-phase audit record

- **Audited against Phase 1 after writing.** No contract conflicts: this phase consumes the routes,
  the ETag semantics and the empty-vs-absent rule exactly as Phase 1 fixes them, and adds nothing to
  the wire.
- The N+1 documents against a single document ETag was identified here rather than in Phase 1, and
  **deliberately not pushed back into it**. A per-repository ETag would be a larger, riskier store
  and the whole-document PUT with a `409` is the behaviour `ForemanProfileEditor` already proves in
  this codebase. Recorded as a resolved design question, not a Phase 1 change.
- The `data-anchor` and `SETTINGS_CONTROLS` gates are wholly inside this phase's files, so no
  earlier phase needed editing.
- Confirmed both phases are single-repository, so each produces exactly one pull request.
