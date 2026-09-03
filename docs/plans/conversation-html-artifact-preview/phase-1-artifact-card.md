# Phase 1 - Artifact card in the conversation

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md) · Mockup:
[`mockup.html`](mockup.html)

## Outcome

A turn that presents an HTML artifact path grows a collapsible card at its foot, previewing
the page in the log in the app's existing sandbox, with a **Comment in Files** action that
lands the reader in the Files tab on that file, rendered, with comment mode already armed.

The value is two-sided: an artifact becomes legible without leaving the conversation, and the
four steps between "an agent wrote a page" and "I can comment on it" collapse to one click.

## Entry criteria and dependencies

- **Direct dependency:** this planning session's pull request, which publishes `plan.md`,
  `plan.html`, `mockup.html`, `phased-plan.md` and this file to the default branch. The task
  is gated on it, so nothing to do here but confirm the files are present when you start.
- No other phase. This is a one-phase plan.
- `npm install`, and `npx playwright install chromium` once per machine for `test:e2e`.

## Scope

1. Detect artifact paths a turn presents, from the turn text plus the checkout listing.
2. Render the card at the foot of the turn, in both the chat and terminal renderings.
3. Preview the file in the app's existing sandbox at the reserved height, lazily.
4. Refusal states for a file that cannot be previewed - too large, not text, gone, or
   refused by containment. A session with no checkout listing is not one of these; it
   renders no cards at all, for the reason given under step 2.
5. The **Comment in Files** intent channel, end to end.
6. Styles, in `src/web/styles.css`.
7. Tests: one `node:test` file for detection, one Playwright spec for the feature.

## Non-goals

- **No markdown or image cards.** `.html` and `.htm` only, even though
  `pathDefaultsToPreview` also claims `.md` and images.
- **No editing from the conversation.** The card is a reader.
- **No block-carry.** Clicking a block *inside the conversation preview* must not author a
  comment; that variant was offered at review and not selected. The comment bridge stays
  inert here - never send it `HTML_PREVIEW_COMMENT_MESSAGE`.
- **No new bridge script, no CSP change, no `allow-same-origin`, no new setting.**
- **No app-wide colour-scheme change.** `nativeTheme.themeSource` is a named follow-up in the
  source plan, not this phase.
- **No fix for `navigate-to`.** Also a named follow-up; leave `PREVIEW_CSP` alone.

## Repository findings

Verified against the tree at `48e0473b`. Where the source plan and the repository disagreed,
the repository won and the plan was corrected before this file was written.

- **`src/web/lib/htmlPreview.ts`** is the single preview boundary: `htmlPreviewSource()`
  builds `<!doctype html>` + CSP meta + two styles + four hashed scripts + the document, and
  `HTML_PREVIEW_SANDBOX` is `"allow-scripts"`. `inlinePreviewStyles(source, path, read)`
  inlines checkout-local `<link rel=stylesheet>`. All reused as they stand.
- **`.transcript-log` carries `max-height: 340px`** (`styles.css:6739`), lifted only by
  `.detail-conv > .transcript .transcript-log { max-height: none }` (`styles.css:24271`).
  This is why the reserved height is context-dependent; see *Reserved height* below.
- **`FileWorkspace.tsx`** finds its own preview frame with
  `workspaceRef.current?.querySelector(".file-content .html-preview")` and then rejects any
  message whose `event.source` is not that frame's `contentWindow` (around line 577). Adding
  a second frame with a different class is therefore safe in that direction; the new handler
  must be equally strict in the other.
- **`enterCommentMode`** (`FileWorkspace.tsx:389`) is a `useCallback` that **early-returns
  when `!commentable`**, and `commentable` derives from `buffer`, which does not exist until
  the file has loaded. An effect that arms comment mode the moment a request arrives will
  therefore do nothing on a cold open. See *The arming order* below - this is the one real
  hazard in the phase.
- **`controller.setMode(session.id, "preview")`** is the supported way to force Preview.
- **`App.tsx`** already carries `fileTabRequest` (line 501) and `fileLineRequest` (line 516),
  both `{ sessionId, …, nonce }`, both threaded through `layouts/types.ts` (line 109) and
  consumed in `ConsoleDetail.tsx` (lines 245, 853). The new channel copies that shape.
- **`openSessionPath`** (`App.tsx:1584`) already does `files.ensure`, `files.select`,
  `setSelectedId`, board-open, and `requestFilesTab`. The comment intent rides beside it.
- **`useWorkspacePaths(files, sessionId, enabled)`** (`sessionFiles.ts:561`) already warms and
  returns the checkout listing for any session with a `cwd`; `TranscriptPanel` already calls
  it (line 232). Detection costs no new fetch.
