// The ask channel's text and tool names, with no dependency on state or configuration.
//
// Split from `ask-channel.ts` so the Claude SDK driver can render the channel without
// importing `mission-mcp.ts`, whose module scope resolves the state directory - loading it
// from the driver froze that path before test files could point it at their own home.
// Everything here is a pure function of the registered server's name.

/** The built-in the ask channel replaces. */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/** A Mission MCP tool's fully-qualified name, as Claude namespaces it under `serverName`. */
export function askChannelToolName(serverName: string, tool: string): string {
  return `mcp__${serverName}__${tool}`;
}

/**
 * The system-prompt appendix that sends the agent to our tool instead of the built-in.
 *
 * Written the way arm B's failure demands: it is not enough to name the replacement, the
 * prompt has to close the escape hatch the agent actually took. "Never ask as prose and
 * stop" is the sentence doing the work - without it the model reaches for the most natural
 * fallback (typing the question into its final answer) and the turn ends with nobody
 * looking at the terminal it typed into.
 *
 * It also states WHY, because a rule with a reason survives paraphrase and summarisation
 * into a long context better than a bare prohibition, and because the reason is true and
 * checkable: the human really is watching a dashboard rather than the child's screen.
 *
 * Passed INLINE as one argv element, which was measured before it was chosen rather than
 * assumed: 1260 bytes of this shape arrived byte-identical through `tmux new-session`,
 * including `$HOME`, `a*b` globs, double and single quotes, backticks, `$(cmd)`, semicolons,
 * pipes, ampersands and newlines. That is the same finding recorded on `spawnDetachedSession`
 * - tmux >= 3.3 uses the trailing arguments as the argv directly and does not reshell them.
 *
 * The accepted tradeoff: a dispatched agent's `ps` line now carries this prompt. That is
 * fine. It is a static instruction with no secrets in it, and the alternative - a file and
 * `--append-system-prompt-file` - buys that cosmetic tidiness with an UNDOCUMENTED flag,
 * a second file to keep in sync, and a capability probe that has to guess from `--help`
 * prose whether the flag exists. It guessed wrong: `claude --help` prints the two variants
 * folded together as `--append-system-prompt[-file]`, so the literal never appears and the
 * probe disabled the channel on every dispatch. `--append-system-prompt <text>` is listed
 * plainly in the option table, so there is nothing left to probe for.
 */
export function askChannelRedirect(serverName: string): string {
  const ask = askChannelToolName(serverName, "request_input");
  const blocker = askChannelToolName(serverName, "report_blocker");
  return `## Asking your human a question

You are running inside Mission Control. Your human operator watches a dashboard, NOT this
terminal. Nobody is reading your screen.

The built-in \`${ASK_USER_QUESTION_TOOL}\` tool is unavailable in this session. When you need a
decision, a clarification, or a choice from your human, call the MCP tool
\`${ask}\`. It puts the question on their dashboard and BLOCKS until they answer, then
returns their answer to you.

Pass discrete choices as \`options\` so they arrive as real controls the human can click:

    ${ask}(
      question: "Which linter should this repo use?",
      options: [
        { label: "biome", detail: "lint + format in one binary" },
        { label: "eslint", detail: "widest plugin ecosystem" },
      ],
    )

Omit \`options\` only when the answer is genuinely open-ended prose.

NEVER ask a question as ordinary prose and end your turn. A prose question reaches nobody:
the turn simply ends and your human never learns you were stuck. If a question is worth
asking, it is worth calling the tool for. If you would rather proceed on a reasonable
assumption than ask, that is fine - say which assumption you made and keep going. What is
not fine is stopping to ask where no one can hear you.

If you are waiting on someone or something other than your human operator, call the MCP
tool \`${blocker}\` instead; for a decision the operator can make, call
\`${ask}\`.
Ask your question where its owner will see it first (for example Commonroom), then report
the blocker with a link to that question, and end your turn.`;
}

/**
 * The ask channel as Agent SDK query options - the embedded runtime's half of the same rule.
 *
 * A task Mission Control runs asks its human through `request_input`, whichever runtime it
 * runs on. The SDK could draw Claude's own `AskUserQuestion` as a dashboard card, but that
 * card is a driver request rather than an input review: it is not in the review queue, it
 * has no Chat-about-it path, and it is answered differently from every other question a task
 * asks. One channel for every task is the point.
 *
 * The same all-or-nothing contract as the terminal argv, in the SDK's own spellings:
 * `allowedTools` pre-approves `request_input` (it adds an auto-approve rule and does not
 * narrow the toolset), `disallowedTools` removes the built-in, and `redirect` is the text the
 * caller composes into `systemPrompt.append`. Null when the launch registers no Mission MCP
 * server, because removing the built-in with nothing to replace it leaves the agent asking
 * into the void (arm B in `ask-channel.ts`).
 */
export interface SdkAskChannel {
  allowedTools: string[];
  disallowedTools: string[];
  redirect: string;
}

export function sdkAskChannel(missionMcpServerName: string | null): SdkAskChannel | null {
  if (!missionMcpServerName) return null;
  return {
    allowedTools: [askChannelToolName(missionMcpServerName, "request_input")],
    disallowedTools: [ASK_USER_QUESTION_TOOL],
    redirect: askChannelRedirect(missionMcpServerName),
  };
}
