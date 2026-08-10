# Session files: preview, edit, and autosave

## Decision

Use the **Files tab from Mockup 1 as the default session surface**, then let the operator
click an extract arrow to promote the same workspace into **Mockup 2's large overlay**.
The extracted surface is an in-app window: draggable, resizable, and maximizable within
Mission Control. It is not a second Electron `BrowserWindow`, because an in-app overlay
keeps browser/Electron parity, reuses `Overlay`, and avoids a new cross-window state channel.

Replace the read-only Source view with a **syntax-highlighted editor for every UTF-8 text
file**, backed by autosave. HTML and Markdown files have Preview / Editor modes and default
to Preview; other text files open directly in Editor. Binary and oversized files are listed
but cannot be opened in V1.

The revised feature is about **5-7 engineering days**. The original HTML-only, read-only
viewer was 2-3 days; general editing, autosave, atomic writes, and concurrent-edit conflict
handling add most of the new cost.

## Implementation status

The initial workspace was implemented on 2026-07-21; transcript links and expanded previews
were added on 2026-07-22.

- Added bounded git-backed file discovery, contained UTF-8 reads, binary/oversize states,
  revisioned saves, conflict responses, and same-directory atomic replacement.
- Added the Console/Board Files tab, Cards ActionBar entry, shared session buffer controller,
  CodeMirror language loading, inert HTML preview, and extracted draggable/maximizable overlay.
- Added visible autosave/offline/failure/conflict recovery and reset/session-removal cleanup.
- Added session-aware transcript file links, Markdown preview, checkout-local HTML stylesheet
  inlining, and explicit failures for invalid or stale file links.
- The original 2026-07-21 implementation was verified with TypeScript, the full production
  build, and the then-current 2,563-test suite; its dashboard was also opened from the local
  Vite build in Chrome for review.

The remaining Manual checklist below is hands-on acceptance coverage, especially Electron
visual behavior, IME, and a live simultaneous agent edit; it is not unimplemented feature scope.

Review the selected-direction mockup:

- `docs/archive/mockups/html-viewer/04-hybrid-editor.html`

The earlier placement studies remain useful context:

- `01-session-tab.html` - integrated tab
- `02-fullscreen-overlay.html` - extracted overlay
- `03-preview-drawer.html` - rejected as the default because it compresses the conversation

## User experience

### Integrated Files tab

Console and Board detail gain a `Files` tab beside Conversation, Work queue, Gate, and Diff.
Its left rail searches the session checkout's tracked and untracked, non-ignored files. The
right side is the file workspace:

- HTML and Markdown: `Preview` and `Editor` modes, defaulting to Preview.
- Any supported text file: `Editor` mode, with syntax chosen from filename/extension and a
  plain-text fallback.
- Binary, invalid UTF-8, or oversized file: metadata and an honest unavailable message.
- Toolbar: path, language, size, save state, refresh, and extract arrow.

The selected file and mode survive ordinary tab changes. An editor buffer also survives a
temporary unmount while it is dirty, saving, or conflicted; App owns that session-scoped
workspace state rather than the tab component.

### Extracted window

The toolbar's `↗` button opens the same session/file in a registered `Overlay`:

- Start at the last non-maximized size, centered.
- Drag only by the header; never begin a drag from buttons, inputs, or the editor.
- Resize from visible edges/corners with minimum dimensions.
- `□` maximizes to the Mission Control viewport; the restore button returns to the previous
  rectangle. Double-clicking the header toggles the same state.
- Escape closes the extracted window and returns to the integrated Files tab without losing
  selection or unsaved/conflicted content.
- On narrow windows, skip freeform geometry and open maximized.

Cards layout cannot host the ConsoleDetail tab. Its shared ActionBar gets a `Files` action
that opens the extracted window directly. This gives Cards, Console, and Board a complete
file affordance without creating a card-sized editor variant.

