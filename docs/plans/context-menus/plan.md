# Context menus

Right-click anywhere in Mission Control and get the actions that belong to the thing under
the cursor: `Copy` and `Copy URL` on a link, `Copy path` on a file path, `Copy message` and
`Quote in reply` on a transcript turn, `Copy branch` on a session card.

**Mockups: [`mockups.html`](mockups.html)** - open that file in a browser. Every menu in it
is live; right-click the transcript, the card and the diff and the real proposed menu opens
with the real proposed items, and choosing one really writes your clipboard.

**Implementation: [`phased-plan.md`](phased-plan.md)** - the approved design decomposed into
four merge units, with the repository findings that moved it. This document is the *what*;
that one is the *how*, and it supersedes this file wherever investigation disproved an
assumption here (notably constraint 2, which it resolves).

**Section 3 is the one to actually use.** It is a selection playground: drag a selection in a
conversation, right-click it, and a live panel shows what the resolver sees while the real
composer receives what `Quote in reply` produces. Presets set up the awkward selections
(across two turns, inside a code block, part of a link, whitespace only) and a Chat/Terminal
toggle re-renders the same turns into the window's other markup, so you can confirm selection
behaves identically in both.

The mockup is not a drawing. It runs the proposed two-tier resolver, and it is driven
headlessly through **57 assertions** - 22 over the target matrix below, 35 over selection
behaviour - including the negative ones that matter (prose beside a URL must not offer
`Copy URL`; a shell command in a tool chip must not offer `Copy absolute path`; a
whitespace-only selection must not offer `Copy`; `Shift`+right-click must fall through).
Eight of the constraints in this plan exist because they broke that prototype first.

### What selecting text does

| You did this | The menu offers |
| --- | --- |
| Selected a phrase, right-clicked **inside** it | `Copy` *(selection)* · `Copy message` · `Quote in reply` *(selection)* · `Copy from here` |
| Right-clicked **outside** the selection | The selection **clears** first, so no `Copy` - just `Copy message` · `Quote in reply` · `Copy from here`. This is what every browser does, and it is what stops `Copy` writing something the reader did not point at. |
| Selected **across two turns** | `Copy` *(raw, exactly what ⌘C gives)* · `Copy text` *(chrome stripped)* · `Copy message` · `Quote in reply` *(2 turns, attributing each speaker)* · `Copy from here`. A quote that silently merges two voices into one paragraph is a quote that misleads. |
| Selected only whitespace | Treated as no selection. |
| Right-clicked the **composer** | `Cut` · `Copy` · `Paste` · `Paste as quote` - see constraints 11 and 12. |

Quoting clips the Range to each turn's **body** rather than splitting a string, so a
selection that starts mid-sentence in one turn and ends mid-sentence in the next quotes
exactly those two fragments under their own speakers - see constraint 14 for why the body
and not the turn.

`Copy` deliberately does not do that clipping: it returns exactly what the browser would
put on the clipboard for that selection, chrome and all, because a `Copy` that quietly
differs from ⌘C is a `Copy` you cannot trust. **`Copy text` is the cleaned second item**
(decision Q1) - and it costs nothing when it would say nothing, because a selection inside
one turn's prose produces a payload identical to `Copy`'s and the existing dedupe rule drops
it. It appears exactly when it has something to offer: a selection that crossed a turn
boundary.

It lives in tier 1's plain-selection branch rather than tier 2 on purpose. On a link, tier 1
already spends three rows, and a fourth container row would push that menu past the six-item
cap the two-tier rule exists to hold.

## Why this is not a nicety

There is no `onContextMenu` handler anywhere in `src/`. That is not the interesting part.
The interesting part is what the two builds do with the gap:

| Build | Right-click on selected text today |
| --- | --- |
| Browser (`npm run dev`, daemon-served `dist/web`) | Chromium's native menu. Copy works. |
| **Electron desktop app** | **Nothing. No menu appears at all.** |

Electron ships no default context menu; an app has to build one. `src/main/menu.ts` installs
an application menu and `src/main/tray.ts` a tray menu, and neither is a `webContents`
context menu. So in the packaged app there is no Copy, no Paste, and no Copy Link Address on
right-click - only the `editMenu` role's keyboard accelerators. The desktop build is the one
the product is packaged as, and it is the one with no clipboard affordance.

