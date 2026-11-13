// How an agent asks its operator for a decision.
//
// A decision reaches the operator as a `request_input` card on the dashboard, usually long
// after the agent formed the question and with none of the agent's context in front of them.
// A bare "Should I use A or B?" makes them go and reconstruct what the agent already knew -
// what is being decided, why it came up, and what each answer costs - before they can click
// anything. So the rule is not only WHERE to ask (the tool, never prose) but WHAT the ask
// carries: the context and the tradeoffs, on the card itself.
//
// ONE wording, read by every surface that tells an agent how to ask, so the rule cannot say
// one thing to one harness and something else to the next. WHAT a decision ask carries is
// true for every session, so it lives in the `request_input` tool description, which every
// harness that registers the Mission Control MCP server reads - Pi and Codex's terminal
// included. The dispatch-scoped prompts repeat it beside their own WHERE-to-ask instruction:
// Claude's redirect (`ask-channel.ts`) and Codex's launch developer instruction
// (`harness/codex/sdk.ts`). Where to ask stays out of the tool description on purpose - the
// MCP server is shared with sessions a human started, which keep Claude's built-in menu and
// whose terminal IS watched (see the note above `request_input` in `src/mcp/server.ts`).

/** What a decision ask carries, as an agent reads it. */
export const DECISION_CONTEXT_RULE =
  "A decision must carry what the operator needs to make it without reconstructing your " +
  "context: keep `question` to the decision itself, put the background in `context` (what " +
  "is being decided, why it came up, and what you found), give each option a `detail` that " +
  "states its tradeoff, and mark the option you would pick as `recommended`.";

/** The most text `context` may carry. Generous for a few paragraphs, bounded for the card. */
export const DECISION_CONTEXT_MAX_CHARS = 4000;

/**
 * The body an `input` review is filed with: the whole question, then its context.
 *
 * The question leads so the body still reads as the question everywhere it is used as one -
 * an open-ended ask's "chat about it" reply quotes it, and Foreman reads it - and the context
 * follows as its own paragraph. Without context the body is the question alone, exactly the
 * shape every earlier `request_input` card had.
 */
export function inputReviewBody(question: string, context: string | undefined): string {
  const background = context?.trim();
  return background ? `${question}\n\n${background}` : question;
}

/**
 * The part of an `input` review's body to print beneath its heading.
 *
 * The heading is the question clipped to a title. When the clip changed nothing, the body's
 * leading paragraph IS the heading, and printing it again directly beneath put the same
 * sentence on screen twice - so that paragraph is dropped and only the context is shown. A
 * question long enough to be clipped keeps its full text in the body, because the heading
 * does not carry it.
 */
export function inputReviewBodyText(title: string, body: string): string {
  if (body === title) return "";
  const lead = `${title}\n\n`;
  return body.startsWith(lead) ? body.slice(lead.length) : body;
}
