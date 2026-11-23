// Reports and inbox upgrades (`inbox` preview flag), said once for every side.
//
// Browser-safe: no `node:` import may reach this module. The flag id, and the registry of every
// action an inbox card offers with the words a voice command would use for it, live here so the
// daemon, the dashboard and a later voice layer read one declaration rather than three copies.

/**
 * The preview flag that turns on agent reports, Stuck rows and the one naming rule together.
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
] as const satisfies readonly InboxActionSpec[];

export type InboxActionId = (typeof INBOX_ACTIONS)[number]["id"];

const ACTIONS_BY_ID: ReadonlyMap<string, InboxActionSpec> = new Map(
  (INBOX_ACTIONS as readonly InboxActionSpec[]).map((action) => [action.id, action]),
);

/** The registry entry for an action id. */
export function inboxAction(id: InboxActionId): InboxActionSpec {
  return ACTIONS_BY_ID.get(id)!;
}

/**
 * The hint a card prints beside a control: its spoken form with the agent's name filled in,
 * and the open-card form after it when there is one. Null for a click-only action.
 */
export function spokenHintText(action: InboxActionSpec, name: string, cardOpen = false): string | null {
  if (!action.spoken) return null;
  const named = `"${action.spoken.named.replaceAll("{name}", name)}"`;
  return cardOpen && action.spoken.whileOpen ? `${named} or "${action.spoken.whileOpen}"` : named;
}
