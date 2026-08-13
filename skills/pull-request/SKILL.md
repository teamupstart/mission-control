---
name: pull-request
description: Use whenever you are preparing, opening, or reporting a pull request for a Mission Control session - once per repository you changed, when the work spans several. Write a specific, reviewable PR description split into a concise, bullet-forward For Humans section carrying the why, the tradeoffs, the known gaps, the evidence, and the recommended follow-ups, and a For Agents section linking the plan and technical documentation before supplying only technical details those documents do not cover.
metadata:
  mission:
    category: shipping
    enforcement: triggered
---

# Pull Request

Use this skill whenever this Mission Control session prepares, opens, or reports a pull
request, including when you write the description before running `gh pr create`. Treat
the pull request as the handoff to a reviewer, not as a log of commands you ran.

## One pull request per repository you changed

Nearly every session works in one repository and opens one pull request, and everything below
describes that. A session dispatched across several repositories is the exception, and the
rule for it is: **one pull request per repository whose worktree you actually changed, and
none for a repository you left alone.** They are not one change split up - each is reviewed on
its own, gated on its own, and merged on its own, so each needs a description that stands by
itself.

Apply this whole skill once per repository. Write each description for a reviewer who is
looking at that repository alone: name the cross-repository work in `### Why`, and say plainly
which sibling pull requests it lands with and what breaks if one merges without the others.
Everything else - `### What changed`, the tradeoffs, the evidence - is about the slice of the
change in front of them, not the whole set.

## Every description has exactly two top-level sections

The description is split by audience, and each section is a literal Markdown heading so a
reader can see the split without hunting for it:

```markdown
## For Humans

### Why

### What changed

### Tradeoffs

### Known gaps

### Evidence

### Follow-up work

## For Agents
```

`## For Humans` comes first and `## For Agents` second. Do not merge them, do not reorder
them, and do not drop a subsection because it felt thin - when there is nothing to report
under one, say so plainly ("No known gaps." or "No follow-up work identified.") instead of
deleting the heading. A reviewer reads the absence of a heading as an omission.

## For Humans

Written for the person deciding whether to approve the change. **Concision is a requirement.**
Be direct and use bullets wherever possible so the reviewer can scan what changed, why,
tradeoffs, gaps, evidence, and follow-ups. Remove filler, throat-clearing, generic assurances,
and implementation detail. Do not narrate the work or restate the diff. Each item below is
its own `###` subsection, in this order.

1. **Why** - state the problem or missing behavior and the intended outcome. Include only the
   context needed to understand the point of the pull request.
2. **What changed** - a concise description of the total feature, in the user's terms. Name
   the user-visible or engineering behavior and the surface it lands on. A list of changed
   files is not a description, and neither is a restatement of the diff. When the work spans
   several repositories, this is what changed *here*; the whole feature belongs in **Why**.
3. **Tradeoffs** - what the change deliberately gives up, and the alternatives you rejected.
   State each one plainly in a bullet rather than defending it.
4. **Known gaps** - what the change does not cover. Unhandled cases, surfaces left untouched,
   limitations you accepted, and anything left unverified. Use bullets when there is more
   than one.
5. **Evidence** - concrete proof the feature works. Name the checks you actually ran and what
   they reported, and for a UI change attach screenshots of the working feature to the pull
   request so a reviewer can see the result without reconstructing it locally. Evidence files
   are never committed to the repository: produce them in a gitignored location and upload them
   to the pull request. When a check or a screenshot is unavailable, say so and explain why
   rather than implying it exists. Prefer one short bullet per check or artifact.
6. **Follow-up work** - what you recommend next and why it is out of scope here. Make each
   item a concise, actionable bullet.

## For Agents

Written for the next agent that has to read, extend, or debug this code. Keep this section
concise too, and use direct Markdown links plus bullets.

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
`## For Humans` alone and understand what changed, why, what it costs, and how it was
verified; an agent must be able to follow `## For Agents` and its direct links to understand
how it works. Remove fluff and details duplicated by linked documentation before opening a
new pull request with that description. Before reporting an existing one, verify its current
description carries both sections to the same standard and update it if it does not.

Do this for each repository in turn, and report every pull request you opened with the
repository it is in. A repository you changed and did not open one for is unshipped work, and
a report naming one url for a change that spans three is a report of a third of it.