- **`matchCheckoutPaths(text, paths)`** (`workspaceLinks.ts:329`) returns `PathToken`s with
  `path`, `raw`, `start`, `end` and a split `:line[:column]`. Membership in `paths` decides,
  which is what keeps a nonexistent path from ever becoming a card.
- **Only two layouts exist** (`board`, `console`). An older statement in
  `docs/plans/html-viewer/plan.md` about a Cards layout is stale; do not reintroduce it.
- **`TranscriptPanel.tsx` has two turn renderers**: the chat `Turn` (around line 1488, prose
  in `.turn-text`) and the terminal/PTY turn (around line 1639). Both must host the card, and
  detection must not depend on `richText`, which gates markdown parsing only.
- **Scale, which is why the presentation test matters:** a mission-control checkout holds
  **292** `.html` files. Membership alone is not a sufficient filter.

## Implementation steps

### 1. `src/web/lib/conversationArtifacts.ts` (new, pure, no React, no I/O)

Export one function and its result type:

```ts
export interface ConversationArtifact {
  /** Checkout-relative path, exactly as the session file API takes it. */
  path: string;
}

export function conversationArtifacts(
  text: string,
  paths: ReadonlySet<string>,
): ConversationArtifact[];
```

Rules, in order:

1. Return `[]` fast when `paths.size === 0`, or when the text holds no `.htm` substring
   **case-insensitively** - a listed `report.HTML` must survive the fast path to reach the
   extension test below, which is itself case-insensitive.
2. Find candidates two ways, and **only** these two - this is the approved "presented as an
   artifact" rule:
   - **Own line, optional short label.** A line whose only content is the path, or a
     `Label:` prefix and the path. Match a leading label conservatively (letters and spaces,
     bounded length, then a colon) so `Report: docs/reports/x/report.html` qualifies and a
     sentence that happens to end in a path does not.
   - **Markdown link href.** `](<path>)`, so `[the plan](docs/plans/x/plan.html)` qualifies.
3. Keep only `.html` / `.htm` (case-insensitive).
4. Strip any `:line[:column]` suffix, reusing the same grammar `workspaceLinks.ts` uses
   rather than a second regex.
5. Keep only paths present in `paths`.
6. Deduplicate, preserving first-appearance order.
7. Cap at **3**; drop the rest silently, leaving them as ordinary links.

Prefer reusing `matchCheckoutPaths` for tokenizing and then applying the presentation test to
each token's line, over writing a second path grammar. Two grammars for one concept is the
drift this repository's `rehypeWorkspacePaths` notes warn about.

### 2. `src/web/components/ConversationArtifacts.tsx` (new)

`ConversationArtifacts({ sessionId, artifacts, onCommentInFiles })` renders
`<div className="turn-artifacts">` with one `ArtifactCard` per artifact.

`ArtifactCard` owns:

- **Disclosure state**, defaulting to open (approved). Hold it in this component, keyed by
  `sessionId` + `path`, so a reader's collapse survives re-renders of the turn.
- **Lazy mount.** An `IntersectionObserver` with `rootMargin: "600px 0px"`, copied in shape
  from `MermaidDiagram.tsx`. The frame mounts only when open **and** near the viewport.
- **Fetch on first expand**, via `fetchSessionFile(sessionId, path, signal)`, then
  `inlinePreviewStyles(text, path, (p) => read p through the same api)`. Abort on unmount and
  on path change. Re-fetch on **Refresh**.
- **`srcDoc={htmlPreviewSource(text)}`** and `sandbox={HTML_PREVIEW_SANDBOX}`, imported as
  constants. Do not build either string locally.
- **Header**: disclosure button wrapping name and directory, byte size, **Refresh**, and
  **Comment in Files**. Accessible names: the card is `Preview of <path>`; Refresh is
  `Refresh preview of <path>`; the comment action is `Comment on <path> in Files`.
- **Refusal body**, one sentence plus one explanation, for each of: over
  `MAX_SESSION_PREVIEW_BYTES`, not decodable text, file gone, and containment refusal. The
  header keeps both actions in every refusal state.
- **There is deliberately no "could not be listed" card.** Membership in the checkout listing
  is what makes a path an artifact, so an unavailable listing confirms no candidate and leaves
  nothing to draw a card on. Do not add a shape-based fallback to manufacture one: that
  weakens the membership boundary the whole detection rule rests on. A session whose listing
  fails shows plain text and reaches its files through the Files tab, exactly as
  `rehypeWorkspacePaths` already behaves with an empty listing.
