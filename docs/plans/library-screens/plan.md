# Library detail screens: the Rail direction

Personas, Actions and Commands each have a detail screen one level under the Library card wall.
This plan fixes the dead end a person hits when they open one, and rebuilds all three screens on a
single shared grammar.

Mockups for the approved direction and the two it was chosen over:
[`mockups/index.html`](mockups/index.html) - open that page, not the raw markdown.

## The problem

### You cannot get out

Opening a Persona, Action or Command and pressing Escape does nothing, and there is no visible way
back to the Library.

- Escape is **unhandled**, not swallowed. `App.tsx`'s global keydown does its page-shortcut work and
  then returns for any page that is not the fleet, above the entire Escape ladder. No component
  under `src/web/library/`, `PersonaLibrary`, `SessionActionLibrary` or `CommandLibrary` registers
  an Escape handler of its own.
- None of the four authoring surfaces renders a back button, a breadcrumb, or a close control.
  Driving the running dashboard, the only control on the Actions detail that navigates back to
  `#/library` is the topbar **Library** segment - and it is already painted `aria-current`, so it
  reads as the page you are on rather than the way out of it.
- The `w` chord that would return to the Library is blocked by the global typing guard, and the
  CodeMirror pane that dominates the Persona and Action editors is `contenteditable`, so the chord
  is dead in exactly the region that fills the screen.

`SettingsPage` already solves this for its own page with a visible leave control and a page-level
Escape. The Library never got either.

### The screens under the card wall do not match the card wall

- **You pick the same thing twice.** The Library index is a question-led wall of cards. Clicking one
  lands you in a two-pane editor whose left rail lists the same assets you just chose from.
- **Chrome sits above the payload.** On a Persona roughly 330px of banner, title row and a
  five-field metadata block sit above the markdown that is the actual asset.
- **Save is one of four equal-weight text links.** Save, Copy Markdown, Download .md and Duplicate
  render as peers, next to Archive. On a built-in, Save is permanently disabled and Duplicate is the
  only verb that does anything.
- **The three screens disagree with each other.** Personas has import, a state filter and search;
  Actions has a state filter and search; Commands has none of them, and a rail listing four fixed
  slots that can never grow.
- **Nothing says what depends on the asset.** A Persona can be gating a live workflow run while you
  edit its standards, and the screen never mentions it.

## Approved direction: Rail

Reviewed as three approaches across all three screens (Rail, Focus, Sheet). **Rail is approved for
all three**, recorded here as a requirement rather than an option.

| Decision | Selection | Consequence |
| --- | --- | --- |
| Detail-screen shape | **Rail** | Keep the two-pane workbench on all three screens and fix its grammar, rather than replacing it with a centred document (Focus) or an overlay sheet (Sheet) |
| Exit affordance | Persistent rail row + Escape | A `← Library` row pinned above the asset list, carrying `esc` as its own label |
| Escape semantics | Two-step ladder | Inside the editor, Escape leaves the editor; outside it, Escape leaves the page |
| Header actions | One promoted verb + overflow | Save (or Duplicate on a built-in) is promoted; Copy Markdown, Download .md, Re-import and Archive move into an overflow menu |
| Metadata | Property chips | The flat field row becomes chips that open popovers, rendering quiet when inherited and solid when overridden |
| Dependants | "Used by" footer | Each screen names the workflows referencing the open asset |

Rail was chosen because it is the smallest change that fixes the dead end, it preserves reading one
asset while editing another, and it keeps a single grammar across three screens whose payloads have
nothing in common. Focus's centred document buys writing width the Persona editor would enjoy but
strands Commands, which has no document. Sheet makes Escape self-evident but pays for it with a
focus trap, a dismissal-time dirty gate on three paths, and the smallest editing surface of the
three.

## The shared exit contract

All three screens adopt the same exit, and it is the foundation the rest of the work sits on.

- **A `← Library` row** pinned above the asset list in every rail, first in reading order, never
  scrolled away. It carries `esc` as its own label so the keystroke is taught rather than assumed.
- **A page-level Escape ladder** for `#/library/<surface>/<asset>`:
  1. If focus is inside the guidance or prompt editor, Escape leaves the editor and returns focus to
     the surrounding page. It does not navigate.
  2. Otherwise Escape leaves the page for `#/library`.
