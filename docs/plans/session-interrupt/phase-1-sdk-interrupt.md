# Phase 1 - SDK runtime interrupt, end to end

Source plan: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## Outcome

Pressing <kbd>Ctrl</kbd><kbd>C</kbd> on a working SDK-runtime session stops the current
turn, drops anything queued behind it, and leaves the cursor in that session's composer.
The card shows an interrupting state until the driver confirms, then returns to idle with
the conversation intact.

The whole gesture ships here - binding, route, control, queue drop, presentation, and a
visible button. Only the *terminal* mechanism is deferred. A terminal-runtime card renders
the control disabled with a reason, driven by a capability rather than by a special case,
so Phase 2 enables it by declaring a capability rather than by touching UI.

## Entry criteria and dependencies

None. This phase is first.

## Scope

**In:** the `interrupt` capability slot and its agreement test; `SdkSupervisor.interrupt`;
the runtime fan-out helper with both arms (the terminal arm refusing); `POST
/api/sessions/:id/interrupt`; dropping the session's `PendingTurnManager` outbox rows; the
`interrupt` action id bound to `ctrl+c` with selection yielding and a composer bypass; the
board-overview in-place arm; the action-bar button in both variants; the transient
interrupting presentation; docs; unit tests and one Playwright spec.

**Out:** writing `Escape` into a terminal pane and everything that implies - the
`escape` key in the terminal vocabulary, the four backend renderings, the guarded pane
writer. That is Phase 2 and it must not be started here. Also out: any change to `kill`,
any new `SessionState` member, any new `Session` field.

## Repository findings this phase relies on

Verified at commit `eee83d2`. Read these before writing code; several contradict the
obvious approach.

**The driver primitive already exists.** `SdkSessionHandle.interrupt()` is declared at
`src/server/harness/types.ts:676` and implemented at `claude/sdk.ts:412` (vendor
`query.interrupt()`) and `codex/sdk.ts:463` (`turn/interrupt` RPC). Both already tolerate
being called when nothing is running - Codex returns early with a comment saying a
late interrupt must not error. Do not rewrite these.

**Do not reconcile turn bookkeeping by hand.** `unfinishedTurns` and
`sdk_sessions.turn_in_progress` look like state an interrupt should clear. They are not:
the event pump maintains them on `turn_done` (`supervisor.ts:772-777`), and both drivers
emit `turn_done` after an interrupt (Claude via the CLI `result` message,
`claude/sdk.ts:849`; Codex via `turn/completed` → `finishTurn`, `codex/sdk.ts:858` and
`:1083`). A manual decrement double-counts and corrupts restart recovery. Pin the
self-reconciliation with a test instead.

**Interrupt must not use `serialize()`.** `send()` runs a per-session FIFO
(`supervisor.ts:298`); an interrupt queued behind the turn it stops does nothing.
`stop(id)` is already documented as deliberately unqueued (`supervisor.ts:472`) - copy
that, reading `this.handles.get(id)` directly.

**`cancel_queued` is not reachable and not needed.** The pinned SDK (0.3.220) declares
`interrupt(): Promise<SDKControlInterruptResponse | undefined>` with no parameters
(`sdk.d.ts:2293`). Mission Control never builds a driver-side queue anyway - its only
send paths are `supervisor.send()` (serialized; mid-turn sends *steer*) and
`sendWhenIdle()` (idle-only). The queue to drop is the `PendingTurnManager` outbox.

**The typing guard blocks BAR_ACTIONS.** This is the correction that most changes the UI
work. `App.tsx:1554` runs `if (typing) return;` **above** the `BAR_ACTIONS` dispatch at
`:1834`. The `chordHasCommandModifier` bypass at `:1441-1449` exists for exactly one
action (the palette). So adding an `interrupt` row to `BAR_ACTIONS` and nothing else
gives a chord that is dead inside the composer - which is the case decision 3 is
specifically about. An explicit bypass above `:1554` is required.

**The board overview drills in unless told otherwise.** `App.tsx:1843-1863` opens the
drill-in for any `BAR_ACTIONS` chord with no mounted bar, except `cycleMode`, which runs
in place because it is a live control rather than a reveal. Interrupt is a live control
and needs the same arm, or Ctrl+C on a board tile opens a panel instead of stopping the
agent.

