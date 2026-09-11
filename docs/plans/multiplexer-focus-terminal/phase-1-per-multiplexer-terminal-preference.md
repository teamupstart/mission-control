# Phase 1 - Per-multiplexer terminal preference

Part of [`phased-plan.md`](./phased-plan.md). Approved source: [`plan.md`](./plan.md).

This is the only phase. Everything the plan describes lands here.

## Outcome

Each multiplexer whose sessions need a window carries its own choice of terminal app, set on
that multiplexer's row in Setup under Terminals. Focusing a session hosted in that multiplexer
opens the chosen terminal instead of whichever one the registry happens to list first. A
multiplexer that draws its own window offers no choice and says why.

Value: today an operator with WezTerm installed but living in Ghostty gets a WezTerm window
every time they press Focus, and the product offers no way to say otherwise. The fallback that
decides this is an array ordered for a different purpose entirely.

## Entry criteria and dependencies

- Direct phase dependencies: none.
- The planning session's pull request has merged, publishing this file and its siblings to the
  default branch. That is what the scheduled task waits on.

## Scope

In scope:

1. An emulator-only preference vocabulary in `src/shared/terminal.ts`.
2. A `terminals` app-config entry holding `multiplexerTerminal`, keyed by multiplexer.
3. `GET` / `PUT /api/terminals/config`, merging per multiplexer key.
4. `raiser` and focus step 4 consulting that preference, and focus step 4 skipping a terminal
   whose binary is absent.
5. The "Opens in" control on each qualifying multiplexer row in the Setup panel.
6. Unit tests and one Playwright spec.

Explicit non-goals:

- **Do not touch `HarnessesConfig.terminalBackend`.** It answers a different question (which
  backend hosts a dispatched session, multiplexers included) and is rendered by the Harnesses
  panel. The two settings coexist.
- Do not add a terminal emulator or multiplexer adapter.
- Do not attempt to raise a self-hosting multiplexer's own window (cmux `focus-window`). That
  gap is recorded in `src/server/actions.ts` and stays open.
- Do not change focus steps 1, 2, 3 or 5, or `raiseThrough`.

## Repository findings this phase inherits

Verified against the checkout during planning. Trust these, but re-check line numbers - the
file may have moved under you.

**The defect.** `src/server/actions.ts:2219-2227`, inside `raiseOutward` step 4:

```ts
const argv = attachArgv(inside.session);
for (const id of EMULATOR_IDS) {
  const spawn = deps.emulators[id].spawn;
  if (!spawn) continue;
  const opened = await spawn.tab({ argv, title: inside.session, cwd: null });
  if (opened.ok) return { ok: true };
}
```

`EMULATOR_IDS` (`src/shared/terminal.ts:45`) is `["wezterm", "ghostty", "iterm"]`, ordered to
rank backends for *naming* a discovered session, innermost first. It is not a preference list.
The loop also checks nothing before spawning, so a machine with no terminal app makes three
doomed subprocess attempts before the step 5 error.

