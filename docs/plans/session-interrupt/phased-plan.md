# Session interrupt - phased implementation plan

Source plan: [plan.md](plan.md) (rendered: [plan.html](plan.html)). This index turns the
approved design into implementation units that separate agents can execute and merge
safely.

## Incorporated human decisions

Submitted via Mission Control. These are requirements, not open questions:

1. **Scope: both runtimes, SDK first.** Two phases, serial. The SDK path lands and is
   useful on its own; the terminal path follows.
2. **Binding: `ctrl+c`, yielding to an active text selection.** Rebindable like every
   other action.
3. **Follow-through: stop, drop the queued turns, focus the composer.**
4. **Feedback: a transient "interrupting" presentation**, not a new durable
   `SessionState`.

## Investigated findings the phases rely on

Verified against the repository at commit `eee83d2`.

- **Both SDK drivers already implement the primitive.**
  `SdkSessionHandle.interrupt()` (`src/server/harness/types.ts:676`) is implemented at
  `claude/sdk.ts:412` and `codex/sdk.ts:463`. Its only callers today are `stop()` and
  `clearContext()`. Phase 1 exposes what exists rather than writing a driver control.
- **Turn bookkeeping self-reconciles; do not touch it by hand.**
  `unfinishedTurns` and `sdk_sessions.turn_in_progress` are maintained by the event pump
  on `turn_done` (`supervisor.ts:772-777`), and both drivers emit `turn_done` after an
  interrupt (`claude/sdk.ts:849` via the CLI `result` message; `codex/sdk.ts:858` →
  `finishTurn` → `:1083`). A manual decrement in the interrupt control would
  double-count and corrupt restart recovery. Phase 1 pins this with a test instead.
- **Interrupt must bypass the per-session send FIFO.** `send()` serializes
  (`supervisor.ts:298`); an interrupt queued behind the turn it stops is inert. `stop(id)`
  is already documented as deliberately unqueued (`supervisor.ts:472`) - interrupt copies
  `stop`, not `send`.
- **`cancel_queued` is unreachable, and unnecessary.** The pinned Agent SDK (0.3.220)
  declares `interrupt(): Promise<SDKControlInterruptResponse | undefined>` with no
  parameters (`sdk.d.ts:2293`), so the queue-cancelling flag on the wire protocol has no
  API surface. It is moot: Mission Control never builds a driver-side queue - its only
  two send paths are `supervisor.send()` (serialized; mid-turn sends *steer*) and
  `sendWhenIdle()` (idle-only). The queue decision 3 names is the `PendingTurnManager`
  outbox (`src/server/pending-turns.ts`, per-turn `recall` at `:260`).
- **The capability record is exhaustive and its null paths are policed.**
  `harness-capabilities.test.ts:102` requires every `AgentType` to answer every slot;
  `:110` requires `HARNESSES[a].<cap> === capabilitiesFor(a).<cap>` for each split slot;
  `:155` requires every nullable slot to have a real null declarer or a named
  `withCapabilityNull` fixture, and fails if the two lists drift. A new `interrupt` slot
  must satisfy all three, and `harness-sdk.test.ts` is the model for its
  one-fact-two-files agreement test.
- **`HarnessCapabilities` cannot name a terminal `Key`.** It is browser-safe
  (`src/shared/harness-capabilities.ts:338`) and `Key` lives in `src/server/terminal/`.
  The slot carries only what the browser asks; the keystroke lives server-side beside
  `ControlSpec`.
- **The terminal key vocabulary is eight keys with no escape**
  (`src/server/terminal/types.ts:105`). Each backend renders a total `Record<Key, string>`
  and three test files iterate `ALL_KEYS`, so Phase 2's single added key is a
  four-backend change enforced by the compiler.
- **`Escape` is unbindable in the dashboard** (`RESERVED_KEYS`, `keybindings.ts:285`), so
  the chord cannot be Escape even though Escape is the byte written into the pane.
- **The typing guard blocks `BAR_ACTIONS`, so the composer case needs explicit work.**
  `App.tsx:1554` returns on `typing` *above* the `BAR_ACTIONS` dispatch at `:1834`, and the
  `chordHasCommandModifier` bypass at `:1441` serves exactly one action (the palette).
  Adding a `BAR_ACTIONS` row alone gives a chord that is dead inside the composer - which is
  the case decision 3 is about. Phase 1 owns the bypass and the selection check.
