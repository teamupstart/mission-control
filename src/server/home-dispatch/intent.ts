import { dispatchIntentFor, type DraftIntent } from "@shared/home-dispatch.ts";

/**
 * The run-now or schedule intent and its hook nudge (spec 7.20). The detector itself is the pure
 * `dispatchIntentFor` in `@shared/home-dispatch.ts`, so the MCP server and the skill can read the
 * same rule; this file owns only the sentence the daemon hands the model.
 */
export { dispatchIntentFor };

/**
 * The `additionalContext` for a prompt that asked to run or schedule work in Mission Control, or
 * null when it did not. The nudge is a hint: the `mission-dispatch` skill also works without it.
 */
export function dispatchNudge(prompt: string): string | null {
  const intent = dispatchIntentFor(prompt);
  return intent === null ? null : nudgeText(intent);
}

export function nudgeText(intent: DraftIntent): string {
  const what = intent === "now" ? "run this now" : "save this to the backlog";
  return (
    `The person asked to ${what} in Mission Control. ` +
    `Use the mission-dispatch skill's conversation entry with intent ${intent}. ` +
    "Then return to what you were doing."
  );
}
