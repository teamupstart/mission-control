# Phase 3: remove `docs/evidence/` and enforce the attach-only evidence policy

## Outcome

The repository carries no committed PR evidence: `docs/evidence/` (23MB, 152 files) is
gone and cannot silently come back, every producer writes to a gitignored location, and
the policy - evidence attaches to the pull request, never committed, including evidence
produced for workflow personas - is stated where agents read it (`AGENTS.md`, the
pull-request skill, the pull-request session action).

## Entry criteria and dependencies

- Direct prerequisite: phase 2. This phase edits `actions/pull-request.md` at the path
  phase 2 creates, and shares `README.md`/`AGENTS.md` edits with phases 1-2.

## Scope

- Delete `docs/evidence/` entirely.
- Preserve `docs/plans/workflow-card-progress/evidence/` - plans-scoped, written by
  `scripts/workflow-board-tile-evidence.cjs` and
  `scripts/workflow-ladder-actions-evidence.cjs`, out of scope.
- Redirect every producer to gitignored `e2e/.artifacts/<topic>/`.
- Policy text in `AGENTS.md`, `skills/pull-request/SKILL.md`, `actions/pull-request.md`.

Non-goals: rewriting `e2e/README.md` beyond the evidence sections; historical plan files
that link into `docs/evidence/` (`docs/plans/shipped-surface/phase-3-shipped-drawer.md:78`
stays - historical documents keep their paths); the README restructure (phase 4 - but the
six live README links below must not dangle, so they are fixed here).

## Repository findings

- **Deletion does not stick by itself.** Sixteen e2e specs `mkdir` and screenshot into
  `docs/evidence/...` via per-spec constants, e.g.
  `e2e/specs/trust-workflows-grant.spec.ts:8`:
  `new URL("../../docs/evidence/trust-workflows-grant/", import.meta.url)`. The full
  list: `harness-defaults-propagate` (:26), `dispatch-and-converse` (:30),
  `line-drawers` (:24), `line-strip` (:46), `palette` (:23), `ship-log` (:39),
  `topbar-one-row` (:27), `settings-ledger-pagination` (:39),
  `driver-question-in-conversation` (:34), `attention-pills-agree` (:32),
  `queued-turn-delivery` (:13), `library` (:23), `trust-workflows-grant` (:8),
  `workflow-session-action-run` (:33), `workflow-session-action-evidence` (:9, :27),
  `workflow-pull-request-mismatch` (:45). Most also `console.log("CAPTURED
  docs/evidence/...")`.
- Three scripts write there too: `scripts/review-answer-evidence.cjs:9`,
  `scripts/conversation-timestamp-evidence.cjs:9`,
  `scripts/workflow-skipped-status-evidence.cjs:13`.
- `e2e/README.md` links into `docs/evidence/` about sixteen times and includes
  copy-paste `| tee docs/evidence/<dir>/transcript.txt` commands.
- Live `README.md` links into it at lines 807, 886, 896, 1269, 2391, 5014.
- `docs/evidence/inspector-prompt-bytes.md` is a recorded measurement baseline that
  `test/standards.test.ts:106` and `test/standards-prompt-bytes.test.ts:32` reason
  about; `src/server/standards.ts:137` and `src/server/util/repo-doc.ts:60` point at it.
  **Operator non-negotiable:** relocate it, do not drop it.
- `.gitignore` already models the pattern: `test-results/`, `playwright-report/`,
  `e2e/.probe/`.
- The skill (`skills/pull-request/SKILL.md:24`) and the action source
  (`actions/pull-request.md:23`) both say "attach or link screenshots" - the "or link"
  is what allowed committed evidence to accumulate.

## Implementation steps

1. Add a shared helper in `e2e/fixtures/` (e.g. `artifactsDir(topic)`) resolving to
   `e2e/.artifacts/<topic>/`, and switch all sixteen specs and their `CAPTURED` log
   lines to it. One definition, sixteen users.
2. Redirect the three `scripts/*-evidence.cjs` writers to the same location.
3. Add `e2e/.artifacts/` to `.gitignore`.
4. `git rm -r docs/evidence/`.
5. Move `docs/evidence/inspector-prompt-bytes.md` →
   `docs/agent-guides/inspector-prompt-bytes.md` (before the deletion commit lands, so
   history stays connected via the rename); update the four pointers
   (`src/server/standards.ts:137`, `src/server/util/repo-doc.ts:60`,
   `test/standards.test.ts:106`, `test/standards-prompt-bytes.test.ts:32`).
6. `e2e/README.md`: update the evidence sections - artifacts land in gitignored
   `e2e/.artifacts/`, get attached to the PR, and are never committed; fix the links and
   the `tee` commands.
7. `README.md`: rework the six sentences that link into `docs/evidence/` so they stand
   without the links (the content they cite is attached to the original PRs).
8. `skills/pull-request/SKILL.md`: "attach or link screenshots" becomes attach-only, and
   add the explicit rule: evidence files are never committed to the repository; produce
   them in a gitignored location and upload them to the pull request.
9. `actions/pull-request.md`: same rule, same wording register; run
   `npm run session-actions` and commit the regenerated module.
10. `AGENTS.md` (Boundaries): add - never commit evidence artifacts; proof-of-work
    screenshots and transcripts attach to the pull request; evidence produced for or
    submitted to workflow personas is also never committed; committed documentation
    imagery (`docs/images/`, introduced by phase 8) is documentation, not evidence.

## Compatibility

No runtime code paths read `docs/evidence/`; no schema or API changes. The regenerated
session-actions module changes the builtin action's guidance text only - its id, contract
table entry, and required skill are untouched.

## Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test`.
- `npm run build`, `npm run smoke` (generated module and skill text ship).
- `npm run build && npm run test:e2e`: full suite - sixteen specs changed where they
  write; confirm `docs/evidence/` is not recreated and `e2e/.artifacts/` is populated
  and untracked (`git status --porcelain` clean of it).
- `git ls-files docs/evidence` returns nothing after the change.

## Merge and exit criteria

- All checks green; CI green.
- No tracked file under `docs/evidence/`; `docs/plans/workflow-card-progress/evidence/`
  untouched.
- Skill, action, and `AGENTS.md` all state the attach-only, never-commit policy.

## Downstream handoff

Later phases rely on: `e2e/.artifacts/` as the only evidence destination, and the policy
text locations. Phase 4 may re-home `docs/agent-guides/inspector-prompt-bytes.md` only if
it updates the four pointers again; otherwise leave it.

## Cross-phase audit record

- 2026-08-04: initial version. `actions/pull-request.md` edit deliberately placed here
  (not phase 2) so the whole evidence policy is one reviewable change; depends on phase
  2's path.