- **Its own `message` listener** for `HTML_PREVIEW_LINK_MESSAGE`, which must compare
  `event.source` against *this card's* frame `contentWindow` before acting, then resolve the
  href with `workspaceAssetPath`, probe it, and open it in Files. A card must never act on the
  Files workspace's messages, or on another card's.

Never send `HTML_PREVIEW_COMMENT_MESSAGE` or `HTML_PREVIEW_FIND_MESSAGE` from here.

### 3. `src/web/components/TranscriptPanel.tsx`

- Compute artifacts per turn with `conversationArtifacts(m.text, filePaths ?? EMPTY)`,
  memoized on the text and the listing. `filePaths` is already in scope.
- Render `<ConversationArtifacts …>` inside the chat `Turn`, after `.turn-text` and after
  `ToolChips`, and inside the PTY turn in the equivalent position.
- Thread one new optional prop for the comment action, in the shape the panel already uses for
  `onOpenFile`: hold it behind a ref and hand down a stable `useCallback`, so the turns stay
  memoized through SSE frames. Read `TranscriptPanel`'s note above `openFile` before doing
  this - the same hazard applies.

### 4. The intent channel

- **`App.tsx`**: add `fileCommentRequest` as `{ sessionId, path, nonce } | null`, shaped like
  `fileLineRequest`. Add a callback that calls `openSessionPath(sessionId, path)` and then
  bumps the request. Pass it into the transcript's new prop and the request into the view.
- **`layouts/types.ts`**: add `fileCommentRequest` beside `fileLineRequest`.
- **`layouts/ConsoleDetail.tsx`**: pass `view.fileCommentRequest` to `FileWorkspace`, beside
  `fileLineRequest`, and include it in the memo comparator the file already maintains.
- **`FileWorkspace.tsx`**: accept the prop, add it to the props comparator, and add one effect
  that honors it - see the ordering rule next.

### 5. The arming order

This is the hazard. `enterCommentMode` early-returns while `!commentable`, and `commentable`
needs `buffer`, which needs the file to have loaded. So the effect cannot simply fire on the
nonce.

Track the last honored nonce in a ref, and let the effect run again as the buffer arrives:

- Guard on `fileCommentRequest.sessionId === session.id` and
  `fileCommentRequest.path === selectedPath`.
- Force `controller.setMode(session.id, "preview")` as soon as the request is seen; that does
  not need a buffer.
- Arm comment mode only once `commentable` is true, then record the nonce as honored so a
  later render does not re-arm after the reader has deliberately turned it off.
- Depend on the request, `selectedPath`, `commentable` and `enterCommentMode`.

Do not reach past `enterCommentMode` to `setCommentMode` - the `commentable` gate is the
thing that keeps comment mode off a file with nothing to comment on.

### 6. `src/web/styles.css`

Add the card styles. The mockup's `PROPOSED` block is the reference and is already written
against the app's tokens; port it rather than reinventing it. Two rules are load-bearing and
were each found by measurement:

- **Reserved height, context-dependent.** The body reserves `420px` and shows its frame only
  inside `.detail-conv`; in the capped session-card log the card renders as its header alone.
  A 420px body in a 340px log puts the disclosure out of reach of its own content.
- **`min-width` on the disclosure.** With `min-width: 0` the disclosure shrinks instead of
  letting the header wrap, and the directory collapses to one character in a narrow column.
  `flex: 1 1 190px; min-width: 150px` wraps instead. This must live *in* the base
  `.artifact-disclose` block, not in a later rule that the base one would override.
- **The mat.** `padding: 7px` on `.artifact-body` over `--panel-2`, with a 1px border and 6px
  radius on the frame, so a light artifact reads as an embedded document.

## Tests and verification

### `test/conversation-artifacts.test.ts` (new, `node:test` + `node:assert/strict`)

Cover the detection rules, which is where the behavior actually lives:

- `Report: docs/reports/x/report.html` on its own line qualifies.
- A bare path on its own line qualifies.
- A Markdown link href qualifies.
- The same path named twice yields **one** artifact.
- A path named only mid-sentence does **not** qualify.
- `docs/reports/<slug>/report.html` - a placeholder in a real task prompt - resolves to
  nothing and yields no artifact.
- A `.md`, `.png` or extensionless path never qualifies.
- A path absent from the listing never qualifies, even in a qualifying position.
- A listed `report.HTML` **does** qualify, so the case-insensitive fast path is pinned
  rather than assumed.
- An empty listing yields `[]` for text that would otherwise qualify, which is the
  listing-failure behavior stated above.
- A `:42` suffix is stripped before the listing lookup.
- More than three qualifying artifacts yields exactly three, in first-appearance order.

