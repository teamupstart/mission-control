import type { AgentType } from "@shared/types.ts";
import { mcpServerPath } from "./config.ts";
import {
  claudeMissionMcpArgs,
  missionMcpDescriptor,
  missionMcpPaths,
  missionMcpToolName,
  type MissionMcpRequirement,
} from "./mission-mcp.ts";

// The ask channel: how a dispatched agent asks its human a question.
//
// Claude's built-in `AskUserQuestion` renders a menu on the child's terminal, and reading
// that menu back is what `discovery/pane-dialog.ts` exists to do - 397 lines of grammar
// matching TUI chrome (cursor glyphs, numbered rows, "Submit answers"), plus the walkers in
// `actions.ts` that arrow through it and re-verify each label against a fresh capture. This
// module removes the need for any of that on sessions WE launch: the built-in is disallowed
// and the agent is pointed at `request_input`, our own MCP tool, which delivers the question
// to the dashboard as structured arguments and BLOCKS until the human answers.
//
// ---- what the experiment established (docs/plans/ask-channel/plan.md) ----
//
// Four arms, live tmux sessions against a running daemon, same question-inviting prompt:
//
//   B. `--disallowed-tools AskUserQuestion` alone
//        -> the agent asked IN PROSE AND STOPPED. It never attempted the tool and never
//           went looking for an alternative. That is WORSE than the menu it replaces: a
//           menu at least sits on the screen where pane-dialog reads it and Foreman can
//           answer it, whereas a prose question ends the turn and the dashboard shows an
//           idle session with no pending anything.
//   C. B + the redirect prompt
//        -> STILL PROSE, because the MCP server was not registered on that machine. The
//           agent said so itself: "my instructions say to ask you questions via a Mission
//           Control request_input tool, but that tool isn't actually registered in this
//           session (I checked)".
//   D. C + `--mcp-config`
//        -> the agent called `request_input(question: ...)` and blocked; the review
//           appeared in the dashboard; answering it resumed the session.
//
// Two conclusions are load-bearing here, and both are why this file is one function rather
// than four flags sprinkled through the dispatcher:
//
// A DISALLOWED TOOL DOES NOT REDIRECT ITSELF. The redirect prompt is not a nicety, it is
// the feature. Ship the disallow without it and you have arm B.
//
// PROVIDING THE REPLACEMENT MUST BE ATOMIC WITH REMOVING THE BUILT-IN. `request_input` is
// only reachable if the `mission-control` MCP server is registered, and registration
// happens through the Electron "Install integrations" button or a hand-run `claude mcp add`
// - machine state the daemon does not control and, on the machine this was developed on,
// state that was simply absent. Passing `--mcp-config` on the spawn argv means the same
// spawn that takes the built-in away supplies the replacement, so no machine state can have
// one without the other. User-scope registration still serves human-started sessions; it is
// just no longer what this rests on.
//
// WHICH server that registration points at is not decided here - `mission-mcp.ts` owns the
// bundle path, the runtime, the env and the server name, because Codex's launch needs the
// same answer in a completely different grammar and two copies of it is how one of them
// ends up pointed at a stale path nobody notices.

/**
 * The fully-qualified tool name, as Claude namespaces an MCP tool.
 *
 * Derived from the shared descriptor's server name rather than spelled again: the
 * pre-approval below only covers a tool whose name matches what the registration
 * produces, and a mismatch is silent - the agent stops on a permission prompt for a tool
 * we thought we had waved through.
 */
export const ASK_TOOL = missionMcpToolName("request_input");
/** The built-in this replaces. */
export const DISALLOWED_TOOL = "AskUserQuestion";

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
const REDIRECT_PROMPT = `## Asking your human a question

You are running inside Mission Control. Your human operator watches a dashboard, NOT this
terminal. Nobody is reading your screen.

The built-in \`${DISALLOWED_TOOL}\` tool is unavailable in this session. When you need a
decision, a clarification, or a choice from your human, call the MCP tool
\`${ASK_TOOL}\`. It puts the question on their dashboard and BLOCKS until they answer, then
returns their answer to you.

Pass discrete choices as \`options\` so they arrive as real controls the human can click:

    ${ASK_TOOL}(
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
not fine is stopping to ask where no one can hear you.`;

/**
 * Build the argv fragment that routes a dispatched session's questions to the dashboard.
 *
 * ALL FOUR FLAGS OR NONE. That is the entire contract of this function, and the reason it
 * returns an array rather than exposing its pieces:
 *
 *   --mcp-config             supplies `request_input`
 *   --allowed-tools          pre-approves it, so calling it does not itself raise a
 *                            permission menu (arm D stopped on exactly that prompt -
 *                            without this we trade one menu for another). Verified
 *                            separately: `--allowed-tools` ADDS an auto-approve rule
 *                            and does not restrict the toolset.
 *   --disallowed-tools       removes the built-in
 *   --append-system-prompt   tells the agent where to go instead, inline
 *
 * Returns EMPTY whenever anything at all goes wrong, and that direction is the whole point.
 * A session with `AskUserQuestion` intact is merely the status quo - pane-dialog reads its
 * menu and Foreman answers it. A session with the built-in removed and no replacement is arm
 * B: an agent that asks into the void. So the failure mode is "no ask channel", never "no way
 * to ask", and EVERY failure has to disarm the whole thing rather than half of it.
 *
 * Which is why the body below cannot throw. It is called from inside `Dispatcher.dispatch`'s
 * try block, so an unhandled EACCES / ENOSPC / read-only state dir would not just skip the
 * channel - it would abort a dispatch that had nothing else wrong with it, and a session that
 * would have launched fine never launches. Setting up the ask channel is best-effort by
 * construction; failing to set it up is never a reason to fail the task.
 *
 * Claude-only: these are Claude's flags, and codex has no equivalent.
 *
 * `require` widens WHAT is pre-approved, never how many registrations there are. Claude
 * already gets the Mission MCP server on every dispatch - that is what supplies
 * `request_input` - so a caller that needs another of our tools (Phase 4's ensemble
 * submission, say) is asking for one more name on the SAME `--allowed-tools`, not a second
 * `--mcp-config`. Passing it as one comma-separated value rather than several argv words:
 * `claude --help` documents the flag as "comma or space-separated", and one word cannot be
 * mistaken for the start of the next flag's value by a variadic parser.
 */
