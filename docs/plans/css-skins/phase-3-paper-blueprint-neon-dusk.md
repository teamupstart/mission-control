# CSS skins - Phase 3: Paper, Blueprint and Neon Dusk

Source plan: `docs/plans/css-skins/plan.md`. Index: `docs/plans/css-skins/phased-plan.md`.

## 1. Outcome

The Skin picker offers the full approved set: Default, Daylight, Paper, Blueprint and Neon
Dusk. Paper brings warm cream surfaces with serif headings, Blueprint a cobalt drafting grid
with monospace headings, and Neon Dusk violet surfaces with a magenta and cyan glow. Each
applies live like Daylight does, and none of them moves the layout.

## 2. Entry criteria and dependencies

- Direct prerequisite: Phase 2 (skin infrastructure and Daylight) has merged.

## 3. Scope and non-goals

In scope:

- `--font-display` token on `:root` (Default `var(--sans)`) and its adoption on headings,
  card titles and Line stage names in `styles.css`.
- Registry entries `paper`, `blueprint`, `neon-dusk`, appended in that order.
- `src/web/skins/paper.css`, `blueprint.css`, `neon-dusk.css`, imported from
  `src/web/skins/index.css`.
- Each skin's scoped decoration as specified in the source plan.
- E2E and Electron geometry coverage for the new skins. Docs listing all shipped skins.

Non-goals:

- Phosphor and High Contrast (not selected).
- A "Match system" option.
- Any change to Phase 2 contracts, the contrast threshold or the registry shape.
- `filter` or `backdrop-filter` on scrolling content.

## 4. Repository findings and inherited contracts

Inherited from Phase 2: `SKINS` registry and append-only ids; `ui.skin` schema; `lib/skin.ts`
as the only writer of `data-skin`; skin files select on `:root[data-skin="<id>"]`;
`test/skins.test.ts` enforces 4.5:1 for text and state tones; `e2e/specs/settings-skins.spec.ts`
iterates shipped skins. Inherited from Phase 1: all chrome colours are tokens, including role
tokens for shadows, scrims, on-accent text and tinted surfaces.

Findings:

- `test/line-strip-electron.test.ts` renders `LineStrip` with `renderToStaticMarkup` into a
  shell it builds with the real stylesheet and asserts the expanded and condensed band
  heights (86px and 38.5px). Stage names are where `--font-display` lands on the Line, so
  this is the geometry test to extend.
- Measured ladders (`src/web/topbarLadder.ts`, `detailHeadLadder.ts`, `detailTabsLadder.ts`,
  `measuredLadder.ts`) measure laid-out widths; a font-family change can move a breakpoint.
- The source plan's palettes for these three skins passed a WCAG 4.5:1 check for every text and
  state tone on `--bg`, `--panel` and `--panel-2`.

## 5. Implementation steps

1. **`--font-display`.** Declare `--font-display: var(--sans)` on `:root` with a comment.
   Apply `font-family: var(--font-display)` to section and panel headings, card titles (board
   cards and session tiles) and Line stage names. Change only `font-family`, never size,
   weight, line height or letter spacing, so Default is unaffected and other skins keep the
   same metrics.
2. **Registry.** Append `paper` (light), `blueprint` (dark), `neon-dusk` (dark) to `SKINS` with
   labels "Paper", "Blueprint", "Neon Dusk", the source plan's one-line descriptions and
   swatches equal to the token values.
3. **Paper** (`src/web/skins/paper.css`): the source plan's token values, Phase 1 role tokens
   retuned for a warm light surface, `--radius: 6px`, `--font-display` set to
   `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`. No other decoration.
4. **Blueprint** (`blueprint.css`): token values, `--radius: 3px`, `--font-display:
   var(--mono)`; decoration: a 20px drafting grid on the app background (two
   `linear-gradient`s of a low-alpha light line), headings and stage labels uppercase. The
   grid is a background on the app shell only, not on scrolling lists.
5. **Neon Dusk** (`neon-dusk.css`): token values with `--purple` as magenta (so Foreman, cost
   and held read magenta), `--radius: 14px`; decoration: a violet-to-indigo radial backdrop on
   the app shell, a magenta glow (`box-shadow`) on focused and attention surfaces, and a
   magenta-to-cyan gradient on the Dispatch button with dark text that clears 4.5:1 on both
   gradient ends.
6. Every decoration selector is prefixed with `:root[data-skin="<id>"]`. Use tokens or
   `color-mix()` of tokens inside the skin file where possible; literal colours are allowed in
   skin files.
7. **Docs.** Add the three skins to `docs/ui.md` and `docs/skills-and-settings.md`.

## 6. Data, API and compatibility

No schema change: the new ids join `SKIN_IDS`, which the Phase 2 schema reads. A machine that
downgrades to a Phase 2 build reads `paper`, `blueprint` or `neon-dusk` as `default` through
the Phase 2 `.catch`.

## 7. Tests and verification

- `test/skins.test.ts` passes unchanged for the three new files (it iterates the registry).
- `test/line-strip-electron.test.ts`: add cases that set `data-skin="paper"` and
  `data-skin="blueprint"` on the shell and assert the same expanded and condensed heights.
- `e2e/specs/settings-skins.spec.ts`: extend the iteration to Paper, Blueprint and Neon Dusk
  with the same live-apply and persistence assertions; assert the topbar, the Line strip and
  the Dispatch button stay visible and unclipped under each (the measured ladders still fit).
  Capture a Fleet board screenshot per skin into `e2e/.artifacts/` and attach them to the pull
  request; never commit them.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`, `npm run test:electron` on macOS.
- Manual: switch through all five skins with Settings open; check repository-colour frames,
  agent accents and Mermaid diagrams on each; record it in the pull request.

## 8. Merge and exit criteria

- All five skins apply live, persist, and pass the contrast test.
- Line strip heights are unchanged under Paper and Blueprint; no ladder clips the topbar.
- Screenshots of each new skin are attached to the pull request.
- All gates in section 7 pass.

## 9. Downstream handoff

This is the last phase. After it, `SKINS` holds five ids in the order `default`, `daylight`,
`paper`, `blueprint`, `neon-dusk`; future skins append after `neon-dusk` and follow the
"Adding a skin" contract in `docs/agent-guides/change-contracts.md`.

## 10. Cross-phase audit record

- 2026-11-02, initial write: confirmed no Phase 2 contract needs to change. `--font-display`
  is owned here because only these skins change fonts; Phase 2's Daylight keeps the system
  font, so Phase 2 can merge without the token. The contrast test, e2e spec and registry
  shape from Phase 2 are consumed as is.
- 2026-11-02, final audit over all phases: every source-plan requirement has one owner (token
  audit: Phase 1; registry, persistence, live apply, Electron first paint, picker, search,
  Mermaid, Daylight, contrast test, docs contract: Phase 2; `--font-display`, Paper, Blueprint,
  Neon Dusk, decoration, geometry re-checks: Phase 3). The graph is serial with no concurrent
  phases. The final state matches the source plan with Phosphor, High Contrast and Match
  system excluded as decided.