- The handler stands down when an overlay owns Escape, so a confirm or discard dialog still closes
  itself first and the page stays put.
- Escape routes through the same navigation the rail row uses, so an unsaved draft raises the
  existing "leave with unsaved changes" dialog rather than discarding work.

The naive fix is to copy `SettingsPage`'s handler, and it would be **dead in the pane that fills the
screen**: that handler bails when the event target is inside a `contenteditable`, which is exactly
what CodeMirror's content host is. The ladder above exists to handle that case rather than skip it.

## Screen: Personas

The rail:

- `← Library` row above everything.
- Assets grouped **Built-in** and **Yours**, so the four shipped Personas stop reading as things you
  wrote, with counts on each group head.
- Each row's sub-label is the resolved runner and model, which is what distinguishes two Personas at
  a glance.
- Search stays. Import .md and the archived-state filter move to a rail footer, out of the path
  between the header and the list.

The workspace:

- Title row carries the name, a built-in tag, and a provenance line. **Duplicate to edit** is
  promoted on a built-in; Save is promoted on an editable Persona. Copy Markdown, Download .md,
  Re-import from source and Archive move into an overflow menu.
- The five-field metadata block becomes property chips: provider, model, and read-only chips for the
  effective source and the guidance byte count. Inherited values render quiet, overridden values
  render solid, so what this Persona actually changes is legible without opening anything.
- The guidance editor takes all remaining height.
- A **used by** footer names the workflows referencing this Persona and whether a run is gating on it
  now.

## Screen: Actions

Everything in the Personas rail grammar, plus what is specific to an Action: it is the only Library
asset carrying a machine-checked contract, and the screen has never stated it.

- Rail sub-labels become `skill · completion` rather than a description that repeats the title.
- Property chips hold the required skill and the completion condition.
- A **contract line** under the chips states the same two values as the one sentence they form: what
  the stage sends, what the session must have, and what Mission Control observes before the stage is
  allowed to call it done.
- A completion kind this build cannot prove stays visible and marked, rather than being a disabled
  option inside a closed dropdown.
- A **used by** footer, as above.

## Screen: Commands

Commands keeps the rail for consistency, and its body changes the most, because it has no document
to edit. A slot holds one repository-neutral default argv plus a list of exceptions, and the longest
matching path wins.

- Rail sub-labels carry the resolved default and the override count, so you can see which of the four
  slots has exceptions without opening each one.
- **The default and its overrides become one table** with a header row. The default is pinned at the
  top as the rule it actually is - the one that applies where nothing more specific matches - rather
  than a separately titled section above an unrelated list.
- **The add row is visibly an add row**, not a third entry indistinguishable from the two saved ones.
- **Every rule shows its parsed argv**, not just the default. That readout is where a quoting mistake
  becomes visible, and today it is only offered for one of the three rules on screen.
- The save contract does not change: one compare-and-swap per slot, replacing the default and the
  whole override list together.

## Deliberately not in scope

- No change to what any of these assets **are**: no schema, migration, route, or persisted-identifier
  change. This is the browser surface only.
- No change to the Library index card wall.
- No change to the Workflows authoring surface, which shares the rail CSS but not this work.
- No new server route. "Used by" is derived from catalogs the browser already holds.
- Commands gains no New, no archive, and no user-created slots. There are four, forever.
- No change to command execution, Trust gating, or authorization copy.

## Verification

- Render tests pin the markup shape of each rebuilt rail and workspace.
- **Every screen here is a UI change and needs a Playwright spec in `e2e/`.** The exit contract in
  particular is a browser behaviour: only a real browser can assert that Escape inside CodeMirror
  leaves the editor, that a second Escape lands on `#/library`, and that a dirty draft raises the
  confirm dialog instead of discarding.
- The existing `library.spec.ts` and `library-commands.spec.ts` specs keep passing, extended rather
  than replaced.
- Runtime verification against the built dashboard, with screenshots attached to each phase's pull
  request.

## Record

The three-approach review was presented and decided in session: **Rail, for all three screens**,
with the phased implementation follow-up selected. Because the selection was made directly rather
than through a dashboard decision form, it is recorded here as the approved requirement and carried
into [`phased-plan.md`](phased-plan.md).
