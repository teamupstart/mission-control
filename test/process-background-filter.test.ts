import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake, in both directions: a dispatched agent that silently disappears from the
// dashboard, or a background worker that shows up in it as a phantom session.
//
// `isBackgroundAgent` decides that a process is infrastructure rather than an interactive
// session, and a process it rejects is never classified as an agent at all - discovery never
// binds it, so `Dispatcher.dispatch` fails READY_TIMEOUT_MS later as "agent session never
// appeared", a message pointing nowhere near the cause.
//
// The BACKGROUND lines below are verbatim from `ps` on a real machine, not invented. That is
// the whole point of this file. Two previous versions of this filter were each written against
// a plausible-looking form and each got the real ones wrong:
//
//   - Searching the whole command string for `claude … daemon` matched the pty-host and spare
//     workers only by ACCIDENT, because their socket path contains `cc-daemon-501`. That
//     accident was load-bearing, and it also meant an operator whose MISSION_HOME is
//     `~/daemon-state` would take out every dispatched session, since the ask channel now puts
//     that path and a ~1.2KB English prompt on the same command line.
//   - Narrowing to the command head fixed that, but silently dropped four of the five real
//     background forms, because only `claude daemon run` names its role in head position.
//
// So the property under test is that the decision is made against an explicit allowlist of
// real invocations, over tokens, and cannot be reached by an operator's paths or by prompt
// prose - while every background form actually observed still matches.

const home = mkdtempSync(join(tmpdir(), "mission-bg-filter-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { isBackgroundAgent, classifyAgent } = await import("../src/server/discovery/processes.ts");
const { askChannelPrompt, ASK_TOOL, DISALLOWED_TOOL } = await import(
  "../src/server/ask-channel.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

/** Verbatim from `ps -Ao command=`. Every background Claude Code process on a live machine. */
const BACKGROUND = [
  "/Users/jordanmance/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-501/753eef08/pty/b6b64c4d.sock 171 58 -- /Users/jordanmance/.local/share/claude/versions/2.1.215 --resume /Users/jordanmance/.claude/projects/x.jsonl",
  "/Users/jordanmance/.local/bin/claude daemon run --json-path /Users/jordanmance/.claude/daemon.json --log-file /Users/jordanmance/.claude/daemon.log",
  "claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/753eef08/spare/cd73182f.pty.sock 200 50 -- /Users/jordanmance/.local/share/claude/versions/2.1.216",
  "claude bg-spare --bg-spare /tmp/cc-daemon-501/753eef08/spare/cd73182f.claim.sock",
  "/Users/jordanmance/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-501/753eef08/spare/6201d323.pty.sock 156 40 -- /Users/jordanmance/.local/share/claude/versions/2.1.216",
];

const CLAUDE = "/Users/jordanmance/.local/bin/claude";

/** The argv a dispatch actually produces, joined the way `ps -Ao command=` reports it. */
function dispatchedLine(mcpConfig: string, prompt: string): string {
  return [
    CLAUDE,
    "--model",
    "claude-opus-4-8",
    "--mcp-config",
    mcpConfig,
    "--allowed-tools",
    ASK_TOOL,
    "--disallowed-tools",
    DISALLOWED_TOOL,
    "--append-system-prompt",
    prompt,
  ].join(" ");
}

test("every background form observed on a real machine is recognised", () => {
  for (const command of BACKGROUND) {
    assert.equal(isBackgroundAgent(command), true, command.slice(0, 90));
  }
});

test("`claude mcp serve` is recognised too", () => {
  // Not in the live list above, but the other invocation this filter has always named.
  assert.equal(isBackgroundAgent(`${CLAUDE} mcp serve`), true);
  assert.equal(isBackgroundAgent("claude mcp serve"), true);
});

test("an ordinary interactive session is not a background agent", () => {
  assert.equal(isBackgroundAgent(`${CLAUDE} --model claude-opus-4-8`), false);
  assert.equal(isBackgroundAgent("claude"), false, "no subcommand at all");
});

test("a full dispatched argv is not a background agent", () => {
  const line = dispatchedLine("/Users/x/.mission-control/ask-channel/mcp.json", askChannelPrompt);
  assert.equal(isBackgroundAgent(line), false);
  assert.equal(classifyAgent(line), "claude", "and it still classifies as the agent it is");
});

test("a state-dir path containing 'daemon' does not disarm discovery", () => {
  // MISSION_HOME is the operator's to choose, and `--mcp-config` puts it on the command line.
  const line = dispatchedLine("/Users/x/daemon-state/ask-channel/mcp.json", askChannelPrompt);
  assert.equal(isBackgroundAgent(line), false, "an operator's path must not hide their agent");
  assert.equal(classifyAgent(line), "claude");
});

test("prompt prose containing 'daemon' or 'mcp serve' does not disarm discovery", () => {
  // The redirect prompt is English, edited freely, and rides inline on the argv. Nothing in
  // it should be able to reach this decision.
  const line = dispatchedLine(
    "/Users/x/.mission-control/ask-channel/mcp.json",
    "The daemon is not reading this terminal, and neither does mcp serve.",
  );
  assert.equal(isBackgroundAgent(line), false);
  assert.equal(classifyAgent(line), "claude");
});

test("prose that merely quotes a background flag is still prose", () => {
  // Observed on the live machine, not hypothetical: a headless `claude -p` whose prompt
  // discusses this very filter carries the literal token `--bg-pty-host`. Scanning the whole
  // argv for that token classified it as a pty host. A flag only means what it means in argv
  // position, which is why only argv[1] and argv[2] are consulted.
  const line = `claude -p Explain why --bg-pty-host and --bg-spare are matched at argv[1] only`;
  assert.equal(isBackgroundAgent(line), false);
  assert.equal(
    isBackgroundAgent(dispatchedLine("/Users/x/mc/ask-channel/mcp.json", "Avoid --bg-spare.")),
    false,
  );
});
