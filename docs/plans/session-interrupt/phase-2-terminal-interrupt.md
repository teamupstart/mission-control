# Phase 2 - Terminal runtime Escape path

Source plan: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## Outcome

The gesture Phase 1 shipped starts working on terminal-backed sessions. <kbd>Ctrl</kbd><kbd>C</kbd>
on a working tmux, WezTerm, Ghostty, or cmux session writes `Escape` into its pane, which
is what the Claude, Codex, and Pi TUIs read as "stop this turn".

No new UI, no new route, no new binding. Phase 1 drew the control disabled behind a
capability; this phase declares the capability and fills in the one function body that was
a refusal.

## Entry criteria and dependencies

**Direct prerequisite: Phase 1**, merged. This phase consumes its capability slot, route,
fan-out helper, action id, binding, board arm, and presentation. Starting before Phase 1
merges means building against a slot that does not exist.

## Scope

**In:** `escape` in the terminal key vocabulary; its rendering in all four backends; the
guarded pane writer; the copy-mode policy; the terminal arm of `interruptForRuntime`; the
capability declarations that enable the control; the route's refusal status for a blocked
pane; tests and a Playwright spec on the terminal runtime.

**Out:** everything Phase 1 owns. Do not add an `ActionId`, a second route, a request
body, a `SessionState` member, or a `Session` field. Do not change the queue-drop
behavior - it is runtime-independent and already applies here.

## Repository findings this phase relies on

Verified at commit `eee83d2`.

**Adding one key is a four-backend change, enforced by the compiler.**
`src/server/terminal/types.ts:98-119` derives `Key` from a `KEYS` object literal precisely
so this happens - the comment says "adding one here fails typecheck in each backend until
it says what that key looks like in its own convention". Each backend holds a total
`Record<Key, …>`:

| backend | symbol | line | Escape spelling |
|---|---|---|---|
| tmux | `KEY_NAMES: Record<Key, string>` | `tmux.ts:48` | `"Escape"` |
| wezterm | `KEY_SEQS: Record<Key, string>` | `wezterm.ts:47` | `"\x1b"` |
| ghostty | `KEY_FORMS: Record<Key, …>` | `ghostty.ts:72` | `{ via: "named", name: "escape" }` |
| cmux | `KEY_NAMES: Record<Key, string>` | `cmux.ts:95` | `"escape"` |

