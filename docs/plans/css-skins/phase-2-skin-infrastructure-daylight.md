# CSS skins - Phase 2: skin infrastructure and Daylight

Source plan: `docs/plans/css-skins/plan.md`. Index: `docs/plans/css-skins/phased-plan.md`.

## 1. Outcome

An operator opens **Settings > Display > Appearance**, sees a **Skin** picker with two tiles,
Default and Daylight, and selecting a tile repaints the whole dashboard immediately behind the
open settings page, with no Save button and no reload. The choice persists per machine in
`app_config.ui.skin`, applies from the first frame on the next load, and the Electron window
opens in the chosen skin's background with no dark flash.

## 2. Entry criteria and dependencies

- Direct prerequisite: Phase 1 (token audit) has merged. Daylight depends on every chrome
  colour resolving through a token.

## 3. Scope and non-goals

In scope:

- `src/shared/skins.ts` registry with `default` and `daylight`.
- `ui.skin` in the UI config schema, patch schema, defaults, field registry and cache.
- `src/web/lib/skin.ts`: apply, subscribe, Electron background bridge.
- Electron preload method, IPC handler, persisted last background, `createWindow` reads it.
- Skin picker in `AppearancePanel`, settings-search entry, picker CSS.
- `src/web/skins/index.css` and `src/web/skins/daylight.css`.
- Mermaid diagrams re-render on skin change and get the skin's colour scheme.
- Tests: unit, markup, e2e. Docs for the feature and the "Adding a skin" contract.

Non-goals:

- Paper, Blueprint, Neon Dusk, `--font-display` and decoration (Phase 3).
- A "Match system" option (declined for v1): no OS listener, no `prefers-color-scheme` logic.
- Live reconciliation of a skin chosen in a second dashboard tab.
- Changing agent accents or `repo-color.ts` hues.

## 4. Repository findings and inherited contracts

Inherited from Phase 1: every chrome colour in `styles.css` is a `:root` token, including the
role tokens Phase 1 introduced; `test/style-literals.test.ts` forbids literals in `styles.css`.

Findings:

- `UiConfigSchema`, `UI_CONFIG_DEFAULTS` and `UiConfigPatchSchema` live in
  `src/shared/protocol.ts` (around lines 3390-3690). `UiConfigPatchSchema` is
  `UiConfigSchema.partial().refine(...)`, so a `.catch()` on the stored field would also
  swallow a bad PATCH.
- `src/shared/app-config-entries.ts` `uiFields` is `satisfies Record<keyof UiConfig, ...>`:
  typecheck forces a `skin: "setting"` entry, which also enrols it in settings backup.
- `src/web/lib/uiCache.ts` `coerce()` parses each field by hand for the synchronous first
  paint (`parseLineDensity` is the model).
- `src/web/lib/uiConfig.ts` is a module store with `uiConfig()`, `updateUiConfig()` (optimistic
  commit plus rollback) and a `subscribe` used by `useSyncExternalStore`.
- `src/web/main.tsx` imports `./styles.css` at line 14.
- `AppearancePanel.tsx` holds the Format messages toggle (`display/format-messages`).
  `LineDensityPanel.tsx` is the radiogroup-of-tiles pattern (`layout-picker`,
  `layout-option view-option`, `role="radiogroup"`, a thumbnail per option).
- `src/web/lib/settings-search.ts` entries have `{ id, title, description, category, anchor,
  keywords, kind, backup }`.
- `src/web/components/MermaidDiagram.tsx` calls `readMermaidPalette()`
  (`src/web/lib/mermaidPreview.ts`), which reads computed tokens at render time;
  `src/web/mermaid-renderer.html` pins `:root { color-scheme: dark; }`.
- `src/main/window.ts` `createWindow` sets `backgroundColor: "#0e1116"`.
  `src/preload/index.ts` exposes `window.missionDesktop` via `contextBridge`; handlers are
  `ipcMain.handle("mission:...")` in `src/main/index.ts`; types in
  `src/web/mission-desktop.d.ts`. `src/main/update-preferences.ts` is the existing persisted
  main-process preference pattern.

## 5. Implementation steps

