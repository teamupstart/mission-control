import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import type { AgentType } from "@shared/types.ts";
import { STATE_DIR, mcpServerPath } from "./config.ts";
import { run } from "./util/exec.ts";

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

/** The subdirectory holding the one file the spawn argv points at. */
const CHANNEL_DIR = join(STATE_DIR, "ask-channel");
const MCP_CONFIG_PATH = join(CHANNEL_DIR, "mcp.json");

/** What the MCP server is registered as, and therefore the prefix its tools carry. */
const SERVER_NAME = "mission-control";
/** The fully-qualified tool name, as Claude namespaces an MCP tool. */
export const ASK_TOOL = `mcp__${SERVER_NAME}__request_input`;
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
 * How to launch the MCP server bundle: a runtime and any env it needs.
 *
 * The daemon runs either under a real `node` (dev, `npm start`) or inside an Electron
 * `utilityProcess`, where `process.execPath` is the Electron binary and needs
 * `ELECTRON_RUN_AS_NODE=1` to behave like node. Same problem `integrations.ts` solves for
 * `claude mcp add`, solved the same way and for the same reason: Claude Code launches this
 * bundle as an EXTERNAL process, so it needs a concrete, absolute runtime rather than
 * whatever happens to be on the spawned shell's PATH.
 */
interface McpRuntime {
  command: string;
  env: Record<string, string>;
}

/** Resolved once per daemon lifetime - it cannot change while we run, and it may shell out. */
let cachedRuntime: McpRuntime | undefined;

async function resolveMcpRuntime(): Promise<McpRuntime> {
  if (cachedRuntime) return cachedRuntime;
  // Already a real node (dev, or a daemon started directly): use it, no subprocess needed.
  if (/^node(\.exe)?$/.test(basename(process.execPath))) {
    return (cachedRuntime = { command: process.execPath, env: {} });
  }
  const which = await run("which", ["node"]);
  const found = which.stdout.trim().split("\n")[0];
  if (which.code === 0 && found && existsSync(found)) {
    return (cachedRuntime = { command: found, env: {} });
  }
  // No system node - run the Electron binary in node mode, exactly as integrations.ts does.
  return (cachedRuntime = {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
}

/**
 * Write `file` only when its content would change, and ATOMICALLY when it does.
 *
 * The skip is an optimisation; the atomicity is not. This path is what the spawn argv
 * points at, so a plain `writeFileSync` over it can be read half-written by a `claude` that
 * a concurrent dispatch started moments earlier. A truncated `mcp.json` means no
 * `request_input` while `--disallowed-tools` still applies - arm B exactly, the one state
 * this module exists to prevent. Temp file in the SAME directory (so the rename cannot cross
 * a filesystem) then `renameSync`, which is atomic: a reader sees the old file or the new one.
 */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // Missing or unreadable: fall through and write it.
  }
  // Unique per writer, so two dispatches racing cannot share a temp file and interleave.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort - the throw below is what the caller acts on.
    }
    throw err;
  }
}

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
 */
export async function askChannelArgs(agent: AgentType): Promise<string[]> {
  if (agent !== "claude") return [];

  try {
    const server = mcpServerPath();
    if (!existsSync(server)) {
      console.warn(
        `[mission-control] MCP server bundle not found at ${server} - dispatched sessions will ` +
          `keep Claude's built-in ${DISALLOWED_TOOL} menu (run: npm run build). ` +
          `Disallowing it without a replacement would leave the agent no way to ask at all.`,
      );
      return [];
    }

    const runtime = await resolveMcpRuntime();
    mkdirSync(CHANNEL_DIR, { recursive: true });
    writeIfChanged(
      MCP_CONFIG_PATH,
      JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: { command: runtime.command, args: [server], env: runtime.env },
          },
        },
        null,
        2,
      ),
    );

    return [
      "--mcp-config",
      MCP_CONFIG_PATH,
      "--allowed-tools",
      ASK_TOOL,
      "--disallowed-tools",
      DISALLOWED_TOOL,
      "--append-system-prompt",
      REDIRECT_PROMPT,
    ];
  } catch (err) {
    console.warn(
      `[mission-control] could not set up the ask channel (${err instanceof Error ? err.message : String(err)}) - ` +
        `dispatched sessions keep Claude's built-in ${DISALLOWED_TOOL} menu. The dispatch itself ` +
        `proceeds: failing to set this up is never a reason to fail a task.`,
    );
    return [];
  }
}

/** The path the argv points at - for tests and for anyone debugging a dispatched session. */
export const askChannelPaths = { dir: CHANNEL_DIR, mcpConfig: MCP_CONFIG_PATH };

/** The redirect appended to a dispatched agent's system prompt - exported for tests. */
export const askChannelPrompt = REDIRECT_PROMPT;
