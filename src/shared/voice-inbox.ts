import { INBOX_ACTIONS, type InboxActionId } from "./inbox.ts";

const namedCommands = INBOX_ACTIONS.filter(({ spoken }) => spoken && spoken.named !== "{name}, ...").map(({ id }) => id);

/** Identify commands (including "follow up, ...") before a different card can accept them as plain dictation. */
export function namedInboxCommand(body: string) {
  return spokenInboxAction(namedCommands, body, false);
}

/** Match the declared forms for the controls this card actually offers. Literal commands
 * outrank dictation, so a report reply never swallows "publish as scout". */
export function spokenInboxAction(ids: readonly InboxActionId[], body: string, reply: boolean) {
  let dictation: { action: InboxActionId; text: string } | undefined;
  for (const { id, spoken } of INBOX_ACTIONS) {
    if (!spoken || !ids.includes(id)) continue;
    const phrase = reply ? spoken.whileOpen?.replace(/^reply, /u, "") : spoken.named.replace("{name}, ", "");
    if (!phrase) continue;
    if (!phrase.endsWith("...")) {
      if (body.toLowerCase().replace(/[.!?]+$/u, "") === phrase.toLowerCase()) return { action: id, text: "" };
    } else {
      const prefix = phrase.slice(0, -3).replace(/, $/u, "");
      if (!prefix) dictation = { action: id, text: body };
      else if (body.toLowerCase().startsWith(prefix) && /^[,\s]/u.test(body.slice(prefix.length))) {
        const text = body.slice(prefix.length).replace(/^[,\s]+/u, "");
        if (text) return { action: id, text };
      }
    }
  }
  return dictation;
}
