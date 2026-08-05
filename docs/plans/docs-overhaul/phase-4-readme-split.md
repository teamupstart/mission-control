# Phase 4: split the README into `docs/` and archive historical material

## Outcome

The ~6,000-line README reference lives as organized, discoverable pages under `docs/`
with an index, the README is a short interim front page, and the `docs/` top level holds
only durable documentation (mockups and backups archived).

## Entry criteria and dependencies

- Direct prerequisite: phase 3. Phases 1-3 changed the paths and commands this content
  describes; extracting pages before that would bake stale paths into every new file.

## Scope

- Move README content (do not rewrite it - accuracy is already there, the container is
  the problem) into one page per feature area under `docs/`, suggested grouping from the
  current heading structure: sessions and terminals; conversations and status;
  dispatch, tasks and the backlog; task sources and recurring missions; ensembles;
  workflows, personas and session actions; Foreman; Inspector and shipping; the Library,
  the Line and the Ship log; attention, alerts and away mode; UI (layout, palette,
  keyboard shortcuts, formatting, tooltips); worktrees and checks; work queues and
  autopilot; configuration reference (env vars, commands); demo mode; security. Merge or
  split groups where the material argues for it - the grouping above is a route, not a
  specification.
- Create `docs/README.md`, the index, with four reserved sections in this order:
  **Features** (filled by this phase), **Architecture** (phase 5 fills),
  **Contributing and setup** (phase 6 fills), **Support** (phase 7 fills). Later phases
  add entries only under their own section; this file's section order is a cross-phase
  contract.
- Replace `README.md` with a short interim front page: one-paragraph description, quick
  start, link to `docs/README.md`, note that the repository is internal. Phase 8 replaces
  it wholesale; phases 5-7 do not edit it.
- `git mv docs/mockups docs/archive/mockups` and `git mv docs/backups docs/archive/backups`
  (adopted decision). `docs/plans/` stays. Add a one-line `docs/archive/README.md`.
- Update every live referrer: `AGENTS.md` ("Read README.md for product behavior" and the
  `docs/backups/AGENTS.old` link), `e2e/README.md` links into README anchors if any,
  `docs/agent-guides/*` links, and any `src/` comment linking a README anchor. Sweep with
  a repo-wide grep for `README.md#`, `docs/mockups`, `docs/backups` before finishing.

Non-goals: new prose (phases 5-8), screenshots (phase 8), deleting any content - every
README section lands somewhere under `docs/` or is consciously dropped with the reasoning
recorded in the PR description.

## Repository findings

- The README's heading structure (about 140 headings) already implies the page grouping;
  the deep sections are self-contained enough to move mostly intact.
- `AGENTS.md` tells agents to read `README.md` for product behavior and links
  `docs/backups/AGENTS.old`; both references must follow the move.
- Several tests quote README-adjacent behavior but none read `README.md` itself; the risk
  in this phase is broken links, not broken code.
- `docs/` currently has no index; discoverability is the point of this phase.

## Implementation steps

1. Inventory the README headings; map each to a target page; record the map in the PR
   description.
2. Create the feature pages and `docs/README.md`; move content section by section,
   updating intra-page links and relative paths (image-free today, so links are the only
   fixup).
3. Write the interim README.
4. Archive mockups and backups; update referrers.
5. Run the link sweep; verify every intra-repo link in `docs/**/*.md`, `README.md`,
   `AGENTS.md`, and `e2e/README.md` resolves (a small script or manual grep pass; if a
   script is written, put it in `scripts/` and mention it in the PR).

## Compatibility

No code, schema, or API changes. Pure documentation reorganization plus two directory
moves of non-code assets.

## Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test` (guards against accidental source
  edits; the personas/session-actions drift tests also confirm nothing regenerated).
- The link sweep above, recorded in the PR.
- No UI surface changes; no e2e spec required.

## Merge and exit criteria

- CI green.
- `README.md` is the interim front page; every removed section is reachable from
  `docs/README.md`.
- `docs/` top level contains only durable docs, `plans/`, `agent-guides/`, and
  `archive/`.

## Downstream handoff

Later phases rely on: the index's reserved sections (add entries only under your own
section, do not reorder), the feature-page filenames (phases 5-8 link to them), and the
interim README's replaceability (phase 8 rewrites it without archaeology).

## Cross-phase audit record

- 2026-08-04: initial version. Interim-README decision recorded in `phased-plan.md`
  findings: the repository must never be without a front page, and content must never
  exist in two places.