Formatted transcript links that resolve inside the emitting session's checkout reuse that
same workspace. Console and Board select the session and reveal its integrated Files tab;
Cards open the extracted Files window. Relative paths and absolute paths beneath the session
`cwd` are accepted, with optional `:line[:column]` or `#LlineCcolumn` locations. The location
is advisory and does not prevent the file from opening. URL schemes, dashboard routes,
checkout escapes, and absolute paths from other checkouts are not claimed, so external links
retain their existing browser behavior. Every read still passes through the daemon's canonical
containment check. A missing, invalid, or stale target replaces the loading state with its
read error while any unsaved local buffer is preserved.

### Syntax-highlighted editor

Use **CodeMirror 6**, not the existing `rehype-highlight` pipeline. That pipeline renders
static Markdown code blocks and has no editable document, selection, undo history, IME
handling, or accessible editor behavior. CodeMirror supplies those editor contracts while
remaining smaller and easier to embed than Monaco's worker-based IDE surface.

V1 editor behavior:

- Line numbers, active-line highlight, bracket matching, code folding, find, undo/redo,
  indentation, and horizontal scrolling for long lines.
- Language detection by basename/extension, using CodeMirror language packages, with plain
  text as the fallback. Unknown text files stay editable; they do not fail because the
  highlighter does not know their grammar.
- Match the existing Mission Control light/dark palette instead of importing a foreign theme.
- Preserve the file's newline style and final-newline state. V1 decodes and writes UTF-8 only;
  it does not guess legacy encodings.
- Browser spellcheck off for code. Tab remains an editor command while focused; global
  Mission Control shortcuts stand down because the target is content-editable.
- HTML and Markdown Preview update from the local buffer after a short render debounce, even
  before the save finishes. HTML keeps the same inert iframe sandbox and restrictive CSP, so
  editing does not turn preview into code execution.

## Autosave contract

Autosave is visible state, not a fire-and-forget request:

`Saved` → `Modified` → `Saving…` → `Saved`, with `Offline`, `Read only`, `Save failed`, and
`Conflict` as distinct states. Save after roughly 750 ms of inactivity and flush on blur,
file switch, extract/restore, and overlay close. Only one save per file may be in flight;
new keystrokes during a save schedule another save against the returned revision.

### Concurrent edits

The agent and operator may edit the same file at the same time. Every read returns a content
revision (SHA-256 of the exact bytes). Every save sends `expectedRevision` plus the new text.
The daemon reads the current bytes immediately before writing:

- Revision matches: write atomically and return the new revision.
- Revision differs: return `409 Conflict` with the current revision and current text if it is
  still within the editor read cap. Autosave pauses for that file.

The conflict UI keeps the local buffer intact and offers:

- **Compare** - show local versus disk in the existing diff vocabulary.
- **Reload disk** - discard local edits only after confirmation.
- **Overwrite disk** - explicit, confirmed save against the newly returned revision.
- **Copy local text** - a recovery path before either destructive choice.

There is deliberately no automatic merge in V1. A line merge can appear safe while changing
syntax or semantics, and this feature has no language server to validate the result.

```mermaid
sequenceDiagram
  participant U as Operator / CodeMirror
  participant W as File workspace
  participant D as Loopback daemon
  participant F as Session checkout
  U->>W: edit buffer
  W->>W: debounce 750 ms
  W->>D: PUT path, text, expectedRevision
  D->>F: read current bytes and hash
  alt revision matches
    D->>F: atomic temp write + rename
    D-->>W: 200 newRevision
    W-->>U: Saved
  else file changed externally
    D-->>W: 409 currentRevision + disk text
    W-->>U: Conflict; autosave paused
  end
```

## Server boundary

### File discovery and reading

Add `src/server/session-files.ts` with one canonical path resolver shared by list, read,
preview, and write operations.

- Root every operation in the live session's `cwd`; never accept a client-supplied root.
- Resolve the root and candidate with `realpath`, then use separator-aware containment to
  reject `..` and symlink escapes.
- Discover with `git ls-files --cached --others --exclude-standard`, bounded and sorted. This
  includes ordinary untracked artifacts without crawling `node_modules` and caches. A manual
  repo-relative path can reach a known ignored file.
- List regular files, not only HTML. Classification happens on open: a UTF-8 fatal decode and
  NUL-byte check distinguishes editable text from binary without relying on extensions.
