---
category: repo-convention
date: 2026-08-16
source-session: sdk:3978bcf7-e5a2-4981-a8b5-96eee9f450f9
times-confirmed: 1
---

# No-Mistakes evidence must be visible in both the workflow turn and the PR

Pull request attachments are durable human-review evidence, but the Test Evidence Auditor's
workflow snapshot does not import the PR conversation. This session attached and
byte-verified UI screenshots on its PR and summarized a completed `make test`, yet a later
repair packet still reported that its snapshot contained neither rendered image artifacts
nor the command's actual terminal footer.

Before yielding a No-Mistakes repair, render each evidence image through a tool into the
current turn and keep every required command running in that turn until its aggregate footer
and exit code appear in the transcript. Attach the same artifacts and concise result to the
pull request for the durable record. Evidence stays gitignored and is never committed.