/**
 * What the ask channel contributes to a launch, in its two separable halves.
 *
 * The SPLIT is the point, and it is not cosmetic. `--append-system-prompt` is a
 * single-value flag with no self-repetition guard in the CLI, so a second one silently
 * discards the first - measured against claude 2.1.239, where `--betas <betas...>` two
 * lines below it in the same help output shows what a variadic flag looks like and this one
 * is not that. Every contributor to the system prompt therefore has to be composed into ONE
 * value, which means this function cannot be the thing that renders the flag.
 *
 * The all-or-nothing contract above applies to `args` and to `redirect` TOGETHER: they are
 * the ask channel, and half of it is arm B. It does not extend to whatever else the caller
 * composes into the same flag. A repository standing instruction has nothing to do with the
 * MCP bundle, and an unbuilt `dist` must not silently drop the operator's own words.
 */
export interface AskChannelContribution {
  /** The MCP registration, the allow rule and the disallow. Empty when the channel is off. */
  args: string[];
  /** The system-prompt text telling the agent where to ask instead, or null. */
  redirect: string | null;
}

const ASK_CHANNEL_OFF: AskChannelContribution = { args: [], redirect: null };

export async function askChannelContribution(
  agent: AgentType,
  require: MissionMcpRequirement | null = null,
  cwd?: string,
  stateHome?: string,
): Promise<AskChannelContribution> {
  if (agent !== "claude") return { ...ASK_CHANNEL_OFF };

  try {
    const descriptor = await missionMcpDescriptor(cwd, stateHome);
    if (!descriptor) {
      console.warn(
        `[mission-control] MCP server bundle not found at ${mcpServerPath()} - dispatched sessions will ` +
          `keep Claude's built-in ${DISALLOWED_TOOL} menu (run: npm run build). ` +
          `Disallowing it without a replacement would leave the agent no way to ask at all.`,
      );
      return { ...ASK_CHANNEL_OFF };
    }

    // Deduplicated and ask-first, so the common case is byte-identical to what a dispatch
    // without a requirement passes.
    const allowed = [...new Set([ASK_TOOL, ...(require?.tools ?? []).map(missionMcpToolName)])];

    return {
      args: [
        ...claudeMissionMcpArgs(descriptor),
        "--allowed-tools",
        allowed.join(","),
        "--disallowed-tools",
        DISALLOWED_TOOL,
      ],
      redirect: REDIRECT_PROMPT,
    };
  } catch (err) {
    console.warn(
      `[mission-control] could not set up the ask channel (${err instanceof Error ? err.message : String(err)}) - ` +
        `dispatched sessions keep Claude's built-in ${DISALLOWED_TOOL} menu. The dispatch itself ` +
        `proceeds: failing to set this up is never a reason to fail a task.`,
    );
    return { ...ASK_CHANNEL_OFF };
  }
}

/**
 * Render ONE `--append-system-prompt` flag from every contributor to it, or no flag at all.
 *
 * The only place that flag is ever spelled. Contributors are joined into a single value in
 * the order given, because the CLI would keep only the last of several flags and say
 * nothing about the ones it dropped - and on Claude the appended text never appears in the
 * transcript either, so a dropped standing instruction is indistinguishable from one that
 * was never set.
 *
 * No contributors renders no flag, which is what keeps a launch with neither an ask channel
 * nor a standing instruction byte-identical to what it always was.
 */
export function systemPromptAppendArgs(parts: readonly (string | null)[]): string[] {
  const value = parts.filter((part): part is string => !!part).join("\n\n");
  return value ? ["--append-system-prompt", value] : [];
}

/**
 * The ask channel's whole argv, as it stands with no other contributor - the shape this
 * function had before the system-prompt append became shared. Kept for callers and tests
 * that ask only about the ask channel, and defined AS the composition so the two cannot
 * drift.
 */
export async function askChannelArgs(
  agent: AgentType,
  require: MissionMcpRequirement | null = null,
  cwd?: string,
  stateHome?: string,
): Promise<string[]> {
  const contribution = await askChannelContribution(agent, require, cwd, stateHome);
  return [...contribution.args, ...systemPromptAppendArgs([contribution.redirect])];
}

/**
 * The path the argv points at - for tests and for anyone debugging a dispatched session.
 * One file, owned by `mission-mcp.ts`; this is the ask channel's name for it.
 */
export const askChannelPaths = { dir: missionMcpPaths.dir, mcpConfig: missionMcpPaths.config };

/** The redirect appended to a dispatched agent's system prompt - exported for tests. */
export const askChannelPrompt = REDIRECT_PROMPT;