- Proposed caps: 2,000 discovered entries, 5 MiB read-only HTML or Markdown preview, and 2 MiB
  editable text. Caps are constants exported for tests; refusals are explicit, never truncation.
- Reads return repo-relative path, text, byte size, mtime, detected language, kind, and
  SHA-256 revision. Never return an absolute filesystem path.

Read-only routes:

- `GET /api/sessions/:id/files`
- `GET /api/sessions/:id/file?path=<repo-relative>`

Validate the query with zod in `src/shared/protocol.ts`.

### Atomic writes

Add a mutating route:

- `PUT /api/sessions/:id/file`
- Body: `{ path, text, expectedRevision }`

Per the mutating-route contract, define `SaveSessionFileSchema` in
`src/shared/protocol.ts` and use `parseBody`. The server repeats all read-time path, type,
UTF-8, and size checks; trust no prior browser validation.

On a matching revision:

1. `lstat` the validated target and reject symlinks, non-regular files, or a file that
   disappeared.
2. Create a uniquely named temporary file in the **same directory** with exclusive create.
3. Write the complete UTF-8 buffer, `fsync` it, and apply the original permission bits.
4. Re-read/hash the target immediately before rename; if it changed since validation, remove
   the temporary file and return 409.
5. Rename the temporary file over the target atomically, then return the new revision/mtime.
6. Clean up the temporary file on every failure path.

V1 edits existing files only. Creating, renaming, deleting, changing permissions, following
symlinks, and writing outside the live checkout are separate capabilities.

## Web architecture

### Shared workspace model

Add a `useSessionFiles(sessionId)` controller owned at App/session scope. It owns file list,
selected path, buffers, revisions, save state, conflicts, and refresh. The integrated tab and
extracted window are two presentations of that controller, never two independent editors.

`FileWorkspace.tsx` composes:

- `FileNavigator` - search, selection, file-kind status, manual relative path.
- `FileEditor` - CodeMirror lifecycle and language selection.
- `HtmlPreview` - CSP injection and sandboxed `srcDoc`.
- Markdown preview - the shared inert Markdown renderer used elsewhere in the dashboard.
- `FileConflict` - compare/reload/overwrite recovery.

On session removal, App closes the overlay and drops every buffer for that session. Reset also
drops the file workspace after its server-side checkout reset succeeds; a conflicted/failed
buffer must prompt before either destructive action. This extends the existing reset invariant:
no session-scoped editor state survives a reset.

### Layout and overlay contracts

- Add `files` to `ConsoleDetail`'s tabs; Console and Board get it together.
- Add `onOpenFiles` and session-aware transcript `onOpenFile` routing through
  `SessionViewProps` / `cardProps`; the shared `ActionBar` owns the Cards and extract action.
- Register `files` in `OVERLAY_IDS`; the overlay owns Escape and drag/maximize keys while
  App's global shortcuts stand down.
- App owns `filesSessionId` and the usual "session disappeared" reconciliation.
- Do not add a RailRow glyph, SessionTile flag, or SessionCard chip: editability is an
  affordance, not a changing session-level signal.
- No new keyboard shortcut in V1. Existing pointer and focus behavior reaches all layouts;
  shortcut design can follow observed usage.

## HTML preview security

The preview always renders the current editor buffer through `srcDoc` in
`iframe sandbox=""`. Do not add `allow-scripts`, `allow-forms`, `allow-same-origin`,
`allow-popups`, `allow-top-navigation`, or `allow-downloads`.

Prepend a restrictive CSP meta tag:

- `default-src 'none'`
- `connect-src 'none'`
- `style-src 'unsafe-inline'`
- `img-src data: blob:`
- `font-src data:`
- `form-action 'none'`
- `navigate-to 'none'` where supported

HTML preview supports inline CSS, data/blob images, and a bounded set of checkout-local
stylesheet links. Relative stylesheet paths are resolved against the HTML document, read
through the existing containment-checked session file API, de-duplicated, and inlined before
the document enters the opaque sandbox. Obsolete read batches are cancelled when the preview
changes. Remote stylesheets are neither fetched nor inlined. Other relative assets, scripts,
multi-page navigation, and application preview need a separately isolated preview
origin/process later. Editing support is not a reason to loosen this boundary.