A second gap sits next to it. `window.missionDesktop.openExternal` is exposed in
`src/preload/index.ts:12`, handled in `src/main/index.ts:58`, and typed in
`mission-desktop.d.ts:11` - and **no renderer code calls it**. External links in a transcript
rely on `will-navigate` firing and `src/main/window.ts:103-108` bouncing the navigation back
out to `shell.openExternal`. The app window starts navigating away from the dashboard on
every external link click and is caught on the way out. An explicit `Open link` is the first
real caller of a bridge that already exists.

## Two principles

**1. Actions stack by specificity; they do not replace each other.**

A link inside a message inside a card is three targets at once. The menu resolves the DOM hit
into an ordered target chain and concatenates each target's actions, most specific first.
That is exactly what the request asks for on a URL - `Copy` *and* `Copy URL` - generalized so
it does not have to be special-cased per element.

The chain is capped at **two tiers**: the thing under the cursor, then the container it lives
in. A context menu that grows a section per ancestor is a menu nobody reads. Two tiers keeps
every menu in the design at six items or fewer.

**2. The label names its payload.**

A bare `Copy` that copies something the reader did not choose is worse than no item. So
`Copy` appears only when there is a real selection to copy. With no selection, the item is
named for what it will put on the clipboard: `Copy message`, `Copy code`, `Copy line`,
`Copy branch`. The reader never has to guess, and never has to paste to find out.

**Identical payloads collapse.** Because actions stack, two targets can offer the same string
- a bare autolinked URL has link text equal to its href, so `Copy` and `Copy URL` would be
the same clipboard write. The second one is dropped. On a markdown link where the text reads
"the docs" and the href is a URL, both survive, because both are real choices. This is one
general dedupe rule rather than a special case per target.

## The target registry

One registry, in the house pattern (`harnessFor`, `permissionModeDisplay`, `ACTIONS`), rather
than an `onContextMenu` on each component:

```ts
// src/web/lib/context-actions.ts
export type ContextTarget = {
  match: (el: Element, ctx: ContextInfo) => boolean;
  tier: "item" | "container";
  actions: (el: Element, ctx: ContextInfo) => ContextAction[];
};
```

`TranscriptPanel`, `SessionCard`, `DiffViewer` and the rest gain no right-click code. One
delegated `contextmenu` listener resolves `e.target.closest()` against the registry, and the
menu renders what comes back. Adding a target is one registry entry plus its test.

**They do, however, have to publish an identifier.** The repository disproves a purely
DOM-driven registry: a turn renders as `<div className={\`turn turn-${m.origin ?? m.role}\`}>`
with **no id in the DOM** - the row's `key={row.id}` never reaches the document - and the
source markdown lives only in React state as `m.text`. The DOM carries the *rendering*, whose
code fences and link syntax are already gone. So `Copy message` and `Quote in reply` cannot be
read out of the DOM at all, and the mockup's `innerText` is a stand-in that the shipping
version must not copy.

The resolver therefore takes a **context object** alongside the element: the transcript stamps
each turn with a `data-turn-id` (house style already uses `data-episode-marker`,
`data-pending-state`, `data-view`; this is not a `data-testid`) and registers a lookup from
that id to its `TranscriptMessage`. Tier-2 message actions read the message, not the markup.
That is one attribute and one registration per surface - still no right-click code in the
components, but not zero change either.

**Tier 1 is ordered and first-match-wins**, which is load-bearing rather than incidental: a
card's branch is `dd.mono.branch` and would be claimed by the path matcher, and a tool
chip's detail would be claimed by it too. The order is tool chip, branch, path, and the
tests below pin it. Tier 2 does not need an order - a hit is in exactly one container.

### Tier 1 - the thing under the cursor

