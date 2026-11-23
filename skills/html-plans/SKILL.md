---
name: html-plans
description: Render and review Mission Control-managed plans as self-contained HTML retained with their Markdown revisions, with inline flow diagrams and selectable dashboard decisions. Use when html-plans is explicitly invoked or the active workflow requires Mission Control-managed planning. Do not apply to explicitly selected repository-native planning workflows unless they explicitly opt into Mission Control-managed plans.
metadata:
  mission:
    category: planning
    enforcement: triggered
---

# HTML plans

Render Mission Control-managed plans as reviewable pages and collect their decisions as
clickable options. Markdown remains authoritative; the page renders its exact revision.

## When this applies

Apply this skill when the user explicitly invokes `html-plans`, or the active workflow
explicitly requires Mission Control-managed planning, such as a Mission Control plan task
or the Mission Control `phased-plan` skill.

An explicitly selected repository-native planning workflow owns its artifact locations,
Git-tracked artifacts, and approval and publication contracts. Follow that workflow unless
the user or workflow explicitly opts into Mission Control-managed plans. Do not call Mission Control tools,
require an HTML companion, move its artifacts, or add dashboard approval or phased follow-up
steps on this skill's authority. Missing Mission Control tools do not block that workflow.

Installing or enabling this skill, running inside Mission Control, or merely writing or
sharing a plan does not select the managed planning workflow. Establish ownership before
calling any managed tool. All instructions below, including every "Always" requirement,
apply only to plans owned by this Mission Control workflow.

## Always: render the plan as HTML

1. Call `get_plan_context` for the issued repository slot before writing a new plan. Use
   `read_plan` to discover an existing managed plan and read its exact revision. Catalog reads
   return `plans` and `nextCursor`; pass that cursor with the same repository slot until it is null.
   For this Mission Control workflow only, if registration or the managed tools are unavailable,
   report the refusal and stop managed planning; do not fall back to writing plans into Git.
2. Author `plan.md` and a self-contained static `plan.html` rendering in memory. Markdown is
   authoritative. Inline CSS, SVG, and data images; no scripts or external requests. Keep
   headings, tables, and diagrams consistent, support light/dark via `prefers-color-scheme`
   and contain wide content.
3. Call `save_plan` with `repoSlot`, a new UUID `requestId`, a kebab-case `slug`,
   `expectedRevision: 0`, and `files: [{name, content}, ...]`. Each Markdown source needs its
   same-name HTML rendering, including the phased index and phase files. Use flat filenames.
   Follow the returned storage policy. Repository mode writes `docs/plans/<name>/plan.md` and other Markdown sources
   and includes `docs/plans/<name>/plan.html` only under its saved opt-in. Local mode retains the complete bundle beneath
   the returned repository-scoped store and returns no `requiredPaths`, even if `commitPlanHtml`
   is true. The saved checkbox value remains available for future repository plans.
4. For revisions, pass the returned `planId` and `expectedRevision`, all bundle files, and a new
   request UUID. Retry the identical request UUID after an interrupted save. Conflicts require
   reconciling operator edits, never forcing an overwrite. A plan keeps its creation policy.
5. Open and link the returned `preview` URL for every review. It identifies the exact revision
   and its Markdown source. Use `read_plan` for retained text. Excluded HTML remains beneath
   the configured Mission state home, normally `~/.mission-control/plans/`, even after checkout
   cleanup. Do not copy excluded HTML into a normal checkout path or stage it manually.
6. For final local approval, call `request_plan_decisions` with `managedPlan: {repoSlot,
   planId, revision}` for the complete final bundle. The daemon adds its explicit final-approval
   decision and exact preview. Dismissal and choices from an earlier revision are not approval,
   and neither is a filed receipt: wait for the answer message before reading the revision back.
   If phasing or repairs change any file, save the complete new revision and obtain approval again.
   Save is neither approval nor publication. Commit and verify only returned `requiredPaths`
   when the task's completion handoff permits it. Cite repository Markdown in downstream tasks;
   repository publication still requires the planning PR's merge. Legacy unmanaged tracked
   plans keep their existing layout; edit them explicitly and do not migrate or untrack HTML.