## Failure and lifecycle behavior

- **Daemon disconnected:** keep the local buffer, show Offline, and retry only after the
  existing connection state returns; never report Saved optimistically.
- **Save failed:** retain buffer and revision, show the error, and offer Retry.
- **Session disappeared:** preserve no buffer in module-level storage. If an unsaved buffer is
  on screen, show a recovery copy action before closing when possible; a hard SSE removal still
  drops it because the checkout authority is gone.
- **File deleted externally:** conflict with a deleted-on-disk variant; offer Copy local, Close,
  or explicitly Create as a future capability. V1 cannot recreate it.
- **File changed while previewing:** no filesystem polling or watcher in V1. Manual refresh or
  the next save detects it. A watcher can later emit a `ServerEvent` only if it earns the extra
  daemon/SSE lifecycle complexity.
- **Navigation with dirty buffer:** flush save; if it fails or conflicts, keep that buffer in
  the workspace and mark the file so the operator can return to it.

## Verification

### Server

- Lists tracked/untracked non-ignored files deterministically and respects the entry cap.
- Reads UTF-8 text regardless of extension; rejects NUL, invalid UTF-8, oversized, directory,
  device, absolute, traversal, and symlink-escape targets.
- Read and write use the same canonical resolver.
- Save schema rejects missing/oversized text and malformed revisions.
- Matching revision writes complete content, preserves mode, updates revision, and leaves no
  temporary file.
- Stale revision and the pre-rename race both return 409 without changing the target.
- Failed write/fsync/rename cleans up and preserves the original file.

### Web

- HTML and Markdown default to Preview and retain Editor; other known and unknown text types
  open Editor with syntax/plain fallback.
- CodeMirror language, theme, line numbers, selection, undo, find, and accessibility labels.
- Autosave debounce, blur/file-switch flush, single-flight ordering, retry, offline, and all
  visible save states.
- A stale response cannot mark newer text Saved.
- Conflict compare/reload/overwrite/copy paths preserve the correct buffer and revision.
- Preview reads the local buffer and retains the empty sandbox plus restrictive CSP.
- HTML preview inlines checkout-local stylesheets through contained reads without fetching
  remote CSS or weakening the inline-only CSP.
- Formatted transcript file links preserve external navigation, enforce checkout containment,
  route to the correct layout surface, and settle stale targets as visible errors.
- Extract/restore preserves session, path, mode, buffer, and conflict state.
- Drag ignores interactive descendants, clamps to viewport, restores geometry, and maximizes
  on narrow screens.
- Overlay registry, session disappearance, reset cleanup, and Grid/Console/Board affordance
  parity are pinned.

### Manual

- Edit HTML while previewing; see preview update and disk autosave independently.
- Edit TypeScript, Markdown, CSS, JSON, YAML, shell, extensionless UTF-8, and unknown text.
- Have the agent modify the same file during a local edit; verify conflict, never clobber.
- Kill the daemon during typing and restore it; verify the buffer remains and status is honest.
- Try hostile HTML containing fetch, script, form, navigation, external image, and download.
- Exercise drag, resize, maximize/restore, Escape, focus order, screen reader labels, IME,
  light/dark mode, and narrow widths in both browser and Electron.

## Delivery sequence and effort

| Slice | Effort |
|---|---:|
| Canonical list/read boundary + text classification | 0.75-1 day |
| Revisioned atomic save route + race/failure tests | 1-1.5 days |
| CodeMirror integration, languages, theme, editor lifecycle | 1-1.5 days |
| Autosave controller + conflict/offline recovery | 1-1.5 days |
| Integrated Files tab + extracted draggable/maximized overlay | 0.75-1 day |
| Accessibility, layout parity, manual browser/Electron verification | 0.5 day |
| **Total** | **5-7 days** |

## Follow-ups, not hidden V1 work

- Create, rename, move, and delete files.
- Non-stylesheet relative assets and application preview on an isolated preview origin.
- Filesystem watch events and collaborative live updates.
- Language servers, diagnostics, formatting, completions, or multi-file refactors.
- Native detached Electron windows or moving an editor between OS windows.
- Automatic three-way merge.
