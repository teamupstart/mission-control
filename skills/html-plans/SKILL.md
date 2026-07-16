---
name: html-plans
description: Renders a written plan as a single self-contained HTML page next to the markdown, so a plan can be skimmed in a browser instead of a diff. Use when the user asks to publish, render, or share a plan, or asks for a plan "as a page".
metadata:
  fleet:
    category: planning
    enforcement: triggered
---

# HTML plans

A plan that only exists as markdown in a diff gets read by whoever is already in
the diff. Rendering it as a page makes it skimmable by everyone else.

## When this applies

The user asks to publish, render, or share a plan, or asks for one "as a page".
Not on every plan you write - a plan nobody asked to share is fine as markdown.

## What to do

1. Write (or find) the plan's markdown under `docs/plans/<name>/plan.md`. That file
   stays the source of truth; the page is a rendering of it, never a fork.
2. Emit `docs/plans/<name>/plan.html` beside it: one file, no external requests -
   inline the CSS, embed any image as a `data:` URI. It must open correctly from
   `file://` with no network.
3. Keep the structure the markdown already has. Headings stay headings, tables stay
   tables. This is a rendering, not a redesign.
4. Style both light and dark via `prefers-color-scheme`, and let wide content
   (tables, code blocks) scroll inside its own container so the page body never
   scrolls sideways.
5. Say where you wrote it. A page nobody can find is a page nobody reads.

## What not to do

- Don't put anything in the page that isn't in the plan. If the rendering wants a
  fact the plan doesn't have, the plan is missing it - fix the plan.
- Don't reach for a CDN. The page has to work offline, from a file path, forever.
