---
name: html-plans
description: Render every written plan as a self-contained HTML page beside its markdown, draw data/request-flow changes between major components or external services as inline SVG diagrams, and when a plan has open choices, present them as selectable options the human submits from the Mission Control dashboard. Use whenever you write, publish, render, or share a plan, or a plan needs the human to decide between options.
metadata:
  mission:
    category: planning
    enforcement: triggered
---

# HTML plans

A plan that only exists as markdown in a diff gets read by whoever is already in the
diff. Rendering it as a page makes it skimmable by everyone else. And a plan whose open
questions are buried in prose gets answered by whoever happens to reply - if anyone does.
This skill fixes both: every plan becomes a page, and every plan that needs a decision
asks for it as clickable options.

## When this applies

Whenever you write a plan. Not only when asked to "share" one - the page is cheap and the
skim is the point. When the plan has genuine open choices the human should make, also use
the interactive path below instead of asking in prose.

## Always: render the plan as HTML

1. Write (or find) the plan's markdown under `docs/plans/<name>/plan.md`. That file stays
   the source of truth; the page is a rendering of it, never a fork.
2. Emit `docs/plans/<name>/plan.html` beside it: one file, no external requests - inline
   the CSS, embed any image as a `data:` URI. It must open correctly from `file://` with
   no network.
3. Keep the structure the markdown already has. Headings stay headings, tables stay
   tables. This is a rendering, not a redesign.
4. Style both light and dark via `prefers-color-scheme`, and let wide content (tables,
   code blocks) scroll inside its own container so the page body never scrolls sideways.
5. Say where you wrote it. A page nobody can find is a page nobody reads.
6. Open it for review - every time. Writing the file is not showing it: a path in a
   sentence is a page the human has to go find and open. Render the page for them with
   `SendUserFile` on `plan.html` using `display: "render"`, which opens it inline in the
   side panel so the plan is reviewed as the rendered page it is, not re-read as raw
   markdown. Do this for every plan, including the ones that then go on to the interactive
   decisions below - the rendered page is the skim, the decisions are the ask.

## When the plan needs a decision: ask with selectable options

If the plan has open choices - which approach, which scope, which of several trade-offs -
do not bury the question in prose and hope for a reply. Present the choices as options the
human selects and submits, and act on what comes back.

Call the Mission Control MCP tool **`request_plan_decisions`**. It shows the plan in the
dashboard with your decision points rendered as radio buttons (choose one) or checkboxes
(choose many) plus a Submit button, **blocks until the human submits**, and returns their
selections as the tool result. You do not need to know your session id or post anything
yourself - the dashboard binds the answer straight back to this session.

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
    }
  ]
}
```

Still emit `plan.html` as above - the static page is the skimmable copy; the interactive
decisions live in the dashboard. Proceed only on the selections the tool returns.

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
