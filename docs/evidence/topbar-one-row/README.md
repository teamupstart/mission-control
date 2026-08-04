# Evidence: the topbar holds one row

Two frames of the same bar, same fleet, same 1360px viewport, taken by the same assertion in
`e2e/specs/topbar-one-row.spec.ts`. The only difference between them is the commit.

| Frame | Bar |
|---|---|
| [`before-two-rows.png`](before-two-rows.png) | 113px, two rows - Foreman, Dispatch and the glyph tools pushed onto a second row |
| [`after-one-row.png`](after-one-row.png) | 69px, one row - the search collapsed to its ⌕ and paid for the rest |

These exist because "one row" is checkable in the DOM as a height and the spec does check it,
but it is only legible as a *title bar* here. The before frame is also the answer to the
obvious question about the after frame - the search is a glyph, so what did that buy? It
bought the 44px and the second row.

What the pair shows beyond the row count is that the ladder took the cheapest thing and
stopped. `Fleet`, `Library` and `Runs` keep their words and their keycaps, the pulse still
reads `live · 1 session · 1 need you`, and the cost chip still states its figure. Only the
empty 184px text field went, and clicking its glyph brings it straight back.

The fleet is deliberately busy: a dispatched agent parked on its own `AskUserQuestion`, which
holds `need you` on the readout. That matters because the pulse is the one part of the bar
whose width is a function of the fleet rather than the layout, and an idle fleet is ~146px
narrower - narrow enough that the old ladder fit, which is exactly why it shipped.

## Regenerate

The after frame:

```sh
npm run build
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/topbar-one-row.spec.ts \
  -g 'one row at the width' \
  --workers=1 --reporter=list
mv docs/evidence/topbar-one-row/topbar-1360.png \
   docs/evidence/topbar-one-row/after-one-row.png
```

The before frame needs the pre-fix code, and the capture is deliberately authored *above* the
assertion so this run still produces a picture rather than stopping at a red assertion with
nothing to look at. The test fails, and that failure is the point:

```sh
git checkout <this-commit>~1 -- src/web/styles.css src/web/App.tsx
npm run build
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/topbar-one-row.spec.ts \
  -g 'one row at the width' \
  --workers=1 --reporter=list
# CAPTURED .../topbar-1360.png (2 row(s), 113px)
# Error: the bar wrapped to 2 rows
mv docs/evidence/topbar-one-row/topbar-1360.png \
   docs/evidence/topbar-one-row/before-two-rows.png
git checkout <this-commit> -- src/web/styles.css src/web/App.tsx
```

Use `git checkout <ref> -- <paths>` rather than `git stash` for that round trip. Every
treehouse worktree here shares one `.git`, so the stash stack is shared too: a `git stash
push` that matches no changes saves nothing, and the `git stash pop` after it then pops a
different session's entry.