7. Local plan-only tasks use Local Plan Validation, another review-only workflow, or explicit
   None. PR actions and Inspector completion gates are incompatible. Call
   `get_plan_publication_context`: with a workflow, register evidence and yield for the selected
   automatic/manual validation handoff; without one, call `publish_plan` after approval and any
   requested scheduling. Read the exact revision's `readiness` through `read_plan`. A saved draft
   or approval alone never releases tasks. Mixed code-and-plan work keeps its normal merge edge.
8. Before workflow handoff, register a gitignored UTF-8 evidence bundle with
   `submit_workflow_evidence`: the current root Markdown, phase context, decisions, and exact
   revision identity. Include every Markdown filename and its exact full saved content, without
   truncation. A local preview URL alone is not evidence that a Persona can inspect. Tool-less
   Personas receive the frozen text; incomplete text refuses local workflow publication.

## Always: offer a phased implementation follow-up

Offer the phased implementation follow-up once per root plan, on its first review in the Mission
Control dashboard. Append this as the **last** entry in the `decisions` passed to
`request_plan_decisions`, after any choices about the plan itself:

```json
{
  "id": "implementation-follow-up",
  "question": "What should happen after this plan is finalized?",
  "options": [
    {
      "id": "phased-plan",
      "label": "Create phased implementation plan",
      "detail": "Investigate the repository, write merge-aware phase plans, and schedule dependency-linked tasks.",
      "recommended": true
    },
    {
      "id": "stop",
      "label": "Stop after this plan",
      "detail": "Keep the approved plan without creating implementation phases or tasks."
    }
  ]
}
```

Call `request_plan_decisions` even when this is the only decision. It is the selectable action at the
bottom of the rendered dashboard review; do not replace it with a prose offer after sharing the plan.
Record the submitted choice with the plan's adopted decisions. Later repair and re-approval reviews retain the submitted choice without repeating the offer.

When the returned response says **Create phased implementation plan** (the `phased-plan` option):

1. Apply every submitted plan choice to `plan.md`, removing resolved alternatives and recording the
   adopted decisions.
2. Save the complete new revision and reopen its returned HTML preview, so the phased plan reads the approved source rather than a
   pre-decision draft.
3. Invoke the `phased-plan` skill with the absolute `plan.md` path and the complete submitted decision
   response. Let that skill investigate, write phases beside the source, and create the dependent
   implementation tasks.

When the skill is already producing `phase-*.md` artifacts, do not add another follow-up prompt to
each derived phase. The root plan's submitted choice already authorized that work, and recursively
phasing a phase has no stopping point.

## When the plan has other decisions: ask with selectable options

If the plan has open choices - which approach, which scope, which of several trade-offs -
do not bury the question in prose and hope for a reply. Present the choices as options the
human selects and submits, and act on what comes back.

Call the Mission Control MCP tool **`request_plan_decisions`**. It shows the plan in the
dashboard with your decision points rendered as radio buttons (choose one) or checkboxes
(choose many) plus Submit and Dismiss buttons, and is a **gate until the human submits or
dismisses that decision set**. The tool result is one of two things. Either it carries their
selections or an explicit dismissal, because the call waited for them; or it is a receipt
saying the plan is filed and not answered. On a receipt, do only read-only preparation - no
edits, saves, commits, pushes or tasks - do not file the form again or poll, then say what is
waiting and end your turn. The answer arrives later as a message that restates the plan and
each decision, and you act on it exactly as you would on the tool result. If the operator tells
you the scope changed, take the form back with `withdraw_question` and its review id and a
reason, then file the revised plan. You do not need to know your session id or post anything yourself - the
dashboard binds the resolution straight back to this session. On the root plan's first review,
append the phased implementation follow-up above after these plan-specific decisions. If the request is
dismissed, stop without applying a choice or invoking `phased-plan`; never infer selections
from an unanswered form.

