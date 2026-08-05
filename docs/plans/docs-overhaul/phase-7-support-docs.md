# Phase 7: troubleshooting, glossary, and SECURITY.md

## Outcome

The three support documents the plan adopted: a troubleshooting page that turns the known
failure modes into symptom-to-fix entries, a glossary that defines the product vocabulary
a newcomer hits first, and a `SECURITY.md` stating the security posture and how to report
an issue.

## Entry criteria and dependencies

- Direct prerequisite: phase 4 (the docs index with the reserved Support section, and
  the feature pages the glossary links into).
- May run concurrently with phases 5 and 6 under the index-section contract.

## Scope

- `docs/troubleshooting.md`: symptom-first entries for at least - daemon port 7317
  already in use; hooks not firing / stale status (what "instrumented" means and how to
  re-install hooks); Playwright browser missing (`npx playwright install chromium`);
  stale worktree/check leases and how they are reclaimed; a session that shows exited vs
  removed; e2e suite run without a prior `npm run build`. Source each entry from the
  moved feature pages and `e2e/README.md` rather than inventing behavior; every claim
  must be traceable to a doc or to code.
- `docs/glossary.md`: one short paragraph each - harness, session (terminal vs SDK),
  dispatch, task, backlog, the Line, the Library, the Ship log, mission / recurring
  mission, ensemble, workflow, persona, session action, Foreman, Inspector, shipping
  (YOLO mode), away mode, worktree (treehouse), demo mode. Each entry links to its
  feature page from phase 4.
- `SECURITY.md` at the root: the existing security posture (from the README's Security
  section, which phase 4 moved into a docs page - link it, do not fork it) plus internal
  reporting guidance (this is an internal repository; report via the team's channel
  rather than a public CVE process).
- Add the entries under the index's **Support** section.

Non-goals: editing `README.md` (phase 8); inventing failure modes not grounded in the
docs or code; duplicating the security page's content into `SECURITY.md`.

## Repository findings

- The README (pre-split) documents most failure behaviors in place - stuck-session
  alerts, lease reclamation, hook evidence freshness - so the troubleshooting page is
  mostly extraction and inversion (symptom first), not research.
- The vocabulary is the real onboarding wall: Foreman, Inspector, the Line, the Library,
  ensembles, and missions are all proper nouns with precise meanings that currently only
  emerge from a 6,000-line read.
- No SECURITY.md exists; the Security section at the bottom of the old README is the
  seed.

## Implementation steps

1. Write the glossary from the feature pages; verify each link.
2. Write the troubleshooting page; for each entry note where the fix is documented.
3. Write `SECURITY.md`; link the security docs page.
4. Add index entries.

## Compatibility

Documentation only.

## Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test` untouched-green.
- Link sweep over the three documents.
- No UI surface changes; no e2e spec required.

## Merge and exit criteria

- CI green; all three documents reachable from the index; every glossary term links to a
  real page.

## Downstream handoff

Phase 8's README may link `SECURITY.md` and the glossary. Support entries added later
belong in these files, not new parallel ones.

## Cross-phase audit record

- 2026-08-04: initial version. Depends on phase 4's page names for glossary links; if
  phase 4 grouped features differently than its suggested route, follow the pages as
  merged, not as planned.
