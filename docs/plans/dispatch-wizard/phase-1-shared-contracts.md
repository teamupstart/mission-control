# Phase 1 - Shared task kinds and the guided-dispatch preference

## Outcome

Two shared contracts land before anything consumes them: a single ordered registry of task
kinds, and a `guidedDispatch` boolean carried end to end on `UiConfig`. Nothing on screen
changes.

The value is that both are in controlled paths - `src/shared/types.ts`,
`src/shared/protocol.ts` - and the `UiConfig` path has a well-known trap that silently
degrades. Reviewing those changes alone, against a diff with no UI in it, is worth one pull
request.

## Entry criteria and dependencies

- Direct prerequisites: none. This is the root phase.
- Requires `main` at or after the artifact commit that publishes this plan.

## Scope

1. `TASK_KINDS`, an ordered tuple, with `TaskKind` derived from it.
2. Presentational labels for the two kinds.
3. `guidedDispatch: boolean` on `UiConfig`, defaulting to **`false`**.
4. A `useGuidedDispatch()` hook.
5. Drive the existing Kind `<select>` and the zod restatements off `TASK_KINDS`.

### Non-goals

- No wizard, no rail, no picker, no key handling. Phase 2.
- No Settings surface. Phase 3.
- **Do not change the default to `true`.** Phase 5 owns that, and moving it here breaks the
  e2e suite before the fixture that protects it exists.
- No `e2e/` changes at all in this phase.

## Repository findings

`TaskKind` is declared as a bare union at `src/shared/types.ts:1416`:

```ts
export type TaskKind = "ship" | "scout";
```

There is no tuple, so the pair is restated four more times: hardcoded `<option>`s at
`DispatchModal.tsx:1597-1598`, and `z.enum(["ship", "scout"])` at `src/shared/protocol.ts:608`,
`:764`, `:4271` and `src/shared/task-source.ts:380`. The house pattern for exactly this is
`AGENT_TYPES` (`src/shared/types.ts:44`), which is the tuple with the type derived from it, and
`DispatchModal.tsx:1573-1576` carries a comment explaining why the Agent select is driven off it
and a hand-written option list would go stale silently. The Kind select is that stale list.

`src/shared/task.ts:16-19` is the established home for presentational companions
(`TASK_PRIORITIES`, `PRIORITY_LABELS`), and it already imports `TaskKind` from `types.ts`.

The `UiConfig` chain is `UI_CONFIG_DEFAULTS` + `UiConfigSchema` (`src/shared/protocol.ts:1724`
and `:1744`) → the `app_config` KV row `"ui"` → `GET/PUT /api/ui/config` → the module store
`src/web/lib/uiConfig.ts` → a per-setting hook. Two things about it are load-bearing:

- `UI_CONFIG_DEFAULTS` is a **plain object, deliberately separate from the zod schema**
  (`protocol.ts:1728-1732` explains why: the web bundle reads it synchronously at module load
  and zod must not end up in `dist/web`). Add to both.
- `src/web/lib/uiCache.ts`'s `coerce()` (`:87-102`) copies **field by field, never a spread**
  (comment at `:61-66`). A field omitted there is dropped from the first-paint cache and
  appears to reset on every cold load. This is the trap.

No migration is needed: `app_config` is a KV row, `setUiConfig` shallow-merges through
`UiConfigSchema.parse`, and the object is not `.strict()`.

## Implementation steps

1. **`src/shared/types.ts`** - replace the bare union at `:1416` with a tuple plus a derived
   type, preserving the existing doc comment:

   ```ts
   export const TASK_KINDS = ["ship", "scout"] as const;
   export type TaskKind = (typeof TASK_KINDS)[number];
   ```

   The resulting type is identical, so no consumer changes.

2. **`src/shared/task.ts`** - add labels beside `PRIORITY_LABELS`, following its shape. The
   wizard needs a short description per kind as well as a label; keep both here so the option
   copy has one home.

3. **`src/shared/protocol.ts`** and **`src/shared/task-source.ts`** - replace each
   `z.enum(["ship", "scout"])` with `z.enum(TASK_KINDS)`. Four sites. This is what stops the
   registry and the wire contract drifting.