Arguments:

- `title` - a short title for the plan.
- `plan` - the plan as GitHub-flavored markdown (the same content as `plan.md`), shown
  above the decisions for context.
- `decisions` - the choices to present. Each decision is:
  - `id` - a stable id for the question, echoed back in the answer.
  - `question` - what the human is deciding.
  - `options` - one or more `{ id, label, detail?, recommended? }`. Put the option you'd
    recommend first and set `recommended: true`; use `detail` for a one-line trade-off.
  - `multiSelect` - `true` for checkboxes (choose many), omit for radios (choose one).
  - `allowOther` - `true` to add a free-text field for an answer outside your options.

Example:

```json
{
  "title": "Auth for the settings page",
  "plan": "# Settings auth\n\n...the plan as markdown...",
  "decisions": [
    {
      "id": "session-store",
      "question": "Where should sessions live?",
      "options": [
        { "id": "redis", "label": "Redis", "detail": "Fast, one more service to run", "recommended": true },
        { "id": "postgres", "label": "Postgres table", "detail": "No new infra, slower reads" }
      ]
    },
    {
      "id": "providers",
      "question": "Which sign-in providers ship in v1?",
      "options": [
        { "id": "google", "label": "Google" },
        { "id": "github", "label": "GitHub" },
        { "id": "email", "label": "Email + password" }
      ],
      "multiSelect": true,
      "allowOther": true
    },
    {
      "id": "implementation-follow-up",
      "question": "What should happen after this plan is finalized?",
      "options": [
        { "id": "phased-plan", "label": "Create phased implementation plan", "recommended": true },
        { "id": "stop", "label": "Stop after this plan" }
      ]
    }
  ]
}
```

Still emit `plan.html` as above - the static page is the skimmable copy; the interactive
decisions live in the dashboard. Proceed only on selections the tool actually returns, and
resolve those selections into the source before invoking `phased-plan`.

## When the plan changes a flow: draw it

If the plan changes how data or requests move **between major components of the system, or
to an external service**, show it as a diagram - a flow described only in prose is a flow
nobody traces. This is for the load-bearing arrows: a new service in the request path, a
call that now routes through a queue, a dependency added on a third-party API, a change in
who talks to whom. It is **not** for minor components or small changes - a renamed
function, a field added to a payload, an internal helper - which prose covers fine.

- **Inline SVG, never a diagram library.** The page must open offline from `file://`, so a
  CDN-loaded renderer (Mermaid and friends) is out for the same reason every other CDN is,
  and nothing in this repo renders Mermaid anyway. SVG needs no runtime - it just renders.
  Keep it simple: a labelled box per major component or service, arrows for the flow, and a
  clear **before → after** when the *change* is the point rather than the topology.
- **The flow the diagram shows must be in `plan.md` too** (as prose, or a ```mermaid block
  as its text definition, which renders on GitHub). The page renders the plan; it doesn't
  add to it. The SVG is a rendering of that flow, not a second source of truth.
- **Only the most relevant, and at most five.** A page of diagrams is read like a page of
  none. If a plan seems to want more than five, it is either touching too much to review as
  one plan or reaching for a diagram where prose would do. Draw the flows that changed, not
  the ones that are merely present.

## What not to do

- Don't put anything in the page that isn't in the plan. If the rendering wants a fact the
  plan doesn't have, the plan is missing it - fix the plan.
- Don't reach for a CDN. The page has to work offline, from a file path, forever - that
  includes diagrams: inline SVG, never a hosted renderer.
- Don't diagram a minor change or a non-major component, and never exceed five diagrams.
  A diagram of something prose already makes clear is noise that hides the one that matters.
- Don't ask an open-ended prose question when the answer is a choice between options -
  that's what `request_plan_decisions` is for. Reserve free text for genuinely open asks.
- Don't offer the phased implementation follow-up in prose or omit it because the plan has no
  other open choices. It is the last selectable decision on the root plan's first review;
  carry the submitted choice into later reviews.
