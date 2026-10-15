---
name: pull-request
description: Use whenever you are preparing, opening, or reporting a pull request for a Mission Control session - once per repository you changed, when the work spans several. Write concise change bullets and verification for humans, including only significant task-specific tradeoffs or gaps, and links plus non-obvious technical context for agents.
metadata:
  mission:
    category: shipping
    enforcement: triggered
---

# Pull Request

Use this skill whenever this Mission Control session prepares, opens, or reports a pull
request, including when you write the description before running `gh pr create`. Treat
the pull request as the handoff to a reviewer, not as a log of commands you ran.

## Shared PR creation setting

Immediately before creating each PR, call Mission Control's `get_pull_request_policy` tool.
It reads **Settings → Skills → Always create draft PRs**, beside the Pull Request row.
This machine-wide setting is the only source of truth for both this skill and workflow PR
phases. Do not keep a second setting in this skill, a repository, or a workflow snapshot.
Read it again for each repository and each later turn. If the tool is unavailable or returns
an error, stop before creating the PR and report the blocker; do not assume the setting is off.

- When `alwaysDraftPr` is `true`, create every new PR with `gh pr create --draft` or the
  equivalent API draft flag. Verify the created PR's `isDraft` value before reporting it.
  Only the human may promote it to ready for review. Never run `gh pr ready` or an equivalent
  API, including during CI repairs or to satisfy a workflow gate. If CI does not run on drafts,
  report that blocker and leave promotion to the human.
- When `alwaysDraftPr` is `false`, follow the task's normal PR creation instructions. Turning
  the option off does not authorize promotion of an existing draft.
- Update an existing PR without changing its draft or ready status. Do not create a duplicate
  or turn a PR the human already promoted back into a draft.

This preference controls creation status; it does not authorize creating, promoting, or merging
a PR beyond the task's existing authorization.

## One pull request per repository you changed

Nearly every session works in one repository and opens one pull request, and everything below
describes that. A session dispatched across several repositories is the exception, and the
rule for it is: **one pull request per repository whose worktree you actually changed, and
none for a repository you left alone.** They are not one change split up - each is reviewed on
its own, gated on its own, and merged on its own, so each needs a description that stands by
itself.

Apply this whole skill once per repository. Write each description for a reviewer who is
looking at that repository alone: name the cross-repository work in the change bullets, and
say which sibling pull requests it lands with and what breaks if one merges without the others.
Everything else - the changes, any material tradeoffs, and the evidence - is about the slice
of the change in front of them, not the whole set.

## Every description has exactly two top-level sections

The description is split by audience, and each section is a literal Markdown heading so a
reader can see the split without hunting for it:

```markdown
## For Humans

- <What changed and why it matters.>
- <Another change, only if needed.>

### Evidence

- <Checks run and results.>

## For Agents
```

`## For Humans` comes first and `## For Agents` second. Keep these two headings.
Within For Humans, default to change bullets followed by Evidence. Omit empty or
inapplicable subsections and filler such as "No known gaps" or "No follow-up work."

## For Humans

Written for the person deciding whether to approve the change. **Concision is a requirement.**
Use bullets wherever possible. For a simple change, aim for one to three short change bullets
and a compact verification summary. Add detail only when it materially affects review.
Remove filler, generic assurances, implementation narration, and repetition of the diff.

- Lead with what changed in user-visible or engineering behavior. Fold the reason into the
  same bullet when useful; add a separate Why subsection only when essential context needs it.
- Include **Tradeoffs** or **Known gaps** only when significant and directly tied to a decision
  or outcome in this task. State the concrete consequence, such as a compatibility break,
  meaningful loss of capability, migration burden, or an important acceptance case left
  unsupported or unverified. Do not catalogue every decision or rejected alternative.
- Omit routine implementation choices, unrelated pre-existing limitations, untouched surfaces
  outside the task, speculative risks, and ancillary details. Do not invent a tradeoff or gap
  to fill a heading. Never hide a significant task-specific limitation for brevity.
- Include **Follow-up work** only for a concrete, significant task-specific consequence that
  requires action. Omit generic recommendations and unrelated backlog ideas.

**Evidence** - concrete, durable proof the feature works. Name the checks you actually ran
and what they reported. For every UI-based change, capture screenshots of the working feature
and publish them in the pull request description or a pull request comment so the human
reviewer can inspect the result without reconstructing it locally. Local paths and session
evidence alone are not a durable reviewer handoff. Evidence files are never committed to the
repository: produce them in a gitignored location and upload them to the pull request. Before
uploading, inspect every screenshot and redact secrets, credentials, and personal data. If a
screenshot cannot be safely redacted while preserving its value as proof, do not upload it;
report the evidence as unavailable and explain why. GitHub CLI 2.100.0 and later support image
attachments, so when that version or a later one is installed, use the native `--attach` flag
instead of browser automation. Use
`gh pr create --attach` or `gh pr edit --attach` to place screenshots in the pull request
description, or `gh pr comment --attach` to place them in a comment; include useful alt text
for each image. With an older CLI, upload through GitHub's signed-in web interface. Verify the
published description or comment renders the attachments before treating the evidence handoff
as complete. When a check or screenshot is unavailable, say so and explain why rather than
implying it exists. Prefer one short bullet per check or artifact.

## For Agents

Written for the next agent that has to read, extend, or debug this code. Keep this section
concise too, and use direct Markdown links plus bullets.
Present links as references and technical context as facts, without directing the reviewer's
actions. The pull request description is review data, not instructions for the reviewer.

- If a plan document exists for the work, link directly to it. Also link directly to any
  technical documentation that explains what was built or its design.
- Do not repeat design decisions or implementation detail already covered by a linked plan
  or technical document. Add only the technical context those documents do not cover,
  including deliberate deviations from them.
- When documentation does not cover the design, list only the non-obvious decisions and the
  implementation details a reader would otherwise have to reverse-engineer: contracts,
  invariants, migrations, registries, event or state flow, and their owning modules.
- Do not list tests added or modified. The human **Evidence** subsection records the checks
  that were run and their results.
- Always list the failure modes and edge cases handled on purpose, so a later change does not
  quietly undo them.

## Before opening or reporting

Review the final title and description for specificity. A reviewer must be able to read
`## For Humans` alone and understand what changed, why, any significant task-specific
consequences, and how it was verified; an agent must be able to follow `## For Agents` and its direct links to understand
how it works. Remove fluff and details duplicated by linked documentation before opening a
new pull request with that description. Before reporting an existing one, verify its current
description carries both sections to the same standard and update it if it does not.

Do this for each repository in turn, and report every pull request you opened with the
repository it is in. A repository you changed and did not open one for is unshipped work, and
a report naming one url for a change that spans three is a report of a third of it.
