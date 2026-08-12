# Phase 3 - The conversation: quote it, copy it, both renderings

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)

## Outcome

The conversation window becomes the surface the whole plan was written for. Select a passage
and `Quote in reply` puts it in the composer as a `>` quote with the composer focused. Right-
click a turn and `Copy message` gives you its **source markdown** - something the dashboard
cannot produce today by any means. Code blocks, tool calls, workspace paths and timestamps
each copy the thing they are.

## Entry criteria and dependencies

**Direct dependency: Phase 2.** Consumes `resolveContextActions`, the `ContextTarget` shape,
the tier ordering, the dedupe rule, the capture-phase key contract, and the host's confirmation
surface. Adds registry entries and one attribute per turn; it does not change resolver logic.

Independent of Phase 4 - they touch different components and different registry entries, and
may merge in either order.

## Scope

- `data-turn-id` on both turn markups plus a message lookup.
- Tier 2 *message*: `Copy message` · `Quote in reply` · `Copy from here`.
- Tier 1: `Copy text`, code block (+ a hover copy button), inline code, tool chip, workspace
  path, timestamp.
- Both conversation renderings.
- One `e2e/specs/` spec.

**Non-goals**

- Session card / tile / rail row targets - Phase 4.
- **The path matcher stays transcript-only here** (`a.workspace-path`, `.pty-cwd`, and
  path-shaped tool details). It must **not** match `.card-meta dd.mono`: that is a card
  element, it is `dd.mono.branch` for the branch line, and letting this phase claim it would
  force Phase 4 to reorder a matcher it does not own. Phase 4 adds the card's path and branch
  matchers together.
- Diff and Files - deferred by decision **D3**.

## Repository findings

### The DOM does not carry what the menu needs

This is the finding that shapes the phase, and it disproves a purely DOM-driven registry.

`TranscriptPanel.tsx:1330` renders a turn as:

```tsx
<div className={`turn turn-${m.origin ?? m.role}`}>
```

There is **no identifier in the DOM**. The row's React `key={row.id}` (`:812-860`) never
reaches the document. And the source markdown lives only in React state as `m.text`
(`TranscriptMessage`), while the DOM holds the *rendering* - `<Markdown>` has already consumed
the code fences and link syntax.

So `Copy message` and a faithful `Quote in reply` **cannot be read out of the DOM**. The
mockup's `innerText` is a stand-in and must not ship.

**Therefore:** stamp each turn with `data-turn-id={row.id}` in both markups and register a
lookup from that id to its `TranscriptMessage`. House style already uses `data-episode-marker`
(`:816`), `data-pending-state`, `data-view` and `data-agent`, so this is consistent - and it is
not a `data-testid`, which `AGENTS.md:189` forbids.

### The composer is deliberately uncontrolled

`TranscriptPanel.tsx:921-949`: `defaultValue={readDraft(sessionId, "reply")}` with
`onChange={(e) => writeDraft(sessionId, "reply", e.currentTarget.value)}`, and a comment
stating why:

> Stays uncontrolled - that's why typing here has never re-rendered the log above it, and a
> reply written against a streaming transcript can't afford to start.

**Do not make it controlled.** `Quote in reply` writes imperatively, and there is an exact
precedent to copy - `recall()`'s `restore` callback:

```ts
restore: (text) => {
  input.value = text;
  writeDraft(sessionId, "reply", text);
  input.focus();
  input.setSelectionRange(text.length, text.length);
},
```

Two differences from `recall`: quoting **appends** rather than replaces (`recall` refuses when
`input.value.length > 0`, which is right for recall and wrong here), and it targets the
`"reply"` draft specifically - `src/web/lib/drafts.ts` also has `"send"` and `"queue"` boxes on
the same session.

### Two renderings, and two states with no anchors

`ConversationViewToggle` switches between the chat markup (`.turn` / `.turn-role` /
`.turn-text`) and the terminal one (`.pty-entry` / `.pty-speaker` / `.pty-command` /
`.pty-copy`). `TerminalTurn` (`:1430`) draws a user turn as a `.pty-commandline` carrying
`.pty-host`, `.pty-cwd`, `.pty-caret` and `.pty-command`; the agent turn wears
`turn-text pty-copy` deliberately, to inherit the markdown stylesheet.

`TurnProse` (`:1366-1390`) renders **raw text with no `<a>` at all** when `useRichText()` is
off, and again while find is active. URL and path detection must therefore not depend on
anchors existing - Phase 2's caret-based scan already covers this; this phase must simply not
regress it when adding the path matcher.

`turnWho(m, agentLabel)` is the existing display-name helper and is what speaker attribution
should use, so a Foreman turn is not attributed to "you".

## Implementation steps

1. **Stamp the turns.** Add `data-turn-id={row.id}` to `Turn` and `TerminalTurn` at their call
   sites (`:812-860`), and register a lookup for the panel's messages so tier-2 actions can
   resolve an id to its `TranscriptMessage`. Keep the lookup scoped to the mounted panel - two
   cards can be open in different layouts.

2. **Tier 2 - message actions.**
   - `Copy message` - `m.text`, the **source**, not `innerText`.
   - `Quote in reply` - see step 3.
   - `Copy from here` - this turn and every later one, as markdown, with speaker headers.

