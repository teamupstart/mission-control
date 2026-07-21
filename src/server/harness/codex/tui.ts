import type { DialogSpec, TuiSpec } from "../types.ts";

// How Codex's screen reads.
//
// This spec exists because the previous answer was assumed and wrong. `annotatePaneState`
// filtered to `agent === "claude"`, so in the whole life of the dialog parser it was never
// once pointed at a Codex pane, and a comment asserting Codex "doesn't render these
// dialogs" sat unchallenged above the filter that guaranteed nobody would find out.
//
// Measured against codex-cli 0.144.1 in a live tmux pane: Codex renders the SAME numbered,
// single-cursor menus - a command-approval prompt, a directory-trust check, an update
// prompt. The captures are in `test/fixtures/codex-panes.ts`. Pointed at them, the existing
// grammar returned null on all three; with the cursor glyph below it reads all three
// correctly, including the trust question that wraps across two lines.
//
// The consequence of the old answer was the most user-visible defect in the migration
// investigation. `activePaneDialog` is the ONLY "needs you" evidence that requires no hook
// instrumentation, and Codex had none at all - so a Codex session parked on the approval
// prompt above, which is the most definitively blocked thing on a board, showed as
// "unconfirmed" and was never once surfaced as needing anyone.
//
// Codex reports hooks now, but only where the dashboard launched it: the events are
// per-launch `-c hooks.*` overrides (`codex/launch.ts`), not a global install. So for a
// Codex session an operator started themselves this is still the only evidence there is,
// and the argument above is unchanged for exactly those sessions.

/**
 * U+203A, where Claude uses U+276F. The one token that differs, and the reason a
 * 397-line grammar read as Claude-specific for as long as nobody tried it elsewhere.
 *
 * `form: null` is a separate claim and also measured: every Codex dialog observed is
 * single-select, with no checkboxes, no submit row and no half-filled-form banner. A
 * bracketed row therefore keeps its brackets in the label, which is the same path a Claude
 * permission prompt quoting a `[ ]` already takes.
 */
const CODEX_DIALOG: DialogSpec = { cursor: "›", form: null };

export const codexTui: TuiSpec = {
  // Claude's measurement, kept because it is the value this code has always applied to
  // every pane and this change is not the place to alter a timing. NOT a Codex
  // measurement: nobody has timed its repaint. Erring long costs a walk some latency;
  // erring short confirms a row the cursor has already left.
  repaintTimeoutMs: 900,
  // Codex has no permission-mode concept - no Shift+Tab cycle, and no footer naming a mode -
  // so there is nothing to read and nothing to drive. Null rather than an empty spec: a mode
  // chip must not be invented for an agent that has no modes, and `setPermissionMode` must
  // refuse rather than walk a cycle that does not exist.
  modeLine: null,
  dialog: CODEX_DIALOG,
};