1. **Registry.** Add `src/shared/skins.ts` (browser-safe, no `node:` imports):
   `SKINS` as a readonly, append-only array of
   `{ id, label, description, colorScheme: "dark" | "light", swatches: { bg, panel, fg,
   working, idle, attention } }` with `default` (swatches = today's `:root` values) and
   `daylight` (values from the source plan's token table). Export `SKIN_IDS`, `SkinId`,
   `DEFAULT_SKIN = "default"`, and `skinById(id)`. Comment that ids are persisted and
   append-only.
2. **Schema.** In `protocol.ts`: `SkinIdSchema = z.enum(SKIN_IDS)`; `UI_CONFIG_DEFAULTS.skin =
   "default"`; in `UiConfigSchema`, `skin: SkinIdSchema.catch(UI_CONFIG_DEFAULTS.skin)` (a
   missing key and an unknown stored id both read as Default). Make `UiConfigPatchSchema`
   validate `skin` strictly, for example by extending the partial with
   `skin: SkinIdSchema.optional()`, so `PATCH { skin: "nope" }` is a 400. Keep the existing
   non-empty refine.
3. **Field registry and cache.** Add `skin: "setting"` to `uiFields`. Add `parseSkin` to
   `uiCache.ts` mirroring `parseLineDensity` and use it in `coerce()`.
4. **Skin CSS.** Create `src/web/skins/index.css` that `@import`s each skin file, and
   `src/web/skins/daylight.css` with `:root[data-skin="daylight"] { ... }` overriding every
   colour token Daylight needs: the source plan's table plus the Phase 1 role tokens
   (shadows, scrims, on-accent text and tinted surfaces re-tuned for a light background) and
   `--radius: 10px`. Do not define `default.css`; Default is `:root`. Import
   `./skins/index.css` in `main.tsx` directly after `./styles.css`.
5. **Apply.** Add `src/web/lib/skin.ts`: `applySkin(id)` sets
   `document.documentElement.dataset.skin` (remove the attribute for `default`), sets
   `document.documentElement.style.colorScheme` from the registry, and calls
   `window.missionDesktop?.setWindowBackground?.(computedBg)` with the computed `--bg`. Call it
   once at module load from `uiConfig().skin` (seeded synchronously from the cache), and
   subscribe to the store so every commit, optimistic or rollback, re-applies when `skin`
   changed. Import the module for its side effect from `main.tsx` before React renders.
6. **Electron.** Preload: add `setWindowBackground(color: string): Promise<void>` invoking
   `mission:set-window-background`; type it in `mission-desktop.d.ts` as optional so older
   preloads stay compatible. Main: validate the colour (`/^#[0-9a-f]{6}$/i`), call
   `win.setBackgroundColor`, and persist it in a small preference file following
   `update-preferences.ts`. `createWindow` reads the persisted value, falling back to
   `#0e1116`. Read the colour in the renderer from computed style and convert to `#rrggbb`.
7. **Picker.** In `AppearancePanel.tsx`, add a "Skin" radiogroup above Format messages, built
   like `LineDensityPanel`: `role="radiogroup"` with `aria-label="Skin"`, one
   `label.layout-option.view-option` per `SKINS` entry with a radio input (accessible name =
   the skin label), a thumbnail drawn from `swatches` (background, panel, text bar and three
   state dots), the label and one-line description. `data-anchor="display/skin"`. Selecting
   calls `updateUiConfig({ skin })`. Section hint text: "Applies the moment you pick it - the
   dashboard behind this page repaints live." Add CSS for the thumbnail in `styles.css` using
   tokens only (the thumbnail's own swatch colours are inline styles from the registry, which
   the guard test does not scan). Arrow keys move between radios natively.
8. **Search.** Add a `settings-search.ts` entry: id `skin`, title "Skin", category
   `display`, anchor `display/skin`, keywords including "skin", "theme", "dark", "light",
   "colour", "color", "appearance", backup domain `ui`.
9. **Mermaid.** In `MermaidDiagram.tsx`, re-render mounted diagrams when `uiConfig().skin`
   changes (subscribe via the existing store hook), so the palette is read again. Pass the
   skin's `colorScheme` to the renderer and let `mermaid-renderer.html` apply it instead of
   the pinned `dark`.
10. **Docs.** Update `docs/ui.md` (Display settings) and `docs/skills-and-settings.md` with the
    Skin picker and Daylight. Add an "Adding a skin" section to
    `docs/agent-guides/change-contracts.md`: append-only id in `src/shared/skins.ts`, one file
    in `src/web/skins/`, required tokens, the contrast test, the e2e spec entry. No em dashes.

## 6. Data, API and compatibility

- `app_config.ui` is a JSON record; a missing `skin` key parses to `default`. No migration.
- A stored unknown id (downgrade) reads as `default`; the read never fails.
- `PATCH /api/ui-config` (or the route `api.setUiConfig` calls) rejects an unknown `skin` with
  400; the store rolls the optimistic attribute back.
- Settings backup and restore carry `skin` through the `ui` domain.
- Older desktop preloads without `setWindowBackground` are tolerated (optional chaining).

## 7. Tests and verification

- `test/skins.test.ts`: ids unique, kebab-case, `default` first; every non-default registry id
  has `src/web/skins/<id>.css` and `index.css` imports it; each skin file declares every
  required colour token; WCAG contrast of `--fg`, `--muted`, `--dim`, `--working`, `--idle`,
  `--attention`, `--danger`, `--purple` against `--bg`, `--panel`, `--panel-2` is at least
  4.5:1 (parse the hex values from the file; Default from `styles.css` `:root`); swatches
  equal the file's token values.
- `test/ui-config-*.test.ts` (extend the existing files): schema default, unknown stored id
  falls back, strict patch rejects, cache round-trips `skin`.
- `test/settings-search.test.ts`: the `display/skin` anchor resolves and keywords find it.
- A `renderToStaticMarkup` test for `AppearancePanel`: one radio per `SKINS` entry with an
  accessible name, the checked one matches the store.
- `test/desktop-preload-electron.test.ts`: the preload exposes `setWindowBackground`.
- `e2e/specs/settings-skins.spec.ts` (new; read `e2e/README.md` first): open Settings >
  Display, select "Daylight" by radio role and name; without a reload assert
  `html[data-skin="daylight"]` and that the computed `background-color` of `body` (or the app
  root) equals Daylight's `--bg`; reload and assert it persisted; select "Default" and assert
  the attribute is gone and the background is Default's; close settings and assert the Fleet
  board renders in the chosen skin. Select by role, label or placeholder only, no
  `data-testid`. Capture a Daylight screenshot of the Fleet board and of Settings into
  `e2e/.artifacts/` and attach them to the pull request (never commit them).
- Single-file runs use `node --test --import ./test/setup-state.mjs --import tsx <file>`.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`, and `npm run test:electron` on macOS.
- Manual: in the desktop app, choose Daylight, quit, relaunch, and confirm no dark frame
  before the dashboard paints. Check repository-colour frames and agent accents are still
  visible on Daylight; record the observation in the pull request.

## 8. Merge and exit criteria

- Selecting Default or Daylight applies live, persists across reload and relaunch, and an
  invalid id is refused.
- Daylight passes the contrast test and shows no dark patches on the Fleet board, a
  conversation with code and diff, Settings, the workflow canvas and a modal (screenshots in
  the pull request).
- All gates in section 7 pass.

## 9. Downstream handoff

Phase 3 may rely on, and must not change:

- `SKINS` shape, `SKIN_IDS` order (`default`, `daylight`) and append-only rule.
- `ui.skin` schema semantics (catch on read, strict on patch) and `parseSkin`.
- `lib/skin.ts` as the only writer of `data-skin` and the window background.
- The skin file shape, `src/web/skins/index.css`, and the import order in `main.tsx`.
- `test/skins.test.ts` contract and threshold; Phase 3 skins must pass it, not relax it.
- `e2e/specs/settings-skins.spec.ts`; Phase 3 extends it with its skins.

## 10. Cross-phase audit record

- 2026-11-02, initial write: consumes Phase 1's role tokens; Daylight overrides them. Moved
  the "strict patch, tolerant read" decision here from the source plan, which had only the
  tolerant read.
- 2026-11-02, after writing Phase 3: Phase 3 needs `--font-display`, which this phase does not
  declare; kept in Phase 3 because only Phase 3 skins change fonts and Default is unaffected.
  The contrast test here already iterates all registry entries, so Phase 3 needs no test
  change beyond its skin files. No edit required.