| Target | Actions |
| --- | --- |
| External link (`a[href^=http]`, or URL-shaped text) | `Copy` · `Copy URL` · `Open link` |
| Workspace path (`a.workspace-path`, `.card-meta dd.mono`, `.pty-cwd`) | `Copy` · `Copy path` · `Copy absolute path` · `Open in Files` |
| Code block (`pre code`) | `Copy code` |
| Inline code (`code`) | `Copy code` |
| Tool chip (`.tool-chip`, `.tool-line`) | `Copy tool call`, plus `Copy path` · `Copy absolute path` **only when the detail is path-shaped** (constraint 10) |
| Timestamp (`time.conversation-time`) | `Copy timestamp` (ISO, the value already in `dateTime`) |
| Diff line (`.dl-text`) | `Copy line` · `Copy hunk` |
| Commit SHA (`.diff-sha`) | `Copy SHA` |
| Branch (`.branch`, `.tile-branch`, `.pty-branch`) | `Copy branch` |
| Session ref (`.sc-ref`) | `Copy session id` |
| Text field (`textarea`, `input`) | `Cut` · `Copy` · `Paste` · `Paste as quote` |
| Any live selection | `Copy` *(raw)*, plus `Copy text` *(chrome stripped)* when the selection crossed a turn boundary |

### Tier 2 - the container

| Target | Actions |
| --- | --- |
| Message (`.turn`, `.pty-entry`) | `Copy message` · `Quote in reply` · `Copy from here` |
| Session (`.card`, `.tile`, `.rail-row`) | `Open` · `Copy branch` · `Copy checkout path` · `Copy session id` · `Copy PR URL` |
| Task / queue item (`.bl-card`, `.wq-item`) | `Copy title` · `Copy id` |
| Diff file (`.diff-file`) | `Copy file path` · `Copy diff` |

## The ergonomics this buys, beyond Copy

These are the items worth building the menu for. Copy on a link is the entry price.

- **Quote in reply.** Select a passage in a transcript, right-click, `Quote in reply`. The
  text lands in that session's composer as `> …` and the composer takes focus. This is the
  action a reader actually wants when they are pointing at something an agent said, and the
  current answer is drag-select, ⌘C, click the composer, type `> `, paste.
- **Copy message.** The turn's *source* markdown, not the rendered DOM. Today there is no way
  to get it - a drag-select gives you the rendering, with the code fences gone.
- **Copy code.** The single most-copied thing in an agent transcript, and today it is a
  careful drag from the first character to the last without catching the bubble around it. A
  hover copy button on `pre` ships with it, because a right-click-only affordance is not
  discoverable and the menu should not be the only path.
- **Copy absolute path.** `shortenCwd` and `repoLeaf` mean the path a reader can see is
  usually not the path they can paste into a terminal. The menu has the session, so it can
  join the two.
- **Copy PR URL / Open PR** from the card, the tile and the rail row.
- **Paste, in the composer.** In the desktop build there is currently no right-click paste
  anywhere in the app.
- **Copy from here.** This message and everything after it, as markdown. What you want when
  you are filing an issue about a run.

`SessionTile.tsx:27-36` already carries the comment *"Copying a branch name off a tile is a
fair thing to want on a triage board"*, and defends it with `isDragSelection`. This plan is
that instinct, finished.

## Keyboard and accessibility

- **`Shift+F10` and the Menu key** open the same menu at the focused element. Both are
  unbound today. Without this the whole feature is mouse-only.
- Rows are `role="menuitem"` inside `role="menu"`, arrow keys walk, `Enter` invokes, `Escape`
  closes, focus returns to where it came from.
- Selection is never stolen. Opening the menu leaves any existing selection intact, which is
  what makes selection-aware `Copy` honest.

## Cleanups swept in

The copy-to-clipboard story is currently **six** ad-hoc implementations of the same 1600ms
label flip, and four of them are wrong in some way:

- `PersonaEditor.tsx:396` and `ReportPanel.tsx:250` call `navigator.clipboard.writeText`
  directly, bypassing `src/web/lib/clipboard.ts`. That helper exists precisely because the
  Electron renderer needs the `execCommand` fallback, so both are silently unreliable in the
  desktop build - the one this plan is about.
- `FileWorkspace.tsx:466` ("Copy local") gives **no feedback at all**. You cannot tell
  whether it worked.
- `WorkflowRuns.tsx:744-761` and `:1439-1462` arm a bare `setTimeout` with no ref, no
  `clearTimeout` of a prior timer, and **no unmount cleanup** - so rapid clicks stack timers
  and the earliest one clears the label while later ones fire into an unmounted tree.
  `WorkflowLadder.tsx:804-819` is the same feature done correctly, with a ref and cleanup;
  it is the shape the hook should generalize.