**Ordered keycap tests will fail on sight.** `test/keybinding-hints.test.ts:87` asserts
`["s","p","⇧F","q","⌃R","c","k"]` and `:111` asserts `["p","d","⌃R","c","k"]` - exact,
ordered. `:98` pins the label list. These must be updated to match wherever the new
button is drawn.

**Two ordering constraints in the ACTIONS list.** `test/keybindings.test.ts:375` asserts
`complete` is immediately followed by `kill`; `:475` asserts `handoff` is immediately
after `focus`. Do not insert `interrupt` inside either pair.

**Every default chord must be reproducible from a keypress.**
`test/keybindings.test.ts:201-227` builds a `producible` set from `chordFromEvent(...)`
calls and asserts every `ACTIONS` default is in it. Add the `ctrl+c` entry or the test
fails with `interrupt unreachable`.

**BAR_ACTIONS is source-scanned.** `test/board-keyboard-open.test.ts:62` reads `App.tsx`
between `const BAR_ACTIONS` and `export function App` and requires literal `["id",
"method"]` pairs; it also asserts `doesNotMatch(app, /chord === bindings\.send/)`. A
hand-rolled `else if (chord === bindings.interrupt)` in the BAR region is a test failure
by design.

**Every interactive element must be wrapped in `<Tooltip>`.**
`test/tooltip-coverage.test.ts` walks every `.tsx` under `src/web` with the TypeScript AST
and has no allowlist. It also forbids the `title` attribute.

**ActionBar buttons carry no `aria-label`.** The accessible name is the visible text plus
the `<kbd>` keycap inside the button, so e2e selects with a regex:
`card.getByRole("button", { name: /interrupt/i })`.

**The capability record is triple-policed.** `harness-capabilities.test.ts:102` requires
every `AgentType` to answer every slot; `:110` requires
`HARNESSES[a].<cap> === capabilitiesFor(a).<cap>` for split slots; `:155` requires each
nullable slot to have a real null declarer or a named `withCapabilityNull` fixture, and
fails if those two lists drift. `harness-sdk.test.ts` is the model for the
one-fact-two-files agreement test.

**The e2e fakes can hold a turn open.** `e2e/specs/queued-turn-recall.spec.ts:33-35` uses
the literal prompt `"hold the current turn open"`, which `e2e/fixtures/fake-claude.mjs`
holds for five seconds. That is the hook for an interrupt spec: something must be running
to interrupt.

## Implementation steps

### 1. Capability slot

In `src/shared/harness-capabilities.ts`, add an `InterruptSpec` and the slot on
`HarnessCapabilities`. Model the doc comment on the existing slots - say why the browser
asks it and what null means.

The slot answers a runtime question, because that is what the card needs to know:

```ts
export interface InterruptSpec {
  /** Runtimes on which this harness's current turn can be stopped. */
  runtimes: readonly SessionRuntime[];
}
```

Declare `claude` and `codex` as `{ runtimes: ["sdk"] }` and `pi` as `null` (no driver, and
the pane path does not exist yet). Pi being a real null declarer keeps the slot off the
`BY_FIXTURE` list in `harness-capabilities.test.ts:155`.

Add the mirrored field to `Harness` in `src/server/harness/types.ts` and to each entry in
`src/server/harness/index.ts` if the split-slot assertion at `harness-capabilities.test.ts:110`
covers it, and extend that assertion. Add a `canInterrupt(agent, runtime)` predicate beside
`harnessOffersRuntime` (`harness-capabilities.ts:724`) so the browser and the daemon ask
one function rather than two.

Write the agreement test in the shape of `harness-sdk.test.ts`: a harness that declares
the `sdk` runtime interruptible must have a driver, and the null path must be exercised.

### 2. Supervisor control

In `src/server/sdk/supervisor.ts`, add `interrupt(id): Promise<boolean>` beside
`clearContext` and `requestStop`. Follow `stop()`, not `send()`:

- read `this.handles.get(id)` directly; **do not** wrap in `serialize()`;
- return `false` when there is no handle (the caller reports that), `true` when the
  driver accepted;
- do not touch `unfinishedTurns`, `acceptingTurns`, or `setSdkSessionTurnInProgress`;
- log the interrupt receipt if the driver surfaces one, per the finding above.

Document in the method comment why it is unqueued and why it writes no bookkeeping -
both are the kind of decision a later reader would otherwise "fix".

