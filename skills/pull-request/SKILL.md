---
name: pull-request
description: Use whenever you are preparing, opening, or reporting a pull request for a Mission Control session. Write a specific, reviewable PR description split into a For Humans section carrying the why, the tradeoffs, the known gaps, the evidence, and the recommended follow-ups, and a For Agents section carrying the design decisions and implementation detail.
metadata:
  mission:
    category: shipping
    enforcement: triggered
---

# Pull Request

Use this skill whenever this Mission Control session prepares, opens, or reports a pull
request, including when you write the description before running `gh pr create`. Treat
the pull request as the handoff to a reviewer, not as a log of commands you ran.

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

Written for the person deciding whether to approve the change. Keep it readable on its own
and keep implementation detail out of it; that is what `## For Agents` carries. Each item
below is its own `###` subsection, in this order.

1. **Why** - the context and rationale for the feature. What prompted it, what was wrong or
   missing before, and what outcome the change is reaching for. Someone who reads only this
   subsection should understand the point of the pull request.
2. **What changed** - a concise description of the total feature, in the user's terms. Name
   the user-visible or engineering behavior and the surface it lands on. A list of changed
   files is not a description, and neither is a restatement of the diff.
3. **Tradeoffs** - what the change deliberately gives up, and the alternatives you rejected.
   State them plainly rather than defending them.
4. **Known gaps** - what the change does not cover. Unhandled cases, surfaces left untouched,
   limitations you accepted, and anything left unverified.
5. **Evidence** - concrete proof the feature works. Name the checks you actually ran and what
   they reported, and for a UI change embed or link screenshots of the working feature so a
   reviewer can see the result without reconstructing it locally. When a check or a screenshot
   is unavailable, say so and explain why rather than implying it exists.
6. **Follow-up work** - what you recommend next and why it is out of scope here. Make each
   item specific enough to act on.

## For Agents

Written for the next agent that has to read, extend, or debug this code. This is where the
detailed design and implementation reasoning goes - the material a human approver does not
need in order to approve, and the next agent cannot work without.

- The design decisions, including the ones that are not obvious from the diff, and why each
  was chosen over what it replaced.
- The implementation detail a reader would otherwise reverse-engineer: the contracts,
  invariants, migrations, registries, and event or state flow the change depends on, and the
  modules that own them.
- The tests added or changed, and what each would catch.
- The failure modes and edge cases handled on purpose, so a later change does not quietly
  undo them.

## Before opening or reporting

Review the final title and description for specificity. A reviewer must be able to read
`## For Humans` alone and understand what changed, why, what it costs, and how it was
verified; an agent must be able to read `## For Agents` and understand how it works. Open a
new pull request with that description. Before reporting an existing one, verify its current
description carries both sections to the same standard and update it if it does not.
