---
category: repo-convention
date: 2026-08-14
source-session: sdk:1a98388a-1faa-429d-b0e1-678f55573563
times-confirmed: 2
---

# Workflow evidence and pull-request evidence have different readers

Workflow Personas read the immutable evidence captured for their submission, including the
bounded session transcript. Output placed in the current session turn can therefore reach a
Persona when the next submission is captured, subject to transcript budgets and truncation.
That does not put the output on the pull request for a human reviewer, and later submissions
do not retroactively change evidence already frozen for an earlier round.

`AGENTS.md` forbids committing proof-of-work output. Use the workflow's registered text and
image evidence for Persona review, and attach the corresponding proof to the pull request when
a human PR reviewer needs it. The pull request must exist before that human-facing attachment
can be supplied, but it is not the transport for native workflow evidence.

**Imagery is not an exception to the no-commit rule.** Register a gitignored PNG, JPEG,
static GIF, or WebP with `submit_workflow_evidence` when a workflow Persona needs the actual
pixels. Native provider input carries those retained bytes alongside a manifest with the
caption, repository scope, size, MIME type, and digest. Commit an image only when a reader of
the document wants it for its own sake.

**A binary can be attached to a pull request from here.** The belief that it cannot, because
"GitHub has no REST API for uploading an image to a comment", is true of the REST API and
false of the session: the browser this harness drives is signed in, so opening the pull request,
focusing the comment box and uploading through GitHub's own attachment input works, and
produces the `user-attachments` URLs that render inline for a reviewer. Verify by fetching
each asset with the CLI's token and comparing the byte count to the local file. An anonymous
fetch of a private repository's attachment returns 404 and proves nothing.
