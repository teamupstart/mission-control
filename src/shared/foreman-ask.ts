import type { PaneDialogSummary } from "./types.ts";

// Reducing one recorded episode to the single line a human reads it by.
//
// This lives in shared, not in the drawer that used to own it, because BOTH sides now
// need the same answer and they must not derive it differently. The per-session drawer
// computes it in the browser from the whole episode it already holds; the fleet-wide
// settings ledger has the daemon compute it once and ship only the result, because the
// input it reduces - a captured terminal screen - is the single largest thing in the
// table and the one thing that must not ride a 4-second poll. Measured on a real
// 631-episode database, `pane` alone was 50.6% of the ledger's payload and the
// drawer-only fields together were 82KB per poll, about 72MB an hour with the Settings
// page open. Two copies of this logic would mean the two surfaces could disagree about
// what a decision was even about; one shared copy is the same argument `@shared/queue.ts`
// and `@shared/cost.ts` make.
//
// Pure string work, no `node:` imports, so the browser bundle and the daemon can both
// take it - the `HARNESS_CAPABILITIES` split.

/** `Claude needs your permission to use Bash` and friends - a header, not a question. */
const PERMISSION_HEADER = /needs your permission to use/i;

/** A numbered option row, as `parsePaneDialog` recognises one. */
const OPTION_ROW = /^\s*❯?\s*(\d{1,2})\.\s+\S/u;

/** Just enough of an episode to say what it was about. */
export interface AskSource {
  pane: string | null;
  menu: PaneDialogSummary | null;
  question: string;
}

/**
 * A one-glance version of the ask.
 *
 * The hard case is a terminal menu, where the three candidate texts are all wrong on
 * their own. `question` is the notification line - "Claude needs your permission to
 * use AskUserQuestion" - which never names what is being approved, and reads
 * identically on every such row. The option rows say what the CHOICES were but not
 * what was being decided. And the pane is a whole screen, mostly scrollback.
 *
 * What a reader actually remembers is the sentence the dialog was built around, so that
 * is what this reaches for (see `panePrompt`). Falling back to the options, then the
 * question, then the pane's tail - the tail rather than the head because the dialog is
 * the foreground and sits at the BOTTOM of a capture (see `parsePaneDialog`).
 */
export function askPreview(e: AskSource): string {
  const prompt = panePrompt(e.pane);
  if (prompt) return prompt;
  if (e.menu && e.menu.options.length > 0) {
    return e.menu.options.map((o) => `${o.number}. ${o.label}`).join("   ");
  }
  const q = e.question.trim();
  if (q) return q;
  const pane = e.pane?.trim();
  if (!pane) return "(no question was recorded)";
  return pane.split("\n").slice(-3).join(" ").trim();
}

/**
 * The longest an ask may be once it crosses the wire to the fleet-wide ledger.
 *
 * The ledger renders it in a single clipped cell, so anything past this is bytes nobody
 * can see. It is generous rather than tight because the same string is the row's tooltip
 * when an episode recorded no purpose - the one place the full sentence is actually read.
 */
export const MAX_ASK_PREVIEW = 300;

/** `askPreview`, clamped for transport. See `MAX_ASK_PREVIEW`. */
export function askPreviewForWire(e: AskSource): string {
  const ask = askPreview(e);
  return ask.length > MAX_ASK_PREVIEW ? `${ask.slice(0, MAX_ASK_PREVIEW - 1)}…` : ask;
}

/**
 * Where the pane's option block begins, or null when it is showing none.
 *
 * Mirrors `parsePaneDialog`: scans UPWARD from the end and takes the first complete
 * block, requiring the numbers to run down to 1 so two unrelated numberings can't be
 * spliced into one. The direction is the whole point - a pane is a full screen and the
 * dialog is the foreground at the BOTTOM of it, so anything numbered above it is
 * scrollback (an earlier menu, or a numbered list in the child's own output).
 */
function dialogTop(lines: string[]): number | null {
  let last: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION_ROW.exec(lines[i]!);
    if (!m) continue;
    const number = Number(m[1]);
    // The next row up must continue the run downward (N, N-1, ...); anything else
    // means this block never reached 1, so restart it here rather than splice.
    if (number !== (last === null ? number : last - 1)) {
      last = null;
      if (number !== 1) continue;
    }
    if (number === 1) return i;
    last = number;
  }
  return null;
}

/**
 * How far above the dialog the walk may reach, in blank-line-separated paragraphs.
 *
 * Four is what the widest real capture needs (a Bash permission prompt: the tool chip,
 * the command, "This command requires approval", "Do you want to proceed?"). A cap is
 * what stops scrollback further up - the child's own output - from being weighed as if
 * it were part of the dialog.
 */
const MAX_PROSE_PARAGRAPHS = 4;

/**
 * The prose a pane's dialog was built around, or null when it showed none.
 *
 * Takes the LONGEST paragraph above the option rows rather than the nearest one. BOTH
 * ends of that region are boilerplate in real captures: a Claude dialog opens with a
 * short chip naming the tool ("Bash command", "☐ Database") and closes with a generic
 * confirmation ("Do you want to proceed?") or a bare affordance label ("Security
 * guide"), and none of those identify the ask. Picking by position gets two of the three
 * verbatim captures in `foreman-pane-dialog.test.ts` wrong whichever end you pick from,
 * so length is the discriminator instead - the substantive line is the one with
 * something to say. Ties keep the paragraph nearest the dialog.
 *
 * Stops at the permission header and drops it: "Claude needs your permission to use
 * Bash" reads identically on every such row.
 */
function panePrompt(pane: string | null): string | null {
  if (!pane) return null;
  const lines = pane.split("\n");
  const top = dialogTop(lines);
  if (top === null) return null;
  const paragraphs: string[] = [];
  // Collected bottom-up, so each paragraph is reversed back into reading order.
  let current: string[] = [];
  const flush = () => {
    const text = current.reverse().join(" ").trim();
    current = [];
    if (text) paragraphs.push(text);
  };
  for (let i = top - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) {
      flush();
      if (paragraphs.length >= MAX_PROSE_PARAGRAPHS) break;
      continue;
    }
    if (PERMISSION_HEADER.test(line)) break;
    current.push(line);
  }
  flush();
  let best: string | null = null;
  for (const p of paragraphs) {
    if (best === null || p.length > best.length) best = p;
  }
  return best;
}
