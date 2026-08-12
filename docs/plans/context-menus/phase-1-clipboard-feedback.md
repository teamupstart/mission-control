# Phase 1 - One clipboard helper, and the copies that are quietly broken

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)

## Outcome

Every "copy" control in the dashboard goes through one helper that copies, confirms, and
reports failure the same way - and the four that are wrong today stop being wrong. Two of
them are wrong **in the desktop build specifically**, which is the build the whole
context-menu plan exists to fix.

This phase ships no new UI. Its user-visible change is that copies which silently did
nothing now work and say so.

## Entry criteria and dependencies

**Direct dependencies: none.** This is the root of the graph and can start immediately.

It exists as its own phase because of decision **Q4** ("its own PR, landed first"): it touches
six files unrelated to context menus, and mixing a six-file refactor into the feature diff
makes both harder to review.

## Scope

- Add `useCopyFeedback()` to `src/web/lib/clipboard.ts`.
- Migrate all six clipboard call sites to it.
- Fix the four defects listed under *Repository findings*.

**Non-goals**

- No context menu, no registry, no new menu surface. That is Phase 2.
- **Do not unify `showFlash`.** `TranscriptPanel.tsx:400-414` and `ActionBar.tsx:153-168` are
  byte-identical transient-message helpers and are a tempting third target, but they carry
  send/queue/retry outcomes rather than copy outcomes, their durations range 3500-6000ms, and
  folding them in doubles this diff for a different feature. Note it as follow-up; leave it.
- Do not change `copyText()` itself. See the compatibility note below.

## Repository findings

**`copyText` already exists and is correct.** `src/web/lib/clipboard.ts`, signature
`copyText(text, environment?) => Promise<"clipboard" | "fallback">`. It tries
`navigator.clipboard.writeText`, falls back to a hidden readonly `<textarea>` +
`execCommand("copy")`, and **throws** on total failure rather than returning falsy. No call
site currently reads the `"clipboard" | "fallback"` return.

**`test/clipboard.test.ts` pins its internals hard.** The fallback test asserts an exact
ordered call log:

```
["attribute:readonly:", "append", "target:focus", "target:select",
 "range:0:15", "command:copy", "target:remove", "prior:focus"]
```

so `readonly` must still be set before `appendChild`, and the third test asserts the
*original* error propagates. **Layer on top; do not edit `copyText`'s body.**

### The six call sites

| # | Site | Copies | Feedback today |
| --- | --- | --- | --- |
| A | `WorkflowLadder.tsx:804-819` | `workflowFeedbackText(detail)` | **Correct.** Timer in a `useRef`, clears a prior timer, unmount cleanup, resets on `run.id` change. This is the shape to generalize. |
| B | `WorkflowRuns.tsx:744-761` | `workflowFeedbackText(detail)` | Bare `setTimeout`, no ref, **no unmount cleanup** |
| C | `WorkflowRuns.tsx:1439-1462` | `detail.run.id` | Same defects as B |
| D | `PersonaEditor.tsx:395-402` | `draft.guidanceMarkdown` | Raw `navigator.clipboard.writeText`; label `"Copied ✓"` |
| E | `ReportPanel.tsx:247-256` | `await fetch("/api/report.md")` then the text | Raw `writeText`; **swallows every error**; bare global `setTimeout` |
| F | `FileWorkspace.tsx:466` | `buffer.text` | **Nothing at all** |

### The four defects

1. **D and E bypass `copyText`**, so they get no `execCommand` fallback and are unreliable in
   the Electron renderer. `WorkflowRuns.tsx:1796-1811` already carries a comment describing
   exactly this bug being fixed once before - that comment is the precedent for this phase.
2. **B and C leak timers.** No ref, no `clearTimeout` of a prior timer, no unmount cleanup, so
   rapid clicks stack timers and the earliest clears the label while later ones fire into an
   unmounted tree.
3. **E is silent.** A failed `fetch` and a blocked clipboard are indistinguishable and produce
   no UI whatsoever.
4. **F has no feedback**, so you cannot tell whether it worked.

### Shape requirements the sites impose

- **E copies text produced asynchronously** (`fetch` first), so the hook must accept
  `() => string | Promise<string>`, not a `string`.
- **A, B and C flip a label that comes from a descriptor** (`copyFeedbackAction(detail,
  copied)` in `src/web/workflows/run-actions.ts:74-89`), not an inline ternary. The hook must
  return a boolean the caller renders, not a label string.
- **A's copied flag crosses a component boundary**: `WorkflowLadder` is presentational and
  takes `feedbackCopied?: boolean` (line 96). The hook lives in the container; the prop stays.
- **Error routing differs per site** (local error, page-level `setError` + rethrow, editor
  error, silence, nothing), so the hook returns the error rather than rendering it.
- **A resets externally** on `run.id` change, so expose a `reset()`.

### Convention

There is **no `src/web/hooks/` directory**. Two conventions exist: `src/web/useX.ts` for
daemon-backed data hooks, and `src/web/lib/<topic>.ts` for hooks exported beside the non-hook
functions of their topic (`lib/rich-text.ts:23`, `lib/drafts.ts:124`, `lib/interrupting.ts:152`,
`lib/keybindings.ts:657`). **Export `useCopyFeedback` from `src/web/lib/clipboard.ts` itself.**
`lib/interrupting.ts` is the closest prior art for auto-expiring transient state - read its
header comment before writing this one.