**Ghostty cannot express Escape as a CSI.** `via: "csi"` emits exactly `ESC [ <final>`,
so a bare `ESC` (0x1B) has no CSI form. It must go through `via: "named"`, the same
reasoning the `enter` entry already records ("Enter is a bare CR, which has no CSI form;
`send key` is the only way to send one"). Ghostty's named-key table is small and
rejects unknown names with an AppleScript error - `up`, `arrow_up`, and `page_up` were all
measured as rejected. **`"escape"` must be verified against a live Ghostty surface, not
assumed.**

**cmux rejects unknown key names too.** `KEY_NAMES` there documents that tmux's `btab`
spelling is an `Unknown key` error on cmux. `"escape"` needs the same live check.
Encouragingly, `cmux.ts:391` already names the case in passing: "the only reason to send
two keys is that their order is the point (Escape then Enter, an arrow walk through a
menu)".

**The tmux and wezterm renderings must differ.**
`test/terminal-adapters.test.ts:74` asserts exactly that for every key in `ALL_KEYS`.
`"Escape"` vs `"\x1b"` satisfies it.

**Ghostty's test holds a hard-coded expectation map.**
`test/terminal-ghostty.test.ts:95-115` has a local `expected: Record<Key, string>` and
does `script.includes(expected[key]!)`. A new key with no row throws. The other two
`ALL_KEYS` tests (`terminal-adapters`, `cmux-adapter`) are generic and will exercise the
new key automatically.

**`sendKeys` is module-private with 11 existing call sites**, and the closest analogue to
what this phase adds is `injectShiftTab` (`actions.ts:1133`):

```ts
async function injectShiftTab(session: Session): Promise<ActionResult> {
  const pane = bindSession(session);
  if (!pane) return { ok: false, error: NO_HANDLE };
  return sendKeys(pane, ["shift-tab"]);
}
```

wrapped by an exported action that takes the pane lock - `cyclePermissionMode`
(`actions.ts:1208`) is the shape.

**`actions.ts` emits nothing and logs almost nothing.** Recording and broadcast are the
route's job (compare `registry.recordObservedPermissionMode` at `routes.ts:2601`). Keep
the new action pure: a result out, no event.

**A pane-declined refusal is a 409, not a 500.** That is the documented convention for
`/select-option` and `/submit-options` (`routes.ts:2278`): "every way this fails is the
pane declining… a state conflict rather than a server fault".

**Pi records its own interrupt.** `src/server/harness/pi/meta.ts:128` treats
`stopReason: "aborted"` as an interrupt in the transcript. That is a real verification
signal for the pi arm - after an Escape, the transcript tail should show it. Nothing in
the repository states which key produces it, so **pi's interrupt key must be verified
live** before pi declares the capability.

**Pi has no driver arm at all** (`sdk: null`, `tui: null`, `index.ts:184`), so for pi the
pane keystroke is the only possible mechanism.

## The copy-mode decision

This is the one genuine design choice in the phase, and it must be made deliberately
rather than inherited by accident.

`paneWriteBlock` (`actions.ts:275`) refuses any write when tmux reports the pane is in a
mode, because in copy-mode `send-keys` exits 0 and the child receives nothing - reporting
that as success is described as "the one lie this module must never tell". It explicitly
does **not** cancel the mode: "A pane in copy-mode is a PERSON reading their own
scrollback, and yanking them out of it for a background write would be a worse bug than
the wait." `test/pane-copy-mode.test.ts:31` restates it.

An interrupt is different from the background writes that guard was built for - it is a
foreground human act, and the human is right there. That argues for an exemption. It also
happens that `Escape` is the key that *exits* tmux copy-mode, so an ungated interrupt in
copy-mode would pull the operator out of their scrollback and never reach the agent.

**Decision: keep the refusal.** Route the new action through `sendKeys` like every other
keystroke, let `paneWriteBlock` refuse with `paneBlocked: true`, and surface it. Three
reasons:

1. The alternative is not "the interrupt works" - it is "the operator loses their
   scrollback position *and* the agent keeps running", because the Escape is consumed by
   copy-mode. An exemption would buy nothing and cost something.
2. Cancelling copy-mode first is the behavior the existing guard rejects by name, and
   reversing that decision for one caller re-opens it for all of them.
3. The refusal is actionable: the operator leaves copy-mode with `q` and presses again.

So the route returns **409** with the mode named, and the UI says so - "leave copy-mode
(q) to interrupt" rather than a bare failure. Record this decision in the action's doc
comment, because a later reader will otherwise "fix" it.

## Implementation steps

### 1. Verify the two unknown key spellings before writing code

Ghostty and cmux both reject unknown key names, and neither spelling is documented in the
repository. Confirm against a live surface of each that `escape` is accepted and produces
a bare `ESC` byte, the way the existing `KEY_FORMS` values were measured ("verified by
recording raw bytes off a real surface's pty"). If a backend spells it differently, its
map entry follows the measurement, not this document.

Confirm separately that `Escape` interrupts a running turn in each TUI - Claude, Codex,
and Pi. For Pi, the signal is a transcript tail showing `stopReason: "aborted"`. If Pi
turns out to interrupt on a different key, either give the capability a per-harness key
(see step 4) or leave Pi declaring `null` and say so.

### 2. Add the key

`escape: true` in `KEYS` (`src/server/terminal/types.ts:105`). Then fill in the four
backend maps per the table above, and add the `escape` row to the hard-coded `expected`
map in `test/terminal-ghostty.test.ts:95-103`.

### 3. The pane action

In `src/server/actions.ts`, add a private helper beside `injectShiftTab` and an exported
action wrapping it in `withPaneLock` with the shared `PANE_BUSY` refusal, modeled on
`cyclePermissionMode` (`actions.ts:1208`).

Use the **refusing** `withPaneLock`, not `withPaneLockWait`. An interrupt that queues
behind an in-flight write lands after that write's turn has already started, which is a
worse outcome than a clear "busy, try again" - and `withPaneLockWait` is reserved for the
compound reset. Document that choice.

Return the `ActionResult` unchanged, including `paneBlocked`, so the route can distinguish
the copy-mode case. Emit nothing and log nothing.

### 4. Capability declarations

Widen the Phase 1 slot's declarations:

- `claude`: `{ runtimes: ["terminal", "sdk"] }`
- `codex`: `{ runtimes: ["terminal", "sdk"] }`
- `pi`: `{ runtimes: ["terminal"] }`, **only if step 1 verified it**; otherwise leave
  `null` and record why.

If the concrete key ever needs to differ per harness, it belongs on the server-side
`ControlSpec` (`src/server/harness/types.ts:494`) beside `settleMs` and `pastePlaceholder`
- not on the browser-safe capability, which cannot import `Key`. Only introduce that if
step 1 proves a harness needs it; a uniform `Escape` needs no such field.

**Cross-phase consequence:** Phase 1 relies on pi being the real null declarer that keeps
`interrupt` off the `BY_FIXTURE` list in `test/harness-capabilities.test.ts:155`. If pi
gains the capability here, the slot loses its last null declarer and that test fails with
"nothing declares interrupt null - give it a `withCapabilityNull` fixture". Move it onto
`BY_FIXTURE` in the same commit. The test is written to fail rather than drift silently,
which is the intended behavior, not a surprise.

### 5. The fan-out arm

Replace the terminal arm of `interruptForRuntime` (Phase 1's refusal) with a call to the
new action. That is the only server-side edit outside `actions.ts` and the backends.

### 6. Route status

Return **409** when the result carries `paneBlocked`, keeping 500 for real faults, per the
convention at `routes.ts:2278`. No body, no schema, no Foreman gating - the interrupt is
operator-initiated and carries no origin, exactly like `/kill`.

### 7. UI reason text

The control is already drawn and already disabled behind the capability. Two things
change: terminal cards now enable it, and a `paneBlocked` refusal needs a sentence the
operator can act on, naming the mode and the way out.

### 8. Documentation

Update the interrupt paragraphs `docs/sessions.md` and `docs/ui.md` gained in Phase 1 to
say the gesture now works on terminal sessions, what it sends, and what a copy-mode
refusal means.

## Tests and verification

- **Adapters:** the three `ALL_KEYS` tests now cover `escape` (two automatically, Ghostty
  after its `expected` row is added). Assert the tmux rendering is a name and the wezterm
  rendering is the raw byte, which `terminal-adapters.test.ts:74` already enforces by
  requiring them to differ.
- **Action:** Escape reaches `sendKeys` for a bound pane; `NO_HANDLE` with no pane;
  `cannotType` for a backend declaring `write: null`; `PANE_BUSY` under a held lock; and
  the copy-mode case returning `paneBlocked: true` without cancelling the mode. Extend
  `test/pane-copy-mode.test.ts` for that last one - it already owns the policy.
- **Route:** 409 on `paneBlocked`, 500 on a genuine failure.
- **Capability:** the widened declarations, plus the `BY_FIXTURE` move if pi gains it.
- **End to end:** a spec on the terminal runtime mirroring Phase 1's, asserting the card
  leaves the working state. Prove the keystroke actually reached the backend by reading
  the fake multiplexer's recorded argv - the pattern in
  `e2e/specs/continue-in-terminal-mode.spec.ts:65-74`, which exists because the daemon's
  200 does not prove what was sent. Select by role and accessible name, add no
  `data-testid`, spend no model tokens.

**Commands:** `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build` and
`npm run test:e2e`.

## Merge and exit criteria

- A working terminal-backed session of each harness that declares the capability stops on
  Ctrl+C, and the conversation survives.
- The e2e spec proves the byte reached the backend, not merely that the route returned 200.
- A pane in tmux copy-mode refuses with 409 and an actionable sentence, and is **not**
  pulled out of copy-mode.
- Ghostty and cmux key spellings are measured, not assumed, and the measurement is recorded
  in the map's comment the way the existing entries are.
- Pi either declares the capability with a verified key, or declares `null` with a recorded
  reason.
- All commands above pass.

## Downstream handoff

This is the last phase. The end state: one gesture, one route, one capability slot, two
mechanisms. A future backend joins by filling in its `Record<Key, string>` entry - the
compiler asks. A future harness joins by declaring `interrupt` with its runtimes.

Nothing here should be treated as a place to add a second interrupt path. If a harness
ever needs a different key, it goes on `ControlSpec` beside the other keystroke facts.

## Cross-phase audit record

- **Capability null path.** Phase 1 declares `pi: null`, which is what keeps `interrupt`
  off `BY_FIXTURE` in `harness-capabilities.test.ts:155`. This phase may flip that. Step 4
  owns the move; the test fails loudly if it is forgotten, which is the design.
- **Route contract unchanged.** Phase 1 fixed the bodyless route and `ActionResult`
  envelope. This phase adds a status code mapping for a field Phase 1's envelope already
  carries (`paneBlocked` is pre-existing on `ActionResult`, `actions.ts:45`) - not a new
  field, not a new shape.
- **Queue drop not duplicated.** Phase 1 owns it for both runtimes because it is
  runtime-independent. Confirmed nothing here re-implements it.
- **Lock semantics diverge from the SDK arm deliberately.** Phase 1's supervisor interrupt
  bypasses the send FIFO; this phase's pane interrupt refuses under a held pane lock rather
  than pre-empting. Both are the correct local answer - the SDK FIFO holds *our* queued
  sends, which an interrupt should overtake, while the pane lock holds an in-flight
  *keystroke sequence*, which must not be interleaved mid-write. Recorded here because the
  asymmetry looks like an inconsistency until this reason is stated.
