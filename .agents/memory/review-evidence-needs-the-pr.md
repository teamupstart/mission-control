---
category: repo-convention
date: 2026-08-14
source-session: sdk:1a98388a-1faa-429d-b0e1-678f55573563
times-confirmed: 1
---

# A review round cannot see output pasted into a reply

Observed, not inferred: this session pasted the same focused Playwright command and its
complete unedited output into three consecutive repair rounds, and a fourth round asked for
it again as still missing. The reviewers behave as though they read the diff plus the
current turn - so anything that exists only as prose in a reply is gone by the next round,
and re-pasting it never converges.

`AGENTS.md` forbids committing that output, and is right to. The consequence is the useful
part: an evidence request can only be satisfied where the rule already points - the pull
request - which means **the pull request has to exist before the review can be answered**.
Open it early rather than at the end.

Imagery is the one exception, and it is a real one: a screenshot committed to `docs/images/`
is documentation rather than evidence, so it lands in the diff a reviewer does read. That is
what finally closed the visual-evidence finding here.
