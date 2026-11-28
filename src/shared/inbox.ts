// Reports and inbox upgrades (`inbox` preview flag), said once for every side.
//
// Browser-safe: no `node:` import may reach this module. The flag id, and the registry of every
// action an inbox card offers with the words a voice command would use for it, live here so the
// daemon, the dashboard and a later voice layer read one declaration rather than three copies.

import { spokenNameLabel, type SpokenNameIdentity } from "./voice-names.ts";

/**
 * The preview flag for reports and inbox upgrades. Today it turns on agent reports (the Reports
 * section and the to read figure) and the one naming rule (`agentDisplayName`) on alert titles,
 * inbox rows, the review modal and question cards. Stuck rows are planned to join it in a later
 * phase, behind this same flag.
 * "inbox" also names headless mode's dispatch inbox, which is why the flag's label spells out
 * what it turns on.
 */
export const INBOX_FLAG = "inbox" as const;

/**
 * Why an inbox control has no spoken form. A control that only moves you somewhere else, only
 * shows or hides text, only hides a row, or acts on a whole section without naming an agent is
 * reached by a click and never by speech.
 */
export const INBOX_CLICK_ONLY_REASONS = ["navigation", "dismissal", "disclosure", "section-wide"] as const;
export type InboxClickOnlyReason = (typeof INBOX_CLICK_ONLY_REASONS)[number];

/**
 * What a person would say to take an action. `{name}` stands for the agent's display name and
 * `...` for whatever free text follows. `whileOpen` is the shorter form that works only while
 * the card is open on screen, or null when there is none.
 */
export interface InboxSpokenForm {
  named: string;
  whileOpen: string | null;
}

/**
 * One control an inbox card offers. Exactly one of `spoken` and `clickOnly` is set: an action
 * either has words a voice command would use, or a reason it never will.
 */
export interface InboxActionSpec {
  id: string;
  /** The control's visible text. A card may draw the same action under another label. */
  label: string;
  spoken: InboxSpokenForm | null;
  clickOnly: InboxClickOnlyReason | null;
}

/**
 * Every action an inbox card offers. Append-only by convention: a later phase declares the
 * actions it adds here and draws each one through `InboxActionButton`, so no control reaches a
 * card undeclared.
 *
 * The question card predates this registry, so only its two spoken forms are declared; its
 * controls are not routed through `InboxActionButton`.
 */
export const INBOX_ACTIONS = [
  {
    id: "answer-option",
    label: "Pick an option",
    spoken: { named: "{name}, option B", whileOpen: null },
    clickOnly: null,
  },
  {
    id: "answer",
    label: "Send answer",
    spoken: { named: "{name}, ...", whileOpen: "reply, ..." },
    clickOnly: null,
  },
  // The report card's show-and-hide control. It only discloses the body, so it is never spoken.
  {
    id: "toggle",
    label: "Show report",
    spoken: null,
    clickOnly: "disclosure",
  },
  {
    id: "mark-read",
    label: "Mark read",
    spoken: { named: "{name}, mark read", whileOpen: null },
    clickOnly: null,
  },
  // The report card's reply box, while its agent can take a message.
  {
    id: "reply",
    label: "Send reply",
    spoken: { named: "{name}, ...", whileOpen: "reply, ..." },
    clickOnly: null,
  },
  // The report card once its agent is gone. One action under two labels: Start a follow-up
  // task, and Retry after a dispatch that failed, which dispatches the task already created.
  {
    id: "follow-up",
    label: "Start a follow-up task",
    spoken: { named: "{name}, follow up, ...", whileOpen: "reply, ..." },
    clickOnly: null,
  },
  // A report's attached document, opened from the copy stored when it was posted. Drawn on the
  // report card and its conversation entry, only when the report has a document.
  {
    id: "open-report",
    label: "Open report",
    spoken: { named: "{name}, open report", whileOpen: null },
    clickOnly: null,
  },
  // Save that document to the scout archive. Only ever on the operator's press.
  {
    id: "publish-scout",
    label: "Publish as scout",
    spoken: { named: "{name}, publish as scout", whileOpen: null },
    clickOnly: null,
  },
  // Once published, go to the archive. It only moves you to the Scouts page.
  {
    id: "open-archive",
    label: "Open archive",
    spoken: null,
    clickOnly: "navigation",
  },
  // The Stuck card's controls.
  { id: "nudge", label: "Nudge", spoken: { named: "{name}, nudge", whileOpen: null }, clickOnly: null },
  { id: "continue", label: "Continue", spoken: { named: "{name}, continue", whileOpen: null }, clickOnly: null },
  { id: "mark-done", label: "Mark done", spoken: { named: "{name}, mark done", whileOpen: null }, clickOnly: null },
  { id: "resubmit", label: "Resubmit", spoken: { named: "{name}, resubmit", whileOpen: null }, clickOnly: null },
  { id: "push", label: "Tell it to push", spoken: { named: "{name}, push", whileOpen: null }, clickOnly: null },
  { id: "stop", label: "Interrupt", spoken: { named: "{name}, stop", whileOpen: null }, clickOnly: null },
  { id: "message", label: "Send", spoken: { named: "{name}, ...", whileOpen: "reply, ..." }, clickOnly: null },
  { id: "open-session", label: "Open session", spoken: null, clickOnly: "navigation" },
  { id: "open-run", label: "Open run", spoken: null, clickOnly: "navigation" },
  { id: "dismiss", label: "Dismiss", spoken: null, clickOnly: "dismissal" },
  // The report card's mute, drawn only while its author is not muted. A muted author's rows
  // leave the inbox, so Unmute lives in Settings > Reports, where it is a setting, not an action.
  {
    id: "mute",
    label: "Mute reports",
    spoken: { named: "{name}, mute reports", whileOpen: null },
    clickOnly: null,
  },
  // The Reports heading's Mark all read. It names no agent, and voice routes speech only by an
  // agent's name or "reply", so it is reached by a click alone.
  { id: "mark-all-read", label: "Mark all read", spoken: null, clickOnly: "section-wide" },
] as const satisfies readonly InboxActionSpec[];

