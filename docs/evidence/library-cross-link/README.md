# Library shelf cross-link - runtime evidence

What a shelf's link to its live half looks like after it moved out of the page's corner,
captured from a running dashboard rather than from static markup.

## How it was produced

`e2e/specs/library.spec.ts`, in the same test that measures the placement - not a staged
capture spec. The picture is taken between the geometry assertions and the navigation
assertions, so the state photographed is the state just asserted on and the two cannot
drift apart.

```
MC_E2E_EVIDENCE=1 npx playwright test --config e2e/playwright.config.ts \
  specs/library.spec.ts -g "sits beside its question" --reporter=list
```

Without `MC_E2E_EVIDENCE` the test asserts and captures nothing - the same bargain
`docs/evidence/line-drawers/` strikes, and for the same reason: an ordinary
`npm run test:e2e` would rewrite both binaries on every run for no added signal.

The daemon is the suite's own isolated fixture on its own `MISSION_HOME` and its own port,
serving the BUILT dashboard from `dist/` - not the shared `:5173` vite server, which serves
the main checkout and would have photographed unmodified code. It carries no operator data:
the workflow, the Persona and the action on these shelves are seeded by the spec, and the
rest ship with the build. No agent is launched and no model tokens are spent.

## What changed

The link used to be the last flex item of the shelf's top row, pushed out by
`margin-left: auto`. On a full-width window that parked it roughly a thousand pixels right
of the heading it belongs to, set at 10.5px with no background and no border - the smallest,
quietest text on the page, in the one place nobody looks. It is a pill on the heading's own
line now, wearing the status dot every other live surface in the app uses.

## `shelves-wide.png`

1440, the width an operator actually uses. Each shelf reads
`WORKFLOWS` / `What counts as done?` `● runs →`, with the pill sitting immediately after the
question rather than against the window's right edge. The dot is the app's status mark, and
it takes its colour from the pill through `currentColor`, so the amber state needs no second
rule for it.

The labels read `runs →` and not `30 running →` because this is a fresh daemon with no
workflow runs - the honest zero state, and what a new install shows. The counted and amber
labels are decided in `library-model.ts` and pinned in
`test/library-page-render.test.ts` ("shelf cross-links count what is live without rendering
any of it"), which is the layer that can assert every count without seeding a live run for
each one.

## `shelves-narrow.png`

720, under the 760px rung where the longest heading and the longest label stop fitting on one
line. The pill drops to its own row directly beneath the question instead of overhanging the
shelf. This is the half of the change a single wide capture would leave unphotographed, which
is why the helper shoots both.