- `ReportPanel.tsx:247-256` also swallows every error, so a failed `fetch("/api/report.md")`
  and a blocked clipboard are indistinguishable and produce no UI at all.

One `useCopyFeedback()` hook, backed by `copyText()`, replaces all six and fixes all four.
**This lands as its own PR, before the menu** (decision Q4): it keeps the context-menu diff
reviewable, fixes two silently-unreliable desktop copies immediately, and gives the menu a
helper to build on rather than a seventh hand-rolled flip to match.
`TranscriptPanel`'s existing `showFlash` (line 400) plus the `.action-flash` `role="status"`
span (line 1008) is the mechanism to generalize - it already announces to screen readers.

## Constraints the implementation must answer

1. **`-webkit-app-region: no-drag`.** `styles.css:1438-1470` is an explicit allow-list of
   floating surfaces that must cancel the desktop drag region, and the comment at 1461-1465
   notes every entry was added *after* it broke. A context menu can open at any coordinate,
   including under the titlebar, so it goes in that list on the first commit, not after a bug
   report. Covered by `test/desktop-drag-region.test.ts`.
2. **Escape ordering.** `Overlay.tsx:41-59` owns a registry where only the topmost surface
   handles `Escape`. `OpenInMenu.tsx:86-99` documents why a popover must use
   `stopImmediatePropagation` in the capture phase rather than `stopPropagation`. The menu
   picks one of those two contracts and states which.
3. **Two transcript renderings.** Every transcript entity has a chat markup and a PTY markup
   (`.turn`/`.turn-text` vs `.pty-entry`/`.pty-copy`). Both hit-test, or the feature vanishes
   when the reader flips `ConversationViewToggle`.
4. **No anchors in two states.** `TurnProse` (`TranscriptPanel.tsx:1366-1390`) renders raw
   text with no `<a>` at all when `useRichText()` is off, and again when find is active. So
   URL detection cannot depend on anchors existing: the resolver scans the text node under
   the cursor for a URL as well as checking `closest("a")`. One code path covers rich text,
   plain text and find-active.
5. **`copyText()`, never raw `navigator.clipboard`.**
6. **No `data-testid`.** Selection by role and accessible name, per `AGENTS.md`.

The next four were found by building the mockup and driving it, not by reading code. Each
one broke a working prototype before it was understood.

7. **The caret, not the event target.** `e.target` on a mouse event is always an *element*,
   so a text-node URL scan driven from it finds nothing. The resolver needs
   `document.caretPositionFromPoint(x, y)` (with `caretRangeFromPoint` as the WebKit
   fallback) - and it needs the returned **offset**, not just the node. The first turn in
   the mockup is one text node holding both prose and a URL, so "does this node contain a
   URL" offers `Copy URL` when you right-click the word "CI". The match has to contain the
   caret.
8. **Close on the scroll *input*, not the scroll *event*.** `ModePicker` closes on any
   scroll because a fixed popover cannot track the chip it hangs off. A context menu opens
   at a cursor point and has no anchor to drift from, so the only reason to close is that
   the reader moved the view. Listening to the `scroll` event instead is actively wrong
   here: a scroll dispatched one frame *after* the menu opens closes it immediately, and in
   the product that frame belongs to `.transcript-log` auto-scrolling as a streamed turn
   arrives. The menu would slam shut mid-read through no action of the reader's. Bind
   `wheel` and `touchmove`; leave `scroll` alone.
9. **`focus({ preventScroll: true })` on the first row.** Focusing a row can make the
   browser scroll to reveal it, which - with constraint 8 done wrong - makes the menu close
   itself on open, intermittently, depending on where the cursor was.