export type InboxActionId = (typeof INBOX_ACTIONS)[number]["id"];

const ACTIONS_BY_ID: ReadonlyMap<string, InboxActionSpec> = new Map(
  (INBOX_ACTIONS as readonly InboxActionSpec[]).map((action) => [action.id, action]),
);

/** The registry entry for an action id. */
export function inboxAction(id: InboxActionId): InboxActionSpec {
  return ACTIONS_BY_ID.get(id)!;
}

export type HintName = string | SpokenNameIdentity;

export function spokenHintExample(name: HintName, template: string) {
  const label = typeof name === "string" ? name : spokenNameLabel(name);
  const phrase = template.replaceAll("{name}", () => label);
  return { phrase, quoteCommand: typeof name === "string" || !name.isReferenceName };
}

/**
 * The hint a card prints beside a control: its spoken form with the agent's name filled in,
 * and the open-card form after it when there is one. Null for a click-only action.
 */
export function spokenHintText(action: InboxActionSpec, name: HintName, cardOpen = false): string | null {
  if (!action.spoken) return null;
  const { phrase, quoteCommand } = spokenHintExample(name, action.spoken.named);
  const named = quoteCommand ? `"${phrase}"` : phrase;
  return cardOpen && action.spoken.whileOpen ? `${named} or "${action.spoken.whileOpen}"` : named;
}

/**
 * The fixed messages a Stuck row sends, in the wording the operator adopted. Each is queued as
 * daemon-written (`INBOX_MESSAGE_TURN_PREFIX`), so the agent's prompt hook never takes it for
 * the operator's Goal.
 */
export const INBOX_MESSAGES = {
  nudge:
    "Status check from your operator: you have gone quiet. Reply with one line on what you are doing and whether anything is blocking you, then carry on. If you are waiting on a long-running command, say which one.",
  continue:
    "Your operator asks you to continue. Work is still open against this session. Pick it up where you stopped and carry it through. If something is blocking you, say what it is instead of stopping.",
  push: "Push your commits. The review is waiting for a pushed head on this branch.",
} as const;

export type InboxMessageKind = keyof typeof INBOX_MESSAGES;
export const INBOX_MESSAGE_KINDS = Object.keys(INBOX_MESSAGES) as InboxMessageKind[];

/** The pending-turn id prefix of a fixed inbox message, which the outbox records as daemon-written. */
export const INBOX_MESSAGE_TURN_PREFIX = "inbox-message:";
