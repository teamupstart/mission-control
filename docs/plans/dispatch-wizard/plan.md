# Guided dispatch

A keyboard-driven pass over the three decisions every dispatch makes anyway, run before the
dispatch form opens, so the form arrives already filled and the cursor is in the task box.

Status: **scoped, not implemented.** The interaction model is chosen -
[**D · Rail + Reveal**](mockups/d-rail-reveal.html), a synthesis of two of the three
explorations. All four mockups are interactive under [`mockups/`](mockups/index.html).

Decisions taken:

| Decision | Answer |
|---|---|
| Interaction model | **D** - C's in-place reveal carrying A's rail as a horizontal strip |
| Repo | **Asked, first**, as a filter over the field that already holds it |
| Shipped default | **On**, with <kbd>⇥</kbd> as the one-key escape to today's form |

## Why

Pressing <kbd>+</kbd> today opens a dialog with eight controls, and for the overwhelming
majority of dispatches five of them are already right. The operator's real decisions are:

1. is this a **ship** or a **scout**,
2. which **harness**,
3. what runs **after work**.

Everything else - repo, model, effort, priority, labels, title, dependencies - is either
inherited, defaulted, or rarely touched. But the form presents all of it at once and in
mouse-reachable form, so the fast path costs a scan of the whole dialog and at least one
pointer trip. The task box is autofocused, which means the crew controls are *behind* a
tab-walk or a click even though they are the ones being changed.

The wizard inverts that: ask the three questions as single keystrokes, then hand over the
form with the answers in place.

## What it does

Four steps, in order:

| Step | Options | Keys |
|---|---|---|
| Repo | all 202 | type to filter, digits to pick; seeded on `readLastDispatchRepo()` so <kbd>↵</kbd> alone takes it |
| Kind | ship, scout | <kbd>p</kbd> / <kbd>t</kbd> - the letter that distinguishes them, since both start with `s` |
| Harness | Claude Code, Codex, Pi | <kbd>c</kbd> / <kbd>x</kbd> / <kbd>i</kbd> |
| After work | dispatch default, None, any active published Workflow | <kbd>d</kbd> / <kbd>n</kbd>, then per-workflow |

The three closed-set steps also take <kbd>↑</kbd><kbd>↓</kbd> + <kbd>↵</kbd> and a position
digit, and print their mnemonic on each option, so nothing has to be memorised to be fast.
Repo is the exception and takes no mnemonics: it is an open filter, so there every letter is
a letter. <kbd>⌫</kbd> steps back (and inside Repo, deletes a character first),
<kbd>⇥</kbd> abandons the guided pass and drops straight into the form with whatever has been
answered so far, <kbd>esc</kbd> cancels the dispatch outright.

A default dispatch is therefore <kbd>+</kbd> <kbd>↵</kbd> <kbd>p</kbd> <kbd>c</kbd>
<kbd>↵</kbd> and you are typing the task.

### The shape: the form is the wizard, the rail is the memory

No new surface. The dispatch modal opens at its usual 640px, everything dims except the
control being asked about, and that control's options float beneath it exactly the way the
app's `::picker(select)` already paints an open dropdown - same 4px offset, same radius, same
shadow. Nothing below reflows, so the form you finish in has been standing in its final
position the whole time.

The one addition is a strip under the header carrying the four steps: answered ones show
their value and are clickable to go back, the current one is lit, pending ones are dim. That
is A's rail, laid on its side because horizontal is what lets the form keep its width and its
field positions. The strip leaves when the pass completes, so the modal ends up in exactly its
normal shape - the last step *is* the existing form, with `repoRoot`, `kind`, `agent` and
`workflowId` set and the task textarea focused by the same `intentRef.current?.focus()` that
already runs on mount (`DispatchModal.tsx:925`). <kbd>⌘↵</kbd> dispatches from there exactly
as it does today.

Because the picker has to be able to leave the panel, `.modal`'s `overflow: hidden` has to
move: corners go onto `.modal-head` and `.modal-foot`, or the picker portals the way
`RepoCombobox` already does. The latter is the established answer and is probably the one to
take, since `RepoCombobox` is also the control the Repo step drives.

### It changes no dispatch semantics

The wizard is a different way to fill `DispatchDraft`, not a second source of truth for what
a dispatch means. In particular the **kind → after-work** rule is the one already documented
in [dispatch and the backlog](../../dispatch-and-backlog.md) and implemented in
`afterWorkForKind` (`DispatchModal.tsx:911-923`): choosing scout moves After work to **None**
and stashes the previous choice, choosing ship hands it back, and a hand-picked Workflow is
never reverted by a later kind switch. The wizard reaches that rule by asking Kind before
After work, so by the time the After-work step is on screen the correct option is already
preselected - and the step says why (*"A scout has no diff, so None is preselected"*) rather
than silently landing on it.

Model and effort are not asked. They stay on the chosen harness's default, which is what
`""` in the draft already means, and both are one control away on the form that follows.

## The toggle

One machine preference, reachable from three places:

- **Settings → Dispatch** - the durable home, and the only one that has to exist.
- **The dispatch modal header** - flipping it off there is how you get today's behavior back
  mid-dispatch, without hunting for Settings.
- **The wizard itself** - same control, same position, so the escape hatch is where you are.