### 3. Runtime fan-out and queue drop

Add one helper beside `injectPromptForRuntime` in `src/server/sdk/deliver.ts` (or
`sdk/control.ts` if that reads better - the contract is that exactly one exists):

```ts
export async function interruptForRuntime(
  supervisor: SdkSupervisor | undefined,
  session: Session,
): Promise<ActionResult>
```

- `runtime === "sdk"` → `supervisor.interrupt(session.id)`.
- `runtime === "terminal"` → return a refusal naming the runtime. **Phase 2 replaces only
  this arm.**

Dropping the outbox is runtime-independent and belongs here or in the route, whichever
keeps one owner. Use `PendingTurnManager`; `recall` (`pending-turns.ts:260`) is per-turn,
so either loop the session's queued rows or add a bulk method beside it. Drop only rows in
the `queued` state - a row already `sending` has left, and one marked `uncertain` is
carrying information the operator needs.

### 4. Route

`POST /api/sessions/:id/interrupt` in `src/server/routes.ts`, modeled on `/kill`
(`:2581`): no request body, same session lookup and 404, returning the `ActionResult`
envelope. Reach the supervisor through the existing `sdkSessions` route-factory parameter.
Refuse with a named reason when `canInterrupt` says the harness/runtime pair cannot.

### 5. API client

One line in `src/web/lib/api.ts` beside `kill` (`:883`):

```ts
interrupt: (id: string) => post(`/api/sessions/${encodeURIComponent(id)}/interrupt`),
```

### 6. Keybinding registry

In `src/web/lib/keybindings.ts`: add `"interrupt"` to `ActionId` and one `ACTIONS` entry
with `defaultBinding: "ctrl+c"`, `group: "selection"`. Place it near `kill` but **not**
between `complete` and `kill`, and not between `focus` and `handoff`. The id is the
persistence key - pick it once.

Then add the `ctrl+c` case to the `producible` set in `test/keybindings.test.ts:201-227`.

### 7. App wiring

Three separate edits in `src/web/App.tsx`:

1. **`BAR_ACTIONS` row** (`:109`): `["interrupt", "requestInterrupt"]`. Required to be a
   literal row by the source scan.
2. **Composer bypass above `:1554`.** Interrupt is the second action allowed to fire while
   typing. Gate it exactly as the palette does - on `chordHasCommandModifier(bindings.interrupt)`,
   so a rebinding to a bare key falls back behind the guard - and additionally require that
   there is no live text selection, which is decision 2. Put the selection check in a pure
   helper next to `shouldRecallPendingTurn` in `src/web/lib/pending-turns.ts` (or a sibling
   module) so it is unit-testable without a DOM, following that function's flat-record shape.
3. **Board-overview in-place arm** at `:1855`, beside `cycleMode`: run the interrupt against
   the overview selection rather than opening the drill-in, and swallow the key either way so
   the board keeps its cursor.

Also extend the hand-written command-bar action union at `App.tsx:2773` if the command bar
should offer interrupt.

### 8. ActionBar

In `src/web/components/ActionBar.tsx`:

- add `requestInterrupt: () => void` to `ActionBarHandle` (`:27`);
- implement it through `run("interrupt", () => api.interrupt(session.id))` - **no confirm
  modal**. Kill confirms because it is destructive and irreversible; interrupt is neither,
  and a dialog between the operator and a stop they want immediately defeats the feature.
  Follow `focusPane` (`:264`), not `requestKill`;
- on success, drive the transient presentation and focus the composer (decision 3);
- register the method in the `handle` object and both `latest` literals;
- render the button in both the card and foot variants, wrapped in `<Tooltip>` with a label
  that embeds `formatChord(bindings.interrupt)` the way `killLabel` (`:177`) does, and
  prefixed with `<Keycap action="interrupt" />`;
