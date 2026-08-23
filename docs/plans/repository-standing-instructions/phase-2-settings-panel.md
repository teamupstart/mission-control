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
- The two read-only markers: the dispatch form's note, reading live config, and the session
  header's chip, reading that session's launch snapshot.
- The Playwright spec, the panel render test, and the documentation.

## Non-goals

- **Any change to Phase 1's contracts.** The routes, the ETag semantics, the empty-vs-absent rule
  and the longest-match rule are fixed. If the panel seems to want a different one, that is a
  finding to raise in the pull request, not a change to make.
- **Re-deriving the match in the browser.** Call `GET /api/instructions/resolved`. The panel must
  not contain a second implementation of longest-path-match.
- **Resolving live config for a session that already launched.** The session chip reads the
  snapshot route and nothing else. See step 6.
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
| `GET /api/instructions/resolved?repoRoot=&agent=&runtime=` | effective text, matched key, and delivery mechanism - **live config, for the dispatch note only** |
| `GET /api/sessions/:id/standing-instructions` | the immutable snapshot of what *that* session received, or `404` - **the only source the session chip may read** |
| absent key | inherit the machine-wide default → renders the `inherited` chip |
| key present, `""` | send nothing for this repository → still an `override` |
| `null` in a patch | remove the key → what **Use global default** sends |
| `STANDING_INSTRUCTIONS_MAX_LENGTH` | 8,000 - the counter's denominator |
| launch resolves, assignment repeats | a running session keeps what it launched with; an edit reaches the next one |

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

That asymmetry is the design problem of this phase, and it has one correct answer: **a save sends
only the repository being saved.**

**Never PUT the whole draft map.** Sending every repository's draft while saving one of them
persists every *other* repository's in-progress text as though the operator had saved it. Nothing
in the panel would say so, **Revert** on those cards would then restore the text that was silently
written rather than the text that was last chosen, and the next session dispatched into one of them
would receive an instruction nobody meant to save. A standing instruction is a rule an agent obeys;
writing one the operator did not commit to is the worst failure this panel has.

The contract already makes the correct save cheap. Phase 1's `repositories` is a **patch**, not a
replacement - the `WorktreesConfigPatchSchema` convention at `src/shared/protocol.ts:2182-2208`:

| In the patch | Means |
|---|---|
| key absent | leave the stored value exactly as it is |
| key present, a string | set it |
| key present, `null` | remove the override |

So saving repository A sends `{ expectedEtag, repositories: { "<A>": draftA } }` and nothing else.
The default's field is the same: saving it sends `{ expectedEtag, default }` with no `repositories`
at all.

The shared ETag then only governs *ordering*, which is what `ForemanProfileEditor` already models
for one document:

- **`200`** - adopt the returned view as the new saved baseline **and its new ETag**, and keep every
  other card's draft in place on top of it. The baseline is what **Revert** restores from, so B now
  reverts to what is genuinely stored rather than to a snapshot taken before A was saved.
- **`409`** - only A's save failed, and no write happened. The response's `current` becomes the new
  baseline; A's card enters the conflict state with keep-mine / take-theirs; B's draft is untouched
  and B is not in conflict, because B was never sent.

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
- **Use global default** is disabled unless there is an override to remove, and sends `null` for
  that key. The pattern to copy is `WorktreeSettingsPanel.tsx` - its `StateChip` at `:232` renders
  `overridden ? "override" : "inherited"`, and its reset button at `:274-276` is a `btn btn-ghost`
  wrapped in a `Tooltip`, `disabled={!overridden}`, posting `null` for the key.
- Adding a repository uses `RepoCombobox` and resolves through `resolveRepo` before staging, the
  way `TrustPanel` and `CommandLibrary.tsx:560-585` already do. A subdirectory is a legitimate key.

The **reach** block is a required part of this phase, not decoration. It states per harness and
runtime which sessions get the text and by which mechanism, **and when a change to it takes effect**,
and it is the honest answer to the questions a standing instruction otherwise leaves an operator
guessing at.

It has **eight** rows, and the last three are as required as the first five. Both `✗` rows are shipped,
tested strings, because each renders an approved decision that was a deliberate product boundary
rather than a gap:

| Row | Renders decision |
|---|---|
| `✗ sessions started outside Mission Control` - not reachable | `reach` - Mission-Control-launched sessions only |
| `✗ Foreman / Inspector / Persona review prompts` - not in scope | `standards-bundle` - sessions only, for now |
| `⏱ sessions already running` - keep what they launched with | cross-phase invariant 9 - launch resolves, assignment repeats |

The third is about **when**, not **where**, which is why it is a distinct row rather than a footnote
on the first. An operator who edits a rule while five sessions are open needs to know before they go
looking that none of the five changed. Phase 1's reasoning holds it up: a live process's system
prompt cannot be rewritten, so the alternative was never "edits reach running sessions" - it was
edits reaching them on two of the five pairs and not the other three.

The second is the easier of the two to drop, and the more damaging to omit. Without it the panel
reads as though a rule written here also governs the Inspector's review of the resulting pull
request. An operator who writes "never run E2E tests locally" would then be entitled to expect the
Inspector not to flag their absence, and would be wrong - which is precisely the "trusted and wrong"
failure the reach block exists to prevent, aimed at Mission Control's own workflows instead of at a
harness.

Every interactive element wrapped in `<Tooltip>`; no `title=`. At least one `data-anchor`.

### 5. `api.ts` and `settings-search.ts`

Client functions for the four routes - the three configuration routes plus the session snapshot
read. A `SETTINGS_CONTROLS` entry per anchored control - required,
per the gate above.