It follows the established `UiConfig` path end to end: a default in `UI_CONFIG_DEFAULTS` and
a field on `UiConfigSchema` (`src/shared/protocol.ts:1724`), a line in `coerce()`
(`src/web/lib/uiCache.ts:87-102` - omitting it means the value silently resets on every cold
paint), a small hook shaped like `useRichText` (`src/web/lib/rich-text.ts:23-29`), and an
entry in `SETTINGS_CONTROLS` (`src/web/lib/settings-search.ts:92`) so it is findable from
⌘K. That last one is enforced: `test/settings-search.test.ts` fails if an indexed anchor
does not render.

No migration, no route, no schema change on the daemon - `app_config` is a KV row and the
server never reads these values.

**It ships on.** The feature is pointless if nobody finds it, and <kbd>⇥</kbd> reaches
today's form in one key. The cost is real and should be stated rather than hidden: this
changes what an existing, heavily-used shortcut does, for everyone, on upgrade. Two things
pay that down - the escape is one key and it is printed on the strip (`⇥ use the form`), and
the toggle is on the modal header, so the person who wants the old behavior back finds it
without knowing the word "guided".

## Where it plugs in

- Open state stays in `App.tsx` (`dispatchOpen`, `:267`). The wizard is a phase of the same
  open, not a second overlay - `OVERLAY_IDS.dispatch` keeps one entry either way, so the
  overlay stand-down at `App.tsx:1522` keeps working and nothing else has to learn about it.
- The draft is the existing `DispatchDraft` (`src/web/lib/task-draft.ts:24-63`), seeded by
  `freshDispatchDraft()` as today. The wizard writes `repoRoot`, `kind`, `agent` and
  `workflowId` and nothing else.
- The Repo step drives the existing `RepoCombobox`, not a second repo picker. It already
  filters, already arrow-navigates, already portals its list above a scrollable ancestor
  (`RepoCombobox.tsx:149-169`). The step contributes the guided header and the seeded
  selection; matching should be on the repo **name**, since every path shares a `/Users/`
  prefix and a path-substring match returns all 202 on the first keystroke.
- Editing an existing backlog task (`editingTaskId`) **never** runs the wizard. Those answers
  already exist; re-asking them would be a quiz, not a shortcut.
- Ensemble mode does not run it either. Its body replaces Crew and After work entirely.
- Option lists come from the registries, not from literals: `AGENT_TYPES` / `AGENT_IDENTITY`
  (`src/shared/agent.ts:41`) for harnesses and their accents, the same
  `workflowSummaries` filter the form uses (`DispatchModal.tsx:831-837`) for workflows.
  Kind is the one gap - `"ship" | "scout"` has no shared tuple today
  (`src/shared/types.ts:1416`) and the form hardcodes both `<option>`s, so the wizard should
  add `TASK_KINDS` rather than hardcode them a third time.

### The one new pattern

Nothing in the app currently maps a bare letter to an option - the two menus and both
pickers handle arrows and Escape only. The established way to take bare keys above the
global handler is `LaunchMenu`'s capture-phase listener with `stopImmediatePropagation`
(`LaunchMenu.tsx:135-164`), and inside a modal it is `Overlay`'s `onKeyDown` prop, which
fires only while topmost and **must be memoised**.

This matters here because <kbd>p</kbd>, <kbd>t</kbd> and <kbd>c</kbd> are all bound in the
global `selection` group (focus pane, terminal, complete). They are safe while the wizard is
up - App stands down whenever any overlay is open - but that is the reason it is safe, and it
should be asserted, not assumed.

## Out of scope

- Model, effort, priority, labels, title and dependency steps. All stay on the form.
- Multi-repo dispatch. **+ Add another repo** stays a form control; the Repo step picks the
  primary and nothing else.
- Any change to what dispatch does once submitted.
- Rebindable wizard mnemonics. They are printed on screen; if they need to be configurable
  that is a second change with its own settings surface.

## Still open

- Whether the strip's answered rungs should be clickable *back* (jump to that step) or only
  informational. D makes them clickable, which is A's behavior and is what makes the strip
  worth its row - but jumping back to Kind mid-pass has to decide what happens to the
  after-work stash, and the honest answer is probably "the same thing the form already does".
- Whether the picker portals (like `RepoCombobox`) or the modal's corners move. Portalling is
  the established pattern; the mockup takes the cheaper route and says so.

## Validation

- A Playwright spec in `e2e/` is required - this is a UI feature, and the whole point of it
  is that a click, a keystroke and a route line up. Cover: each mnemonic lands its value in
  the form; typing in the Repo step filters and <kbd>↵</kbd> alone takes the seeded repo;
  <kbd>⇥</kbd> escapes mid-flight without losing answered steps; <kbd>⌫</kbd> steps back;
  scout preselects None and ship hands the stash back *through the wizard*, alongside the
  existing `e2e/specs/scout-after-work-default.spec.ts`; the toggle off restores today's
  behavior; and editing a backlog task never enters the pass.
- Because it now ships on, one spec should assert the **upgrade path** explicitly: a fresh
  profile presses <kbd>+</kbd>, gets the guided pass, presses <kbd>⇥</kbd>, and lands on a
  form indistinguishable from today's.
- `test/` covers the pure parts: the step machine, and the kind → after-work resolution if it
  moves into a shared helper.
- README and `docs/dispatch-and-backlog.md` describe the new path and the preference.