**The second copy.** `raiser(deps)` at `src/server/terminal/targets.ts:72-81` walks the same
array. It is called at `:113` (composing `multiplexerView`'s blurb and `unavailable` sentence)
and `:328` (the explicit launch route showing a freshly spawned detached session). Both call
sites already hold the multiplexer.

**A correction to the source plan.** `plan.md` says focus step 4 can call
`binUnavailableReason`. It cannot as written: `TerminalDeps`
(`src/server/terminal/registry.ts:118-121`) carries only `multiplexers` and `emulators`, with no
availability dependency. `TerminalTargetDeps` already solves this by extending
`BinAvailabilityDeps` (`src/server/terminal/targets.ts:42-46`) and supplying
`installed: binPresent` / `unsupported: binUnsupportedReason` in `defaultTerminalTargetDeps`
(`:48-54`).
Do the same to `TerminalDeps` and `defaultTerminalDeps`, so the check is injectable and a test
can assert that an absent terminal is never spawned at all.

**Which multiplexers need a terminal.** An adapter fact, not a name:
`src/server/terminal/cmux.ts:566` declares `attachArgv: null` because cmux draws its own
workspace; `tmux.ts:479` and `herdr.ts:297` both declare one. `multiplexerView`
(`src/server/terminal/targets.ts:102-111`) already branches on exactly this. The browser cannot
import an adapter, so the daemon must report it - do not restate "except cmux" in the panel.

**Persistence is registry-driven.** `src/server/settings-backups/config-registry.ts:24-26`
derives the settings backup set from `APP_CONFIG_ENTRY_LIST`, and its `"generic"` capture branch
(`:38-45`) parses through the entry's own schema. A `fieldsEntry` with the default capture is
therefore backed up and restored with **no** edit to that switch - the header comment calls this
"no second inclusion list to forget". `SETTINGS_BACKUP_DOMAINS`
(`src/shared/settings-backup-domains.ts:1-7`) is append-only: add `terminals` at the end, never
reorder.

**Merge semantics to copy.** `setHarnessesConfig` (`src/server/harnesses.ts:105`) merges per
agent key so editing one card cannot blank another. Merge per multiplexer key for the same
reason.

**The panel's correlation already exists.** Terminals-family `SetupRowView`s carry a
`SetupDependencyId` whose multiplexer values are spelled identically to `MULTIPLEXER_IDS`
(`src/shared/setup-catalog.ts:19-34`, `src/shared/terminal.ts:31`), and `useTerminalTargets()`
(`src/web/lib/terminalTargets.ts`) supplies the matching `TerminalTargetView`. No new mapping
table is needed.

**A verification risk.** Herdr declares `clients: null`
(`src/server/terminal/herdr.ts:203-207`), so focus step 1 can never find an existing host tab
for a Herdr session and every Herdr Focus falls through to step 4. Herdr's preference is
therefore the most exercised one. Confirm against a live Herdr if one is available; if not, say
so in the pull request rather than claiming coverage you do not have.

## Implementation steps

In execution order. This is the proposed route; where the repository disagrees, follow the
repository and record the deviation.

### 1. Shared vocabulary - `src/shared/terminal.ts`

- Add `resolveEmulatorBackend(value: string | null | undefined): { backend: EmulatorId | null; unknown: string | null }`,
  the emulator-only sibling of the existing `resolveTerminalBackend` (`:83-91`). A multiplexer id
  arriving here is `unknown`, not a valid answer - that is the point of a separate function
  rather than a filter at each call site. Add `isEmulatorId` beside it if the narrowing needs a
  name.
- Add `needsTerminalApp?: boolean` to `TerminalTargetView` (`:106-143`), documented the way its
  neighbours are: null/absent for an emulator row, and for a multiplexer it answers "does this
  backend need a terminal app to be seen".

No `node:` imports - this file is browser-safe and `src/shared/` is a controlled path.

### 2. Wire contract - `src/shared/protocol.ts`

- `TerminalsConfigSchema` with one field, `multiplexerTerminal`: an object with a key per
  `MULTIPLEXER_IDS` member, each defaulting to `null`. Write the keys out explicitly and
  constrain the object so it stays exhaustive over `MultiplexerId` - adding a multiplexer must
  fail typecheck here rather than silently produce a backend with no preference.
  `HarnessesConfigSchema.terminalBackend` (`:2506-2513`) is the shape to mirror.
- **The stored value type is loose on purpose, and this is load-bearing.** Reuse
  `StoredTerminalBackendSchema` (`:2335`, `z.string().nullable()`) for the stored values, and a
  strict `z.enum(EMULATOR_IDS)` only in the patch schema - exactly the split
  `StoredTerminalBackendSchema` / `TerminalBackendSchema` already draws at `:2335-2338`, whose
  comment reads "Strict: this build writes only registered backend ids."

  A strict *stored* schema would throw on an emulator id written by a newer build, before
  `resolveEmulatorBackend` ever ran. That would make the unknown-but-reportable rule in
  `plan.md` unimplementable: the value the row needs in order to say "I ignored a preference
  written by a newer build" is the very value the parse rejected. Loose on read, strict on
  write.
- `TerminalsConfigPatchSchema` beside it, every key optional and nullable, `.strict()`, refusing
  an empty patch - mirroring `HarnessesConfigPatchSchema` (`:2759-2765`).

### 3. Persistence - `src/shared/app-config-entries.ts`, `src/shared/settings-backup-domains.ts`

- Append `{ id: "terminals", surface: "settings" }` to `SETTINGS_BACKUP_DOMAINS`. **Append
  only** - these ids are persisted in files that outlive the build that wrote them.
- Add `terminalsFields = { multiplexerTerminal: "setting" } satisfies Record<keyof TerminalsConfig, AppConfigValueClass>`
  and register `terminals: fieldsEntry("terminals", TerminalsConfigSchema, "terminals", terminalsFields)`
  in `APP_CONFIG_ENTRIES`. Take the default `capture: "generic"` - do not add a capture kind or a
  case to `logicalConfigValue`.

### 4. Server config module - new `src/server/terminals-config.ts`

Mirror `src/server/harnesses.ts` closely, minus the legacy-upgrade handling it carries:

- `getTerminalsConfig()` - `getAppConfig(CONFIG_ENTRY)` then `TerminalsConfigSchema.parse(stored ?? {})`.
- `setTerminalsConfig(patch)` - merge `multiplexerTerminal` per key over the current value,
  persist, return the result.
- `resolveFocusEmulator(id: MultiplexerId): { backend: EmulatorId | null; unknown: string | null }` -
  the server-side convenience wrapper the policy layer calls, running the stored value through
  the shared `resolveEmulatorBackend`.
- It takes the **id**, not the `Multiplexer` adapter. The config map is keyed by id, and this
  module must not import the server-side adapter type to answer a question about a key. Every
  caller therefore passes `<adapter>.id`; `Multiplexer.id` is declared at
  `src/server/terminal/types.ts:398-399`. Do not add a second overload taking the adapter.
- It returns the **pair**, not a bare id: a resolver that collapses to `EmulatorId | null`
  throws away the unknown value the Setup row needs in order to report that it ignored a
  preference, which is the same reason `resolveTerminalBackend` returns a pair today. Policy
  callers read `.backend`; the row reads `.unknown`.
- This wrapper is server-only, because it reads server config. The **browser** never calls it:
  the panel runs the shared `resolveEmulatorBackend` over the config its hook already fetched
  (step 9).

Read at call time, never cached at module scope: a change must reach the next Focus without a
daemon restart.

### 5. Route - `src/server/routes.ts`

`GET /api/terminals/config` returning the parsed config, and `PUT` taking a patch through
`parseBody(c, TerminalsConfigPatchSchema)` and returning the merged result. Place them beside
the setup routes (around `:6609`) and follow the shape of the harnesses pair at `:6018` / `:6028`.

Do not extend `/api/harnesses/config`: that object is keyed and merged per agent, and this one
is keyed per multiplexer.

### 6. Availability view - `src/server/terminal/targets.ts`

- `multiplexerView` sets `needsTerminalApp: Boolean(sessions.attachArgv)` on every multiplexer
  row, including the early-return branches, so the field is never absent for a multiplexer.
- `raiser(deps, mux: Multiplexer)` consults `resolveFocusEmulator(mux.id).backend` first: if that emulator
  exists in `deps.emulators`, has a `spawn`, and has no `binUnavailableReason`, return it.
  Otherwise fall back to the existing `EMULATOR_IDS` walk, unchanged.
- `raiser` takes the **adapter** rather than the id, because that is what both call sites
  already hold: `:113` sits inside `multiplexerView(mux: Multiplexer, ...)` (`:83-86`) and
  `:328` sits after `const mux = deps.multiplexers[backend]` (`:310`). Neither call site has a
  bare id to pass, so `raiser` does the one `.id` lookup internally.
- Update both call sites to pass the multiplexer they already hold. The blurb at `:124` then
  names the operator's chosen terminal rather than the registry's first, which is the visible
  half of this change outside Focus.

Keep `resolveFocusEmulator` injectable rather than imported statically if the existing test
seams require it - `TerminalTargetDeps` is the established place for that.

### 7. Focus - `src/server/actions.ts`, `src/server/terminal/registry.ts`

- `TerminalDeps` extends `BinAvailabilityDeps`; `defaultTerminalDeps` supplies
  `installed: binPresent` and `unsupported: binUnsupportedReason`, exactly as
  `defaultTerminalTargetDeps` does.
- In step 4, build the attempt order as the preferred emulator (when
  `resolveFocusEmulator(mux.id).backend` names one) followed by `EMULATOR_IDS` with that id
  removed, so no backend is tried twice. `mux` here is `raiseOutward`'s own parameter, typed
  `Multiplexer | null` (`src/server/actions.ts:2162-2165`), so `.id` is the same adapter-to-id
  step `raiser` makes internally - the rule from step 4, not an exception to it.
- Skip any candidate with no `spawn` **or** with a non-null `binUnavailableReason` before
  attempting a spawn. A terminal that is present but fails anyway still falls through to the
  next candidate, so a missing or broken terminal both end with a window rather than an error.
- Leave the step 5 error text and the `attached` short-circuit alone.

### 8. Browser - `src/web/lib/api.ts`, new `src/web/useTerminalsConfig.ts`

- `getTerminalsConfig` / `updateTerminalsConfig` client functions beside the harnesses pair
  (`:252`, `:1874`).
- A hook mirroring `src/web/useHarnesses.ts`: current config, a patch function, and optimistic
  reconciliation if that is what the harnesses hook does. Follow it rather than inventing a
  second pattern.

### 9. UI - `src/web/components/SetupPanel.tsx`, `TerminalPreferencePicker.tsx`, `styles.css`

- `TerminalPreferencePicker` currently hard-codes `GROUPS` as Multiplexers + Terminal apps and
  labels itself per agent (`src/web/components/TerminalPreferencePicker.tsx:13-19`). Parameterize
  the group list and the heading/aria text so the Setup caller gets terminal apps only. Keep the
  Harnesses caller's behaviour byte-identical - it still offers both axes.
- In `SetupPanel`, give a terminals-family `SetupRow` whose dependency id is a multiplexer a
  trailing aside:
  - target reports `needsTerminalApp === true` and the multiplexer is installed: the picker,
    labelled "Opens in".
  - target reports `needsTerminalApp === true` but the multiplexer is not installed: the same
    control, disabled, reading Automatic. There is nothing to set a preference for yet.
  - target reports `needsTerminalApp === false`: the text "Needs no terminal" instead. Derived
    from the field, never from the id.
  - when the stored value does not resolve, the row says it is ignoring a preference this
    build does not recognize, rather than presenting Automatic as the operator's own choice.
    Compute this in the browser with the shared
    `resolveEmulatorBackend(config.multiplexerTerminal[rowId])` and read `.unknown` - **not**
    `resolveFocusEmulator`, which is server-only and reads server config.
    `TerminalPreferencePicker` already renders this case for the Harnesses card
    (`resolved.unknown`); follow its wording.
- CSS for the row split and the aside. The mockup in `plan.html` uses `.setup-row-split`,
  `.setup-row-aside` and `.pref-inert`; match the existing `.setup-row` vocabulary and keep the
  rows readable at narrow widths.

The modal inset rule does not apply here (this is a panel, not a modal), but the repository's
"no `data-testid`" rule does - select by role, label or placeholder.

## Data and compatibility

- **Migration: none.** `app_config` is a key/value table and the entry is additive with schema
  defaults, so an existing database gains the key on first write and reads as all-Automatic
  before that.
- **Downgrade:** a build without this entry ignores the row. A build with it reading a row
  written by a newer build **parses successfully** - the stored values are `z.string().nullable()` -
  and then resolves the unrecognized id to Automatic while keeping it reportable. This only
  works because the stored schema is loose; see step 2.
- **Backups:** picked up automatically by `SETTINGS_CONFIG_BACKUP_ENTRIES`. Confirm a snapshot
  round-trips the new domain rather than assuming it.

## Tests and verification

Unit tests under `test/`, using `node:test` and `node:assert/strict`. Run them with the loader
the suite uses:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts
```

Cover:

- `resolveEmulatorBackend`: null is Automatic; a valid emulator id passes; **a multiplexer id is
  `unknown`, not a backend**; an unrecognized string is `unknown`.
- `raiser(deps, mux)`: returns the preferred emulator when available; falls back to registry
  order when the preference is Automatic, names an unavailable terminal, or names one this build
  does not have; two multiplexers with different preferences each get their own.
- Focus step 4: attempts the preferred emulator first; **never spawns a terminal whose binary is
  absent** (assert via an injected `installed` that the spawn was not called); falls through to
  the next candidate when the preferred one fails to spawn; tries no backend twice.
- `needsTerminalApp`: false for a multiplexer with `attachArgv: null`, true for one with an
  attach argv, across every `multiplexerView` return path.
- Schema: exhaustive default of all-null; a patch for one multiplexer leaves its siblings
  untouched; an empty patch is refused; **a stored row holding an unrecognized emulator id
  parses rather than throwing**, and resolves to Automatic with that id reported as `unknown`;
  the patch schema **refuses** that same unrecognized id.

End-to-end under `e2e/` (required - this is a new UI control; see `e2e/README.md`):

- Open Setup, select Terminals, choose a terminal on a multiplexer row, assert it persists
  across a reload.
- Assert a multiplexer that needs no terminal offers no chooser.
- Assert a not-installed multiplexer's chooser is disabled.

Never spend model tokens, and never add a `data-testid`.

Then, before the pull request:

```sh
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

## Merge and exit criteria

- Focusing a session in a multiplexer with a chosen terminal opens that terminal.
- Automatic reproduces today's behaviour exactly.
- A Focus on a machine with no terminal app installed attempts no spawn and reports the existing
  step 5 error.
- The Setup Terminals family shows a chooser on exactly the multiplexers that need one.
- The Harnesses terminal preference is unchanged in behaviour and appearance.
- Typecheck, lint, build, focused unit tests and the e2e suite pass.
- One reviewable pull request in `mission-control`, with a screenshot of the Terminals family.

## Downstream handoff

No later phase depends on this one. For future work, these are the contracts established here
and the things not to quietly change:

- `multiplexerTerminal` stays exhaustive over `MULTIPLEXER_IDS`.
- Its stored values stay loose (`z.string().nullable()`) and its patch values stay strict. Do
  not "tighten" the stored schema to the enum: that silently breaks the unknown-but-reportable
  rule for every operator who downgrades.
- `needsTerminalApp` stays derived from the adapter's `attachArgv`. No consumer may name a
  backend to decide it.
- The `terminals` backup domain id is append-only and must never be reordered.
- The preference is read at focus time. Do not cache it at dispatch.

## Cross-phase audit record

- **Initial write.** Sole phase; no earlier phase to reconcile against. Audited against
  `plan.md` and the repository: every source-plan requirement and both submitted decisions are
  owned here.
- **Correction carried from investigation.** The source plan's `binUnavailableReason` call in
  focus step 4 is not reachable as written - `TerminalDeps` lacks the availability dependency.
  Step 7 above extends `TerminalDeps` instead, mirroring `TerminalTargetDeps`. `plan.md` was
  updated with the same correction during review, so the two agree.
- **Final audit.** Every requirement in `plan.md` maps to a step here; no step depends on an
  unmerged artifact; the phase leaves the repository operable with no deferred cleanup.
- **Review round 1 (CodeRabbit, valid).** The wire contract said the stored values were
  `EmulatorId | null` while the plan promised an unrecognized stored id would stay reportable.
  Those contradict: a strict stored schema rejects the value at parse time, before the resolver
  runs. Corrected in step 2 to the loose-read / strict-write split the repository already uses
  (`StoredTerminalBackendSchema` / `TerminalBackendSchema`, `src/shared/protocol.ts:2335-2338`),
  and `resolveFocusEmulator` now returns the `{ backend, unknown }` pair instead of a bare id so
  the Setup row can report the ignored preference. No approved decision changed - this makes the
  artifacts consistent with behaviour `plan.md` already specified.
- **Review round 2 (Inspector, both valid).** `plan.md` cited the step-4 block at
  `actions.ts:2216-2227` while this file cited `:2219-2227`; harmonized on `:2219-2227`, the
  `if (attachArgv) { ... }` block itself. The `targets.ts` citation was split so each fact
  carries its own range: the interface at `:42-46`, `defaultTerminalTargetDeps` at `:48-54`.
  Separately, `plan.md`'s persistence row named `src/server/db.ts`, which this phase never
  edits - `app_config` already exists and the entry needs no migration. That row now names
  `settings-backup-domains.ts` instead and says so explicitly. Editorial only; no approved
  decision changed.
- **Review round 3 (Inspector, valid).** `resolveFocusEmulator` was called with two argument
  shapes: a bare `MultiplexerId` in step 6 and `mux.id` in step 7. Checking the call sites
  showed the declaration was the wrong half - `raiseOutward` holds `mux: Multiplexer | null`
  (`actions.ts:2162-2165`), `multiplexerView` holds `mux: Multiplexer` (`targets.ts:83-86`),
  and `launchTerminal` holds `const mux = deps.multiplexers[backend]` (`:310`), so no call site
  has a bare id to pass. Settled on one rule: the resolver takes the id because the config map
  is keyed by it, `raiser` takes the adapter because that is what its callers hold, and every
  caller passes `<adapter>.id`.
  Auditing the other call sites for the same defect found a worse one: step 9 had the **browser**
  calling `resolveFocusEmulator`, which is server-only and reads server config. The panel now
  runs the shared `resolveEmulatorBackend` over the config its hook fetched. Found while
  addressing this finding, not reported by it.