### 6. The two markers

The two markers answer two different questions and therefore read **two different sources**. This
is the point most easily got wrong, so it is stated before either one:

| Marker | Question | Source |
|---|---|---|
| Dispatch note | *what will this session get?* | `GET /api/instructions/resolved` - live config, nothing has happened yet |
| Session chip | *what did this session get?* | `GET /api/sessions/:id/standing-instructions` - the snapshot Phase 1 wrote at launch |

- **Dispatch form** (`DispatchModal.tsx`): a read-only note naming the size **and** the mechanism,
  reading `GET /api/instructions/resolved` for the selected repository, agent and runtime. It must
  update when the repository selection changes.
- **Session header**: a chip that reveals the text this session actually received, read from its
  launch snapshot. **It must never call the resolved route.** A session outlives the setting that
  launched it - the operator edits the rule, or removes the repository's override entirely, and a
  chip resolving live config would then quote that session new text it never saw, or drop the chip
  from a session that did receive one. That is worse than having no chip: the chip exists so nobody
  debugs an instruction they cannot see, and a chip that lies sends them looking for the cause of a
  behaviour in a rule that was not in effect. Fetch the snapshot for the session in view and render
  nothing on `404`.

Both name the mechanism, not just the fact of delivery: on Claude the text rides the system prompt
and never enters the transcript, so a marker that only said "sent" would send an operator searching
a conversation for something that was never in it. The session chip names the mechanism **it
recorded at launch**, not the one the harness would use today.

### 7. Documentation

`docs/skills-and-settings.md` gains the category. While in that file, correct its stale section at
lines 237-250, which still calls Conductor "the one category that is conditional" - contradicting
both the current registry and `docs/agent-guides/change-contracts.md:747-755`.

## Tests

### Node

- A panel render test, `test/standing-instructions-panel.test.ts`, modelled on
  `test/conductor-panel.test.ts` (487 lines) or `test/task-sources-panel.test.ts` (240):
  `inherited` vs `override` chips, the counter, the disabled **Use global default**, and the empty
  state. Assert the reach block **row by row**: five `✓` pairs with their mechanisms, and **both**
  `✗` exclusions - externally started sessions, and Mission Control's own review prompts - and the
  `⏱` row saying a running session keeps what it launched with. A generic "the reach block renders"
  assertion passes while a row is missing, which is the case that matters.
- Additions to `test/settings-sidebar-render.test.ts` (~30 lines): the conventional pair that every
  recent category added - "Standing instructions is a category of its own: its panel shows, the
  others don't", and "with no answer from the daemon, the panel says so rather than showing an
  empty list."
- Hook reconcile tests: a poll landing mid-edit must not clobber the draft, and must not be
  persisted by the next commit. This is the bug `useTaskSources.ts:49-60` records; pin it here.
- **Saving one repository writes only that repository.** With A and B both dirty, save A and assert
  three things: B's *stored* value is unchanged, B's draft survives in the panel, and **Revert** on
  B afterwards restores the stored value rather than the draft. The third assertion is the one that
  fails if the panel PUTs the whole draft map, because that path leaves the draft and the baseline
  agreeing with each other and wrong.

### e2e - required

New spec in `e2e/specs/`, read [`e2e/README.md`](../../../e2e/README.md) first. Two models to
combine:

- **`e2e/specs/settings-worktrees.spec.ts`** (343 lines) for the settings half: navigate to
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
4. **The chip does not follow the setting.** After the dispatch in (2), change the repository's
   rule in Settings and assert the running session's chip still shows the original text. This is
   the browser proof that the chip reads the snapshot; a chip wired to the resolved route passes
   every other case in this spec and fails only this one.
5. **Neither does the session.** Assign a second task to that same session and assert the recorded
   argv and prompt carry the launch text, not the edited one - the browser proof of invariant 9.
   `harness-defaults-propagate.spec.ts`'s record-dir reader already gives the assertion shape.

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
- Saving one repository leaves every other repository's stored value untouched.
- A session's chip shows what that session received, and does not change when the setting does.
- The reach block states all five harness · runtime pairs, the two deliberate exclusions, and the
  line saying an edit reaches the next session rather than a running one.
- Docs updated, including the stale Conductor sentence.
- Typecheck, lint, tests, build and e2e green; one reviewable pull request merged.

## Downstream handoff

Nothing depends on this phase - it is the last. Two things a later change should know:

- The panel is the only editor. A per-session or one-shot override, if it is ever wanted, extends
  the same store rather than adding a second one.
- An injection into adopted sessions was deliberately deferred, not forgotten. It would reuse this
  store and `recordInjection`, and it would turn the reach block's *externally started sessions* `✗`
  row into a control. The *review prompts* row is a different decision (`standards-bundle`) and would
  not move with it.

## Cross-phase audit record

- **Audited against Phase 1 after writing.** No contract conflicts: this phase consumes the routes,
  the ETag semantics and the empty-vs-absent rule exactly as Phase 1 fixes them, and adds nothing to
  the wire.
- The N+1 documents against a single document ETag was identified here rather than in Phase 1, and
  **deliberately not pushed back into it**. A per-repository ETag would be a larger, riskier store,
  and it is not needed: Phase 1's `repositories` is already a patch, so a save carries one
  repository's key and the shared ETag only orders writes. Recorded as a resolved design question,
  not a Phase 1 change.
- The `data-anchor` and `SETTINGS_CONTROLS` gates are wholly inside this phase's files, so no
  earlier phase needed editing.
- Confirmed both phases are single-repository, so each produces exactly one pull request.