### `e2e/specs/conversation-html-artifact-preview.spec.ts` (new)

Per `e2e/README.md`. Fake agents only - no model tokens. No `data-testid`; select by role,
label and placeholder.

1. Dispatch a fake session whose checkout contains a small self-contained HTML artifact, and
   whose final turn ends with the path on its own line after a `Report:` label.
2. Assert the card is present and named `Preview of <path>`, and that its disclosure reports
   `aria-expanded="true"`.
3. Assert the artifact really rendered: reach **into** the frame with Playwright's
   `frameLocator` and read the document's own heading. Do **not** use `contentDocument` - the
   sandbox has no `allow-same-origin`, so the page cannot read into the frame, though
   Playwright can over CDP.
4. Collapse it; assert the body is gone and `aria-expanded="false"`; leave the tab and return
   and assert the choice survived.
5. Click **Comment in Files**; assert the Files tab is showing that file with **Preview**
   pressed and **Comment mode** pressed.
6. Comment on a block from the preview and read the thread back in the rail.
7. Assert a turn that names an `.html` path only mid-sentence has **no** card.

### Commands

```sh
npm run typecheck
npm run lint
node --test --import ./test/setup-state.mjs --import tsx test/conversation-artifacts.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e
```

`test/html-preview.test.ts` must pass **unchanged**; it recomputes every bridge hash, and a
change there means the boundary was edited, which this phase must not do.

### By eye

Look at the running app, not only the diff:

- Both OS colour schemes, on a real skill-written `plan.html`, so the light-artifact case is
  seen rather than trusted.
- The Console reading surface and a Board session card, so the context rule is seen.
- A narrow window, so the header wraps instead of crushing the directory.

## Merge and exit criteria

- Every command above passes, including `test:e2e` with the new spec.
- A turn presenting an artifact shows an expanded card in Console/Board detail, and a header
  only in a session card.
- **Comment in Files** lands on the file, in Preview, with comment mode armed, from both a
  cold open and an already-open Files tab.
- Every refusal state renders its own sentence, with both header actions intact - and a
  session with no checkout listing renders no cards rather than an empty one.
- `src/web/lib/htmlPreview.ts` is unmodified, and `PREVIEW_CSP` is byte-identical.
- One reviewable pull request in `mission-control`, green, with the evidence attached rather
  than committed.

## Downstream handoff

There is no later phase. What a **future** change may rely on:

- `conversationArtifacts(text, paths)` is the one answer to "does this turn present an
  artifact". Extending it to markdown or images means editing that function and its tests, not
  adding a second detector.
- `.artifact-preview` is the conversation frame's class and `.html-preview` remains the Files
  workspace's. Any third preview surface takes a third class and its own `event.source` check.
- The `fileCommentRequest` channel is the way to ask Files to open a path with comment mode
  armed. A future caller (a diff row, a PR comment) should reuse it rather than add a fourth
  channel.

What it must not change without revisiting the source plan: the four hashed bridges and the
CSP, the "presented as an artifact" rule, and the inert comment bridge inside the conversation
preview.

## Cross-phase audit record

- **2026-09-03, initial write.** One-phase plan, so there is no inter-phase contract to
  reconcile. Audited instead against the *source plan* and the *submitted decisions*: all four
  selections are owned by this phase (expanded default, presentation rule, comment-mode arming,
  foot-of-turn placement), and the block-carry variant is explicitly a non-goal because it was
  offered and not selected.
- **2026-09-03, repository reconciliation.** Three statements in the source plan were corrected
  before this file was written rather than carried into it: the self-contradictory reserved
  height (a 240px floor under a 204px cap in the capped log), the missing colour-scheme
  finding, and the missing listing-refusal state. This file inherits the corrected versions.
- **2026-09-03, Inspector round 1-3 reconciliation.** Three comments on the artifacts, all
  three verified against the repository rather than taken on faith. The short-pane height rule
  (`minor`) was already corrected by the mockup's measurements before the comment landed. Two
  were real defects and are fixed here: the promised "could not be listed" refusal card was
  **unreachable by construction**, because detection only emits a card after
  `matchCheckoutPaths` confirms membership, so a failed listing leaves nothing to draw on - the
  state is removed and the honest degradation is stated instead, with an explicit instruction
  not to add a shape-based fallback; and the detection fast path tested for `.htm`
  case-sensitively while the extension rule was case-insensitive, which would have dropped a
  listed `report.HTML`. Neither fix touches an approved decision or the plan's scope.
- **2026-09-03, stale-reference check.** `docs/plans/html-viewer/plan.md` describes a Cards
  layout that no longer exists; recorded here as a stale reference so this phase does not
  implement a third host for the card.