3. **`Quote in reply`.**
   - Clip the selection Range **to each turn's body**, not to the turn (constraint 14). A drag
     from one turn into the next necessarily crosses the chrome between them - the
     `you 09:16` byline in chat, the `you@mission ~/leaf ❯` prompt in terminal view - and that
     chrome is inside the turn element. Clip to the turn and the quote reads as though the
     agent said "09:16".
   - **One turn quotes plainly; two or more attribute each speaker** (decision **Q3**):
     `> **claude**` / `> **you**` blocks separated by `>`. Use `turnWho`, and strip the
     terminal speaker's `/ stdout` suffix.
   - With no selection, quote the whole turn.
   - Append to the composer through the uncontrolled path above, then focus and place the
     caret at the end.

4. **`Copy text`** (decision **Q1**) - tier 1's plain-selection branch, immediately after
   `Copy`. Payload is the selection with turn chrome stripped, i.e. the clipped bodies joined.
   It appears **only when it would differ** from `Copy`: inside one turn's prose the payloads
   are identical and Phase 2's dedupe drops it. Keep it in tier 1 and out of tier 2 - a link
   menu already spends three tier-1 rows, and a fourth container row would breach the six-item
   cap.

   `Copy` itself stays raw: it must return exactly what ⌘C would, chrome and all, because a
   `Copy` that quietly differs from the system copy is one you cannot trust.

5. **Tier 1 - the rest**, in this registry order:
   - **Tool chip** (`.tool-chip`, `.tool-line`) **before** the path matcher. `Copy tool call`
     always; add `Copy path` / `Copy absolute path` **only when the detail is path-shaped**
     (constraint 10) - `Read e2e/specs/topbar.spec.ts` is, `Bash npx playwright test
     --reporter=line` is not. Reuse `detectPathTokens` / `workspaceFileTarget` from
     `src/web/lib/workspaceLinks.ts`; do not write a second shape rule.
   - **Workspace path** (`a.workspace-path`, `.pty-cwd`) - `Copy path` · `Copy absolute path`
     (join with the session's `cwd`, since `shortenCwd` means the visible path is usually not
     the pasteable one) · `Open in Files`, reusing the existing `onOpenFile` handler.
   - **Code block** (`pre`) - `Copy code`.
   - **Inline code** (`code`) - `Copy code`. Note `rehypeWorkspacePaths` deliberately skips
     inline code, so this does not fight the path matcher.
   - **Timestamp** (`time.conversation-time`) - `Copy timestamp`, the ISO value already in the
     `dateTime` attribute.

6. **Hover copy button on code blocks.** Ships with `Copy code` because a right-click-only
   affordance is not discoverable, and a code block is the most-copied thing in an agent
   transcript. Use `useCopyFeedback` from Phase 1.

7. **Both renderings.** Every matcher above must hit-test the chat and terminal markups, or the
   feature vanishes when the reader flips the toggle.

## Tests and verification

- **`test/context-actions.test.ts`** (extends Phase 2's): tool chip before path; a path-shaped
  tool detail gains path actions and a shell command does not; `Copy text` collapses into
  `Copy` within one turn and appears across turns; the six-item cap still holds on a link
  inside a turn.
- **`test/`** - the quote builder is pure: given turns and a clipped selection, assert single-
  turn quotes carry no speaker header, multi-turn quotes attribute both, every line is `>`
  prefixed, and neither the chat byline nor the shell prompt appears. Cheap, and it is where
  constraint 14 is actually pinned.
- **`e2e/specs/conversation-context-menu.spec.ts`** - follow
  `e2e/specs/conversation-observed-activity.spec.ts`, which is the fullest template: it has a
  reusable `openConversationWithActivity()` and uses the `E2E_OBSERVED_TOOLS` sentinel to
  guarantee tool turns are on screen. There is **no transcript-seeding helper** in this repo -
  a spec drives the fake agent and the real daemon, and the echoed `Mock reply to: <prompt>` is
  the SSE barrier because it is written *after* the tool turns.
  - Cover: select across two turns → `Quote in reply` → assert the composer holds a `>` quote
    with both speakers and no `09:` byline; `Copy message` writes markdown that still has its
    code fence; a tool chip's `Bash` detail offers no `Copy absolute path`.
  - Flip to terminal view (`conversation-terminal-view.spec.ts` shows how) and assert the menu
    is the same and the quote carries no `@mission` prompt.
  - `settled(card)` before right-clicking; `grantPermissions` inside the test; read the
    clipboard back.

Commands: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run build && npm run test:e2e -- e2e/specs/conversation-context-menu.spec.ts`.

## Merge and exit criteria

- `Quote in reply` appends to the composer and focuses it, without making the box controlled.
- `Copy message` yields source markdown with fences intact.
- Multi-turn quotes attribute speakers; no quote carries a byline or a shell prompt.
- Every target works in both renderings, with rich text on and off.
- Unit, typecheck, lint, build, and the new e2e spec green.

## Downstream handoff

- `data-turn-id` and the message lookup are this phase's contract; nothing later should read
  turn content out of the DOM.
- The path matcher is transcript-scoped. Phase 4 owns the card's path and branch matchers and
  must insert `branch` **before** its own path matcher, since a card's branch is
  `dd.mono.branch`.

## Cross-phase audit record

- Authored after Phases 1 and 2. Uses `useCopyFeedback` (1) and `resolveContextActions` (2);
  adds no resolver logic.
- **Reconciled with Phase 2:** `Copy text` was listed in the source plan without a phase; it is
  placed here because turn chrome is a transcript concept, and Phase 2's non-goals were written
  to say so. Its tier-1 placement is unchanged from `plan.md`.
- **Reconciled with Phase 4:** the path matcher was narrowed to exclude `.card-meta dd.mono`
  so that ownership of the card's branch-before-path ordering sits entirely in Phase 4. Without
  this, Phase 4 would have had to reorder a Phase 3 matcher, and the two phases could not merge
  in either order.
