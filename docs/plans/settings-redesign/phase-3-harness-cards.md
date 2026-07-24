# Phase 3: Harness cards

Source plan: `docs/plans/settings-redesign/plan.md` (requirement R12, decision D4).
Visual target: the Harnesses panel in `docs/plans/settings-redesign/prototype.html`
(and mockup F's rows-vs-cards argument).

## Outcome

The Harnesses panel renders one card per harness - model and effort together, the
harness's accent on the card, capability-driven badges, and a launch sentence composed
from the current values - replacing the two parallel per-setting lists where each
harness appeared twice.

## Entry criteria and dependencies

- Depends on: Phase 1 (page container, anchor convention).
- May run concurrently with Phases 2 and 4.

## Scope

In: `HarnessesPanel.tsx` rework, card CSS, anchors, tests, README touch-up.

Non-goals: any change to what the panel writes (`autoModeOnDispatch`,
`defaultModel[agent]`, `defaultEffort[agent]` via `useHarnesses().update` - identical
patches); any new capability; search entries (Phase 5).

## Repository findings this phase builds on

- `HarnessesPanel.tsx` derives `MODEL_ROWS` from `AGENT_TYPES`, reads labels from
  `AGENT_IDENTITY`, model options from `modelChoicesFor(agent, value)` (with the stored
  value passed as `extra` so an id from another build stays selectable), effort levels
  from `capabilitiesFor(agent).effort?.levels`, and the auto-mode reach from
  `autoModeAgents()` / `autoModeUnsupportedWhy(agent)` / the shared `AUTO_MODE_LABEL`
  derivation. All of that carries over verbatim - the cards re-arrange it.
- Accents: `AGENT_IDENTITY[agent].accent` must arrive as an inline `--agent-accent`
  style; `agent-accent.test.ts` fails if any agent id appears in `styles.css`. The
  SessionCard pattern is the worked example.
- The `.kb-row` grammar stays correct for the auto-mode master row; only the
  per-harness cross-product becomes cards.
- `config === null` is the pre-poll state: controls render shipped defaults disabled
  (unchanged rule).

## Implementation steps

1. **Card layout** in `HarnessesPanel.tsx`: keep the panel blurb and the auto-mode
   `.kb-row` (anchor `harnesses/auto-mode`); below it, a card grid mapping
   `AGENT_TYPES`. Each card: header (accent dot + `AGENT_IDENTITY` label + badge),
   model select and effort select side by side, and a composed sentence restating what
   a dispatch will do (reuse the existing per-row sentences: `--model` flag or "its own
   configured model"; effort kept or overridden). Card badges are capability-derived:
   agents in `autoModeAgents()` show the auto-mode state when it is on; excluded agents
   show `autoModeUnsupportedWhy(agent)` as the badge title - never a literal harness
   name in copy.
2. **Accent**: card root gets `style={{ "--agent-accent": AGENT_IDENTITY[agent].accent }}`;
   CSS reads `var(--agent-accent, var(--neutral))` for the left border and dot.
3. **Anchors**: `harnesses/auto-mode`, `harnesses/<agent>` per card.
4. **CSS**: card rules in the existing "Harnesses (dispatch-time defaults)" section
   (~5622); grep any dropped `harnesses-row` usages before removing rules.
5. **README**: the Harnesses paragraph gains the card description; no shortcut changes.

## Data / API / migration

None. Patch shapes to `PUT /api/harnesses/config` (via `useHarnesses().update`) are
byte-identical to today's.

## Tests and verification

- Rework the Harnesses portion of the settings render test (or a dedicated
  `harnesses-cards.test.ts`): one card per `AGENT_TYPES` entry (pinned by deriving the
  expectation from the array, not a count literal); the accent arrives inline and no
  agent id is added to `styles.css` (existing `agent-accent.test.ts` keeps watch);
  excluded-agent badge text comes from `autoModeUnsupportedWhy`; the stored-model
  `extra` behavior still renders an unknown id as selectable.
- `npm run typecheck && npm test && npm run build`; manual: change model/effort per
  harness against a live daemon and confirm the dispatch modal defaults follow.

## Merge and exit criteria

- Cards shipped; identical config writes; `agent-accent.test.ts` untouched and green;
  CI green.

## Downstream handoff (later phases rely on; do not change)

- Anchors `harnesses/auto-mode` and `harnesses/<agent>`.
- The card derives everything from the registries; a new `AgentType` must light up here
  with no edits to this panel (Phase 5 indexes the auto-mode toggle and the per-harness
  cards through the same anchors).

## Cross-phase audit record

- 2026-07-23: initial version. No file overlap with Phase 2 beyond
  `SETTINGS_CATEGORIES` (neither edits the other's entries) and none with Phase 4.
  Anchor names recorded for Phase 5.
