---
category: landmine-map
date: 2026-08-14
source-session: sdk:1a98388a-1faa-429d-b0e1-678f55573563
times-confirmed: 1
---

# Adding a topbar page segment trips four guards in four layers

`PAGE_SEGMENTS` in `src/web/App.tsx` is not the only place that knows how many pages the
title bar has. Adding one breaks, in this order:

- `AppPageShell`'s exhaustive `Record<MissionRoute["page"], ReactNode>` - a compile error,
  and the intended signal;
- `test/tooltip-coverage.test.ts` - a source scan that fails until every new interactive
  element is wrapped in `<Tooltip>`;
- `test/keybindings.test.ts` - its round-trip asserts every default binding is producible
  from a real keydown, so a new chord must be added to that list of events;
- `e2e/specs/library.spec.ts` - which pins the segment count with
  `expect(pages.getByRole("button")).toHaveCount(N)`.

The last is the trap: it sits in a spec whose name gives no hint it guards the title bar, so
a focused local run misses it and it fails only on CI. Update the count rather than loosening
it - it is the guard that adding a page is a deliberate act - and re-run
`e2e/specs/topbar-one-row.spec.ts`, which measures whether the bar still fits one row at the
pinned width once the new segment is carrying width.