## Implementation steps

1. **`src/web/lib/clipboard.ts`** - append the hook. Leave `copyText` untouched.

   ```ts
   export interface CopyFeedback {
     copied: boolean;
     error: string | null;
     copy: (produce: string | (() => string | Promise<string>)) => Promise<void>;
     reset: () => void;
   }
   export function useCopyFeedback(holdMs?: number): CopyFeedback;
   ```

   - Default `holdMs` to **1600**, the duration all six sites already use.
   - Hold the timer in a `useRef`; clear any prior timer before arming; clear on unmount.
     This is `WorkflowLadder.tsx:804-819`'s shape, which is the one that is correct.
   - `copy()` resolves the producer, awaits `copyText`, sets `copied`, arms the timer. On
     throw: `copied = false`, `error = message`. **Do not swallow** - the error is returned
     for the caller to route.
   - `reset()` clears both the flag and any armed timer.

2. **A - `WorkflowLadder.tsx`** - replace the local `feedbackCopied` / `copyReset` /
   `localError` triple with the hook in the container. Keep the presentational component's
   `feedbackCopied?: boolean` prop exactly as it is: `test/workflow-ladder-actions.test.ts:81-84`
   renders it directly and asserts `/>Copied<\/button>/`. Keep the `[run.id]` reset by calling
   `reset()`.

3. **B and C - `WorkflowRuns.tsx`** - replace both inline `try/catch` + `setTimeout` blocks.
   Preserve the deliberate re-throw contract in the host callbacks at `:1785-1793` and
   `:1796-1811` (documented at `:465-472` as what "keeps the `Copied` flip honest").

4. **D - `PersonaEditor.tsx`** - route through the hook, and **normalize the label from
   `"Copied ✓"` to `"Copied"`**. `test/persona-editor-render.test.ts:200` asserts only the
   resting label `"Copy Markdown"`, so the resting label must not change.

5. **E - `ReportPanel.tsx`** - route through the hook with an async producer that fetches
   `/api/report.md`. **Surface the error** - it currently has no error UI at all, so add one
   (a `role="status"`/`role="alert"` line beside the button is enough). Normalize `"Copied ✓"`
   to `"Copied"`.

6. **F - `FileWorkspace.tsx:466`** - route through the hook and give it a label flip like the
   others. This is the site with no existing feedback surface; the button label is the
   cheapest correct answer and matches every sibling.

7. Sweep for any remaining `navigator.clipboard.writeText` in `src/web/` and confirm zero.

## Tests and verification

- `test/clipboard.test.ts` must pass **unchanged**. If it needs editing, `copyText` was
  modified and it should not have been.
- Add `test/copy-feedback.test.ts`: the hook's contract as pure logic where possible - a
  prior timer is cleared before a new one is armed, a rejected `copyText` leaves
  `copied === false` and sets `error`, `reset()` clears both, an async producer is awaited
  before the copy.
- `test/workflow-ladder-actions.test.ts` must pass unchanged (the prop is preserved).
- `test/workflow-runs-render.test.ts` (`:533, :817, :1357`) and
  `test/persona-editor-render.test.ts:200` assert resting labels only - keep them.
- **`e2e/specs/workflow-run-audit.spec.ts` is the regression net and must pass unchanged.**
  `:243-250` clicks Copy, asserts the `"Copied"` label, reads the clipboard back, and asserts
  the resting label returns within 4000ms - so the hold must stay well under that.
  `:253-289` stubs `navigator.clipboard.writeText` to reject and proves the `execCommand`
  fallback still wrote, by reading from a second page in the same context. **Any hook that
  stops calling `copyText` fails this test, which is exactly what it is for.**
- `:215` does `shoot(header, "01-header")`, a visual baseline. Label or spacing changes
  invalidate it - if a label changes, refresh the baseline deliberately and say so in the PR.

Commands: `npm test`, `npm run typecheck`, `npm run lint`, then
`npm run build && npm run test:e2e -- e2e/specs/workflow-run-audit.spec.ts`.

## Merge and exit criteria

- All six sites call `useCopyFeedback`; zero raw `navigator.clipboard.writeText` in `src/web/`.
- `FileWorkspace`'s "Copy local" shows a confirmation; `ReportPanel` shows an error when one
  happens.
- `"Copied"` is the single confirmation label across the app (no `"Copied ✓"`).
- Unit, typecheck, lint, build green; `workflow-run-audit.spec.ts` green.

## Downstream handoff

Phase 2 consumes:

- **`useCopyFeedback()` from `src/web/lib/clipboard.ts`** - the menu's own "Copied"
  confirmation uses it, so the hold duration and the failure behaviour are decided once.
- **The 1600ms hold and the label `"Copied"`** as the app-wide convention.

Later phases must not: change `copyText`'s signature or its call ordering, re-introduce a
hand-rolled copy timer, or reintroduce a `"Copied ✓"` variant.

## Cross-phase audit record

- Initial authoring. No earlier phases to reconcile against.
- Corrects the source plan, which said **seven** ad-hoc implementations and **three** defects;
  the repository has **six** sites and **four** defects. `plan.md` and `plan.html` were updated
  before this file was written.