10. **A tool chip's detail is a path only when it is shaped like one.** `Read
    e2e/specs/topbar.spec.ts` is; `Bash npx playwright test --reporter=line` is not.
    Claiming every `.tool-chip-detail` as a path offers `Copy absolute path` on a shell
    command. `detectPathTokens` / `workspaceFileTarget` in `workspaceLinks.ts` already own
    this test - use them rather than a second shape rule.
11. **A field's selection is its own.** `window.getSelection()` is empty inside an `<input>`
    or `<textarea>`, so the composer reads `selectionStart`/`selectionEnd` - and captures
    them *before* the menu takes focus, or they are gone. This is the same distinction
    `chordYieldsToSelection` already documents in `keybindings.ts:424-449`.
12. **`Paste` is the one item a DOM menu does worse than an OS menu.** It needs
    `navigator.clipboard.readText()` and therefore the `clipboard-read` permission: already
    granted in the Electron renderer, prompted on first use in a browser tab. The fallback
    must say so rather than silently doing nothing, and point at ⌘V. This is the strongest
    argument for D2's rejected option, and it is worth exactly one item out of the registry.
13. **Dedupe on kind *and* payload.** Keying on payload alone collapses `Paste` and `Paste as
    quote`, which share an empty payload and do different things. Two items that *write the
    same string* collapse; two that merely look alike do not.
14. **Clip a quote to the turn's body, not the turn.** A drag from one turn into the next
    necessarily crosses the chrome between them - the `you 09:16` byline in chat, the
    `you@mission ~/leaf ❯` prompt in terminal view - and that chrome lives inside the turn
    element. Clip to the turn and the quote reads as though the agent said "09:16". The
    reader selected prose; quote the prose.

## Decisions

Resolved 2026-08-12 through a dashboard plan review. All four went to the recommendation.

| # | Question | Decided |
| --- | --- | --- |
| D1 | Does the custom menu replace the browser's native one? | **Custom everywhere; `Shift`+right-click falls through to native.** One menu in both builds, and the Firefox convention keeps View Source and Inspect one modifier away on a tool whose users are developers on localhost. |
| D2 | Native Electron `Menu` over IPC, or one DOM menu? | **One DOM menu for both builds.** The browser build needs it regardless, so the alternative is two implementations of one feature. The diagram in `plan.html` is the argument. |
| D3 | v1 scope | **Transcript + composer + session card / tile / rail row.** Diff and Files are one registry entry each afterwards, with no new plumbing. |
| D4 | Row density | **Dense - label plus a shortcut/payload hint.** Measured in the mockups, the same five rows are 147×196 dense against 250×258 with blurbs; 70% taller flips above the cursor far more often. |

A second review, 2026-08-12, resolved the five questions left open after the mockups were
built and driven.

| # | Question | Decided |
| --- | --- | --- |
| Q1 | Should `Copy` match ⌘C or strip turn chrome? | **Both.** `Copy` matches ⌘C exactly; `Copy text` is a second item with the chrome stripped, shown only when it would differ. Neither path is a compromise, and the dedupe rule already hides the duplicate. |
| Q2 | What should `Paste` do in a browser tab? | **Always show it, attempt the read, fall back honestly.** One menu in both builds; on denial it says so and points at ⌘V rather than failing silently. |
| Q3 | How is a cross-turn selection quoted? | **Attribute each speaker.** `> **claude**` / `> **you**` blocks, so the agent can tell which words were its own. |
| Q4 | Where does the clipboard cleanup land? | **Its own PR, landed first.** Keeps the context-menu diff reviewable, fixes two silently-unreliable desktop copies immediately, and gives the menu a helper to build on. |
| Q5 | Does `Shift+F10` ship in v1? | **Yes.** Without it the feature is mouse-only, which is an accessibility gap rather than a missing shortcut - and both chords are unbound today. |

The follow-up question was answered **"Create phased implementation plan"**, so this document
is now the approved design behind a phased implementation.

## Testing

- **`e2e/specs/`** - required by `AGENTS.md` for any UI change, and the only layer that can
  prove a right-click produced a menu whose item wrote the clipboard. Playwright reads the
  clipboard via `navigator.clipboard.readText()` with permissions granted.
- **`test/context-actions.test.ts`** - the registry is pure: given a target chain, assert the
  action list, the dedupe of identical payloads, and the two-tier cap. Milliseconds per case.
- **`test/desktop-drag-region.test.ts`** - already exists; gains the new pop class.

## Not doing

- Submenus. Two tiers and six items do not need them.
- Right-click drag-select, or any change to selection behavior.
- A context menu on the Electron tray or app menu. Those are separate surfaces with owners.
