---
name: Pull Request
description: Use whenever you are preparing, opening, or reporting a pull request for a Mission Control session. Write a specific, reviewable PR description that explains the goal, design decisions and tradeoffs, and concrete proof the work works.
metadata:
  mission:
    category: shipping
    enforcement: triggered
---

# Pull Request

Use this skill whenever this Mission Control session opens a pull request, including
when you prepare the description before running `gh pr create`. Treat the pull request
as the handoff to a reviewer, not as a log of commands you ran.

## Write the description in this order

1. Start with the PR's goal. State the user-visible or engineering outcome first, and
   identify the problem it solves. Be specific about the affected behavior or surface.
2. Explain the design decisions. Name the important implementation choices and the
   tradeoffs they make, including deliberately rejected alternatives when that context
   will help a reviewer understand the change.
3. Include proof of work. List the checks you actually ran and their results. For a UI
   change, attach or link screenshots of the working feature so the reviewer can see
   the result without reconstructing it locally.

Use clear headings such as `## Goal`, `## Design decisions`, and `## Proof of work`.
Do not use vague summaries like "updates the feature" or "tests pass" when you can name
the behavior changed, the command or test suite run, and what it verified. If a check or
screenshot is unavailable, say so plainly and explain why rather than implying it exists.

## Before opening

Review the final PR title and description for specificity. Make sure a reviewer can
understand what changed, why this design was chosen, and how it was verified from the PR
alone. Then open the pull request with that description.
