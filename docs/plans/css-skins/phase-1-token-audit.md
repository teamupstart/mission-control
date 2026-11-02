# CSS skins - Phase 1: token audit

Source plan: `docs/plans/css-skins/plan.md`. Index: `docs/plans/css-skins/phased-plan.md`.

## 1. Outcome

Every colour the dashboard chrome paints comes from a CSS custom property declared on `:root`
in `src/web/styles.css`, and a guard test keeps it that way. Nothing changes on screen: under
today's look the dashboard is pixel-identical before and after. This is what lets a later skin
repaint the whole app by overriding tokens alone, without dark patches left by literals.

## 2. Entry criteria and dependencies

- Direct prerequisite: the planning session's pull request has merged, so this file and the
  source plan are on the default branch.
- No code prerequisites.

## 3. Scope and non-goals

In scope:

- Replace every hex literal and every `rgb()`/`rgba()` call in `src/web/styles.css` after the
  `:root` block with an existing token, a `color-mix()` of tokens, or a new named token.
- Make the `select:not([multiple])` chevron follow a token.
- Change the `select:not([multiple])` `color-scheme: dark` to `color-scheme: inherit`. The
  `:root` declaration stays `color-scheme: dark` (Default is dark), so this is a no-op today.
- Replace the two literals in `src/web/workflows/WorkflowCanvas.tsx` minimap `nodeColor`.
- Add `test/style-literals.test.ts`.

Non-goals:

- No skin, no `data-skin`, no registry, no settings UI (Phase 2).
- No `--font-display` (Phase 3).
- `src/web/lib/htmlPreview.ts` injected styles stay literal: they render inside the sandboxed
  operator-content preview, not the app chrome.
- `src/web/lib/repo-color.ts` and `AGENT_IDENTITY` accents stay as they are: identity colours,
  not theme tokens.
- No hue or value change to any existing token.

## 4. Repository findings

- `src/web/styles.css` is about 36,900 lines. The `:root` block runs from line 1 to about
  line 140 and declares about 40 tokens. After it there are 75 hex literals and 31
  `rgb()`/`rgba()` calls (counted 2026-11-02). Most frequent: `#fff` (12), `#a878ff` (8),
  `#ef5f63`, `#e5877f`, `#e5534b` (7 each), `#000` (3), then pairs such as `#42c977`,
  `#37b171`, `#2f9e63`, `#c8352c`, `#e5675f`, and dark tints like `#1d1305`, `#1a1206`,
  `#10130a`. The `rgba()` set is mostly black shadows and scrims (`rgba(0, 0, 0, 0.4)` to
  `0.55`), plus a few tinted scrims (`rgba(4, 6, 9, 0.6)`, `rgba(10, 12, 15, 0.72)`) and a
  `rgba(74, 158, 255, 0.35)` working-tone glow.
- About 1,000 `color-mix()` calls already derive from tokens and need no change.
- The chevron in `select:not([multiple])` (around line 11663) is a data-URI SVG with
  `stroke='%23939eae'`, which is `--muted` baked in.
- `--syntax-type` exists as a token; other syntax colours in the file are already tokens or
  `color-mix()`; verify while auditing.
- `WorkflowCanvas.tsx` line ~738: `nodeColor={(node) => node.className?.includes("fail") ?
  "#d34f4f" : "#76849b"}`.

## 5. Implementation steps

1. Inventory: list every literal after `:root` with its selector, and group them by meaning
   (state tone, text on a solid accent, shadow, scrim, tinted dark surface, brand-adjacent).
2. Map each group:
   - A literal equal to or within a rounding step of an existing token becomes that token.
   - A literal that is a tint of a token (for example the red family `#ef5f63`, `#e5534b`,
     `#e5877f` near `--danger`, the green family near `--idle` or `--pr-open`) becomes a new
     named token whose Default value is the exact current literal, so nothing shifts. Prefer
     names that say the role (`--danger-strong`, `--danger-soft`, `--on-accent`), not the hue.
   - `#fff` / `#000` used as text on a solid accent become `--on-accent` (Default `#fff`) or
     a similar role token.
   - Black shadows and scrims become role tokens such as `--shadow-strong` and `--scrim`,
     each declared as a complete colour or shadow value equal to the current literal.
   - Tinted dark surfaces become role tokens such as `--surface-warn`, `--surface-code`, with
     the exact current value.
   Keep the number of new tokens small, about 15. Declare each on `:root` with a one-line
   comment on what it is for, matching the file's comment style.
3. Rewrite the chevron: replace the `background-image` data URI with a `mask-image` (or a
   `::after` pseudo-element with `mask`) whose paint is `background-color: var(--muted)`, so
   it renders identically today and follows the token later. Keep the right padding.
4. Set `color-scheme: inherit` on `select:not([multiple])`.
5. `WorkflowCanvas.tsx`: resolve the two minimap colours from tokens. React Flow writes
   `nodeColor` into an SVG attribute, where `var()` is not reliable; read the computed values
   of `--danger` and `--muted` (or new tokens with the exact current values) from
   `document.documentElement` once per render, falling back to the current literals when
   `document` is absent (server render in tests).
6. Add `test/style-literals.test.ts`: read `src/web/styles.css`, strip comments, cut the
   leading `:root { ... }` block, and fail on any remaining `#rgb`, `#rrggbb`, `#rrggbbaa`,
   `rgb(` or `rgba(` occurrence, except an explicit allowlist array with a reason per entry
   (for example a colour inside a `url("data:...")` that cannot use a token). Print the
   offending selector and line on failure.

## 6. Compatibility

No persisted data, schema or API changes. Every new token's Default value equals the literal
it replaced, so Default renders identically. `color-scheme: inherit` resolves to `dark` from
`:root`.

## 7. Tests and verification

- `node --test --import ./test/setup-state.mjs --import tsx test/style-literals.test.ts`
- `npm run typecheck`, `npm run lint`, `npm test`.
- `npm run build`, then `npm run test:e2e` (existing specs must still pass; this phase changes
  no behavior).
- Visual parity: with the built dashboard, capture screenshots of the Fleet board, a
  conversation with a code block and a diff, Settings > Display, the workflow canvas and a
  modal, before and after the change, and compare them (pixel diff or side by side). Attach
  the comparison to the pull request. Store captures in a gitignored path
  (`.evidence/` or `e2e/.artifacts/`) and never commit them.
- Add a Playwright spec only if a user-visible change slips in; the intended outcome is none,
  and the parity comparison is the UI verification for this phase.

## 8. Merge and exit criteria

- The guard test passes and fails when a literal is reintroduced (demonstrate once locally).
- Typecheck, lint, unit, build and e2e pass.
- The visual parity comparison shows no difference under Default.
- The pull request lists every new token with its role and Default value.

## 9. Downstream handoff

Later phases may rely on:

- Every chrome colour in `styles.css` resolving through a `:root` token.
- The new role tokens and their names as merged. Phase 2 and 3 skins override them.
- `test/style-literals.test.ts` and its allowlist. Later phases must not add skin colours to
  `styles.css` or to the allowlist; skin colours live in `src/web/skins/`.

Later phases must not rename the new tokens without updating every skin file in the same pull
request.

## 10. Cross-phase audit record

- 2026-11-02, initial write: no earlier phase. Token naming is deliberately role-based so
  Phase 2's Daylight and Phase 3's skins can override shadows, scrims and on-accent text
  without new tokens.
- 2026-11-02, after writing Phases 2 and 3: confirmed Phase 2's contrast test reads only skin
  files and the `:root` block; it does not need the guard test's allowlist. No change.
