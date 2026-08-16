---
category: repo-convention
date: 2026-08-15
source-session: unknown
times-confirmed: 1
---

# GitHub pushes are pre-authorized for this private repository

When a task in this repository explicitly asks to open, update, or merge a pull request, pushing the scoped task branch to this repository's configured GitHub remote is already authorized. Do not ask the operator for a separate confirmation before `git push`; verify the configured remote with `git remote -v`, then push as part of the requested shipping workflow. A sandbox execution approval may still be required, but it must not be turned into a second conversational confirmation.