4. **`src/shared/protocol.ts`** - add `guidedDispatch: false` to `UI_CONFIG_DEFAULTS` (`:1734`)
   and `guidedDispatch: z.boolean().default(UI_CONFIG_DEFAULTS.guidedDispatch)` to
   `UiConfigSchema` (`:1744`), with a one-line comment saying what it gates.

5. **`src/web/lib/uiCache.ts`** - add the field to `coerce()` (`:87-102`), in the same
   `raw?.x ?? UI_CONFIG_DEFAULTS.x` shape as its neighbours. Do not spread.

6. **New hook** - `useGuidedDispatch()`, modelled on `useRichText`
   (`src/web/lib/rich-text.ts:23-29`): read via `useUiConfig()`, write via `updateUiConfig`.
   Place it beside the feature it serves rather than in `rich-text.ts`; a new small module under
   `src/web/lib/` is fine, and Phase 2 and Phase 3 both import it.

7. **`src/web/components/DispatchModal.tsx`** - render the Kind `<option>`s from `TASK_KINDS`
   (`:1596-1599`), mirroring the Agent select directly above it. Behaviour, order and option
   values are unchanged; this is the only file outside `src/shared/` and `src/web/lib/` this
   phase touches.

## Data, API and compatibility

- **No migration.** No table, column, index or route changes.
- **Forward compatible:** an older daemon returning a `ui` row without `guidedDispatch` parses
  fine, because the schema field carries `.default(...)`.
- **Backward compatible:** a newer row read by an older build is ignored - the object is not
  `.strict()`, which `protocol.ts:1770-1774` documents as the reason retiring a key needs no
  migration.
- The daemon never reads `UiConfig` values; it is a per-machine store.

## Tests and verification

Add to `test/`:

- `TASK_KINDS` contains exactly `ship` and `scout`, in that order, and every `TaskKind` is a
  member. Order is a contract - it is the display order Phase 2 renders.
- The `UiConfig` round trip preserves `guidedDispatch`: `UiConfigSchema.parse({})` yields the
  default, and a patch through the store returns it. Extend the existing `uiCache`/`uiConfig`
  coverage rather than starting a new file if one exists.
- A `renderToStaticMarkup` assertion that the dispatch form's Kind control still offers both
  options in order, so step 7 is proved to be a refactor. Extend
  `test/dispatch-details-fold.test.ts` or `test/backlog-edit-render.test.ts` rather than adding
  a file.

Commands: `npm run typecheck`, `npm run lint`, `npm test`.

`npm run test:e2e` is **not** expected to change and should stay green untouched; run it once to
prove step 7 was a refactor. Requires `npm run build` first.

## Merge and exit criteria

- All four commands above pass.
- The diff contains no user-visible change. Opening the dispatch modal is byte-identical in
  behaviour.
- `guidedDispatch` is readable and writable through the hook, and nothing calls it yet.
- `grep -rn '"ship", "scout"\|"ship" | "scout"' src/` returns only the tuple's own declaration.

## Downstream handoff

Later phases may rely on:

- `TASK_KINDS` being the ordered source of truth for kinds, and `TaskKind` being derived from it.
- `UiConfig.guidedDispatch` existing, defaulting to `false`, and surviving a cold paint.
- `useGuidedDispatch()` being the only read/write path.

Later phases must not:

- Change the shipped default here. Phase 5 owns that single line.
- Reintroduce a hardcoded kind pair anywhere.
- Move the hook's module path without updating phases 2 and 3.

## Cross-phase audit record

- **Initial.** No earlier phases to reconcile against.
- Deliberately excludes the `e2e/fixtures/test.ts` pin even though it concerns the same
  preference. The pin has no meaning until something reads the preference, and Phase 2 is where
  the specs that need the opposite value are written. Recorded as a Phase 2 obligation in the
  index's cross-phase contracts.
- Deliberately does **not** extract `afterWorkForKind`. See finding 3 in `phased-plan.md`; the
  guided pass calls the existing closure.
