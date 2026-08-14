# Phase 3: Session recognition and attention

## Outcome

Conductor-driven agent sessions stop masquerading as ordinary sessions: a carded claude/codex
session working inside an enabled conductor worktree gets a pipeline badge, groups under its
run, and loses the composer (it is a `--print` process that reads no input) while keeping an
honest permission-posture line. The conversation window's Workflows tab renders the pipeline
ladder for such sessions. Pipeline halts surface in the attention inbox as first-class items
with class, blocker text, and runbook name, and the topbar "need you" count and the Line's
amber semantics follow.

## Entry criteria and dependencies

- Direct prerequisite: Phase 2 (the `#/runs/pipeline/:repo/:slug` deep link and its hash
  helper, which the ladder and inbox rows link to).
- Transitively phase 1 (the `Session.pipeline` contract, projection, fixtures).

## Scope

- **Correlation (server)**: in discovery's correlate pass, stamp `session.pipeline`
  (`{ provider, slug, step }`) on a carded session whose cwd (the lsof-derived cwd discovery
  already trusts) sits under an enabled conductor repo's `.worktrees/<slug>`. `step` comes from
  the projection's `lastStep`. Uncorrelated sessions are untouched; when the repo is disabled,
  no stamping occurs - fail-open to today's behavior. Stamp changes flow through the existing
  `SESSION_FIELD_COMPARATORS` entry from phase 1, so `session_upsert` fires only on change.
- **Session card (web)**: a pipeline chip (provider glyph, slug, current step) on correlated
  cards; grouping the card under its run where the board groups related sessions; the
  composer suppressed through the shared `canMessage`-style predicate rather than ad-hoc
  branching, with a short notice in its place ("driven by ai-conductor - act through its run in
  Runs", linking via the phase 2 hash helper). The permission posture the session actually has
  (for example `--dangerously-skip-permissions` under conductor's gate cage) renders truthfully.
- **Conversation window**: `src/web/components/SessionWorkflowsPane.tsx` renders the pipeline
  ladder when `session.pipeline` is set: the vertical ladder grammar it already uses for
  workflow runs, phase groups collapsible, current step haloed, gate verdict chips inline, and
  an "Open in Runs" deep link. For every other session the pane is unchanged.
- **Attention (server)**: a sixth `AttentionItem` kind `pipeline_halt` in
  `src/server/attention.ts`, derived from halted runs in the projection before
  `session_blocked` claims leftovers, carrying halt class (`needs-human`, `mechanical`,
  `protected-artifact`, `legacy`, `unclassified`), blocker text, and the matching runbook name.
- **Attention (web)**: a "Pipeline halts" section in
  `src/web/components/AttentionInbox.tsx` (`SECTION_TITLES` is an exhaustive `Record`; the
  compiler walks the surface). Rows show class, reason, runbook, and a link to the run detail.
  Action buttons (Unpark, Grant) are phase 4; this phase renders informational rows with the
  deep link only.

## Non-goals

- No control verbs or action buttons (phase 4). No ingest (phase 5). No dispatch kind
  (phase 6). No new eviction path and no change to session eviction: correlation stamps a field
  on live sessions; a session that exits leaves through `Registry.beginEviction` exactly as
  today.

## Repository findings

Verified at `dc2d99a`:

- Discovery cards sessions by tty presence and MC-daemon ancestry, with cwd read via lsof as
  the authoritative signal; there is deliberately no `--print` argv filter, which is why a
  conductor-driven `--print` claude cards at all (the hazard this phase fixes).
- Conductor spawns claude non-detached with stdio `['pipe','inherit']` to keep the pane tty,
  always passes `--session-id`, and uses `--print --output-format json` on its invoke path
  (verified at ai-conductor `8b51392d`), so the carded process genuinely reads no operator
  input.
- `AttentionItem` has five kinds today (`src/server/attention.ts`, around lines 36-91), and
  `session_blocked` is derived last as the catch-all; `pipeline_halt` must be derived before
  it. `SECTION_TITLES` in `AttentionInbox.tsx` (around line 33) is the exhaustive Record to
  extend.
- Composer visibility flows through a shared predicate (the project's `canMessage(session)`
  pattern); extend the predicate, do not branch on concrete agents in components.

## Implementation steps

1. Server: stamping in the correlate pass, driven by the projection's known worktree paths;
   unit tests for path matching (nested worktrees, symlinks resolved the way discovery already
   resolves cwd, disabled repo, unknown slug).
2. Shared predicate: correlated sessions are not messageable; unit-test the predicate.
3. Session card chip, grouping, composer replacement notice, posture line.
4. `SessionWorkflowsPane` ladder rendering with the deep link.
5. `pipeline_halt` derivation plus inbox section and rows.
6. E2E specs on the fixture tree and fake agents.

## Data and compatibility

- No schema changes. `session_upsert` traffic increases only by genuine stamp changes.
- Attention ordering: existing five kinds keep their relative order; `pipeline_halt` insertion
  must not reorder or re-title existing sections (the section-title Record makes this a
  compile-time surface).

## Tests and verification

- Unit: correlation path-matching, predicate, halt-to-attention derivation (each halt class),
  ladder pane render shape via `renderToStaticMarkup` for the correlated and uncorrelated
  cases.
- E2E: a carded fake-agent session launched inside the fixture `.worktrees/<slug>` shows the
  badge and no composer, and its Workflows tab shows the ladder with the current step; an
  uncorrelated session shows today's composer and pane; a halted fixture run produces the
  inbox row whose link lands on the run detail; disabling the repo in Settings removes badge
  and row without touching the session otherwise.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- Definition of done per AGENTS.md; `docs/attention-and-alerts.md` and README updated.
- With no enabled conductor repo, discovery, cards, composer, and inbox behave byte-for-byte
  as today (the phase 2 regression spec keeps running green as a backstop).
- One reviewable PR; its merge releases phase 4.

## Downstream handoff

- The `pipeline_halt` attention kind and its payload (class, reason, runbook, run key):
  phase 4 attaches verb buttons to these rows; phase 6's Foreman triage consumes the class
  field. Neither may repurpose existing kinds.
- The correlation rule (enabled repo + cwd under `.worktrees/<slug>`): phase 6's dispatch
  relies on it to card dispatched pipeline sessions correctly without special-casing.
- The non-messageable predicate extension.

## Cross-phase audit record

- 2026-08-14: initial version. Depends on phase 2 (not just 1) because the ladder and inbox
  rows deep-link to the pipeline run detail; shipping them before the route exists would land
  dead links. Action buttons deliberately deferred to phase 4 so this phase stays read-only
  over conductor state.
