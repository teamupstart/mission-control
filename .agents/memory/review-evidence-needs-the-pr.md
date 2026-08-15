---
category: repo-convention
date: 2026-08-14
source-session: sdk:1a98388a-1faa-429d-b0e1-678f55573563
times-confirmed: 2
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

**Imagery is not an exception, and a later session paid two review rounds for believing it
was.** It committed two screenshots to `docs/images/`, referenced them from prose, and
argued they were documentation; the review answered that an artifact produced to show a
reviewer that a fix works is evidence whatever it is referenced from, and they came back
out. Commit an image only when a reader of the document wants it for its own sake.

**A binary can be attached to a pull request from here.** The belief that it cannot - "GitHub
has no REST API for uploading an image to a comment" - is true of the REST API and false of
the session: the browser this harness drives is signed in, so opening the pull request,
focusing the comment box and uploading through GitHub's own attachment input works, and
produces the `user-attachments` URLs that render inline for a reviewer. Verify by fetching
each asset with the CLI's token and comparing the byte count to the local file - an anonymous
fetch of a private repository's attachment returns 404 and proves nothing.