- **The board overview drills in unless told otherwise.** `App.tsx:1843-1863` opens the
  drill-in for any `BAR_ACTIONS` chord with no mounted bar, except `cycleMode`. Interrupt is
  a live control like `cycleMode` and needs the same in-place arm.
- **tmux copy-mode refuses writes on purpose, and Escape is the key that exits it.**
  `paneWriteBlock` (`actions.ts:275`) blocks rather than cancels, by a documented decision
  restated in `test/pane-copy-mode.test.ts:31`. Phase 2 keeps the refusal and surfaces it as
  a 409, because an ungated Escape would exit copy-mode instead of reaching the agent.
- **Ghostty cannot express Escape as a CSI** (`via: "csi"` always emits `ESC [ …`), so it
  needs `via: "named"` - and both Ghostty and cmux reject unknown key names, so those two
  spellings must be measured live rather than assumed.
- **Documentation surfaces are explicit lists.** `docs/ui.md` carries the shortcut table
  and a "Keycaps on the buttons" enumeration naming every control that prints its chord;
  a new control has to join both.

## Phases

| Phase | File | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | [phase-1-sdk-interrupt.md](phase-1-sdk-interrupt.md) | Ctrl+C stops a running SDK-runtime agent: capability slot, supervisor control, route, outbox drop, binding with selection yielding, transient presentation, action-bar control. Terminal cards show the control disabled with a reason. | none |
| 2 | [phase-2-terminal-interrupt.md](phase-2-terminal-interrupt.md) | The same gesture on terminal-runtime sessions: `escape` added to the key vocabulary across four backends, a guarded pane writer, and the capability declaration that enables the control. | Phase 1 |

## Dependency graph and merge order

```
Phase 1  ->  Phase 2
```

Serial, with no concurrency groups. Phase 2 consumes the capability slot, the route, the
runtime fan-out helper, the binding, and the presentation - all owned by Phase 1 - and
changes only which mechanism the fan-out selects for a terminal session. Merge order
equals phase order.

Phase 1 deliberately ships a control that is disabled on terminal cards rather than
absent: the disabled state is driven by the capability slot, so Phase 2 turns it on by
declaring the capability rather than by adding UI.

## Cross-phase contracts

Phase 1 fixes these. Phase 2 consumes them and must not change them:

- **Capability slot.** `HarnessCapabilities.interrupt: InterruptSpec | null` in
  `src/shared/harness-capabilities.ts`, carrying the runtimes a harness can be interrupted
  on and nothing more - it cannot name a terminal `Key`. Phase 1 sets the shape and adds
  `canInterrupt(agent, runtime)` beside `harnessOffersRuntime`; Phase 2 widens the
  declarations but does not re-shape the slot. Phase 1 declares `pi: null`, which is the
  slot's real null declarer; Phase 2 flips it onto `BY_FIXTURE` if pi gains the capability.
- **Route.** `POST /api/sessions/:id/interrupt`, no request body, returning the same
  `ActionResult`-shaped envelope the sibling session routes return. Phase 2 does not add
  a second route or a body.
- **Runtime fan-out.** One helper beside `injectPromptForRuntime` in
  `src/server/sdk/deliver.ts` (or `sdk/control.ts`, whichever the implementing agent finds
  the better home - the contract is that there is exactly one). Phase 1 writes both arms;
  the terminal arm returns a "not supported on this runtime" result. Phase 2 replaces the
  body of that arm only.
- **Queue semantics.** Interrupt drops this session's `PendingTurnManager` outbox rows.
  Phase 1 owns that behavior for both runtimes - it is runtime-independent - so Phase 2
  inherits it and adds nothing.
- **Binding and action id.** One `ActionId` (`interrupt`), one `ACTIONS` entry defaulting
  to `ctrl+c`, one `BAR_ACTIONS` pair, one `ActionBarHandle` method. Phase 2 adds none of
  these.
- **Presentation.** The transient interrupting state is client-side, cleared by the next
  `session_upsert` or a timeout. Neither phase adds a member to `SessionState`.

## Final verification strategy

Each phase runs `npm run typecheck`, `npm run lint`, `npm test`, and - because both change
UI - `npm run build` followed by `npm run test:e2e` with a new spec.

The end state is verified when a Ctrl+C on a working session of each runtime returns the
card to idle, leaves no queued turn behind, leaves the composer focused, and leaves
`sdk_sessions.turn_in_progress` clear for the SDK runtime so a daemon restart does not
re-drive the cancelled turn.