- disable it when the session is not interruptible - either the harness/runtime pair says no
  (Phase 2's lever) or the agent is not active (`agentActive`, `src/shared/session.ts:58`) -
  and put the reason in the tooltip rather than hiding the control.

Place it next to Kill in both variants, then update the ordered assertions in
`test/keybinding-hints.test.ts:87`, `:98`, `:111` and the label loop in
`test/action-bar-controls.test.ts:62` to match the position chosen.

### 9. Transient presentation

Client-side only. Hold the interrupting session id in React state with a timeout, clear it
on the next `session_upsert` that reports the session no longer working, and render it
through the existing tone vocabulary in `src/web/lib/format.ts` (`stateDisplay`). Do not
add a `SessionState` member and do not add a `Session` field - either would pull in
`sessionEqual` and the `session-contracts.test.ts` compile probes for no user-visible gain.

### 10. Documentation

- `docs/ui.md`: add the chord to the shortcut table, and add the new control to the
  "Keycaps on the buttons" enumeration (`:649`), which names every control that prints its
  chord.
- `docs/sessions.md`: describe interrupt beside the existing session controls, and state
  plainly that it stops the turn without ending the session - the distinction from Kill is
  the whole point.

## Tests and verification

**Unit (`test/`), all `node:test` + `node:assert/strict`:**

- supervisor: interrupt reaches the driver; returns `false` with no handle; is **not**
  queued behind an in-flight `send`; and - the important one - after a driver emits
  `turn_done` following an interrupt, `unfinishedTurns` and `turn_in_progress` are clear,
  proving the self-reconciliation the phase depends on. Extend `test/sdk-supervisor.test.ts`.
- route: 404 for an unknown session; refusal with a reason for a non-interruptible
  harness/runtime pair; success shape for an SDK session. Follow `test/kill.test.ts`.
- queue: interrupt drops `queued` rows and leaves `sending` / `uncertain` rows alone.
  Extend `test/pending-turn-manager.test.ts`.
- capability: the new agreement test, plus the updates to
  `test/harness-capabilities.test.ts` for the added slot.
- the selection-yield predicate, as a pure function with no DOM.
- updates to `test/keybindings.test.ts`, `test/keybinding-hints.test.ts`,
  `test/action-bar-controls.test.ts`, `test/board-keyboard-open.test.ts`.

**End to end (`e2e/`), required by the project rules:** a new spec that dispatches a
session, sends the fake's five-second holding prompt (`"hold the current turn open"`, see
`e2e/fixtures/fake-claude.mjs`), confirms the card is working, presses <kbd>Ctrl</kbd><kbd>C</kbd>,
and asserts the card leaves the working state well before the fake would have finished,
that no queued turn survives, and that the composer holds focus. Select by role and
accessible name; add no `data-testid`; spend no model tokens.

**Commands:** `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build` and
`npm run test:e2e`.

## Merge and exit criteria

- A working SDK session stops on Ctrl+C, from the card, from the board overview, and from
  inside the composer, and the composer holds focus afterwards.
- Queued turns are gone; `sending` and `uncertain` rows are untouched.
- `sdk_sessions.turn_in_progress` is clear after the interrupt, so a daemon restart does
  not re-drive the cancelled turn.
- A terminal-runtime card shows the control disabled with a reason - not hidden, not
  enabled-and-broken.
- Copying selected text with Ctrl+C still works.
- All commands above pass; the new e2e spec passes.

## Downstream handoff

Phase 2 may rely on:

- `HarnessCapabilities.interrupt: InterruptSpec | null` and `canInterrupt(agent, runtime)`;
- `POST /api/sessions/:id/interrupt` with no body and an `ActionResult` envelope;
- the single `interruptForRuntime` helper, whose terminal arm is Phase 2's only server-side
  edit point;
- the `interrupt` action id, its `ctrl+c` default, the `BAR_ACTIONS` row, the composer
  bypass, the board arm, and `ActionBarHandle.requestInterrupt`;
- the queue-drop behavior, which is runtime-independent and already applies to terminal
  sessions;
- the transient presentation.

Phase 2 must not reshape the capability, add a second route or a request body, add an
`ActionId`, or add a `SessionState` member. It changes declarations and one function body.

## Cross-phase audit record

- **Capability null path.** Pi declares `interrupt: null` here, which is what keeps the
  slot off `BY_FIXTURE` in `harness-capabilities.test.ts:155`. If Phase 2 gives pi a
  terminal interrupt, that test flips: the slot loses its last real null declarer and must
  move onto the fixture list. Flagged in Phase 2.
- **Queue drop ownership.** Placed here rather than split across phases because it is
  runtime-independent. Phase 2 inherits it and adds nothing.
- **Terminal arm.** Deliberately written as a refusal rather than omitted, so Phase 2 has
  exactly one function body to replace and the route contract does not move.
