import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: a dispatched agent that silently disappears from the dashboard.
//
// `isBackgroundAgent` decides that a process is a daemon rather than an interactive session,
// and a process it rejects is never classified as an agent at all - discovery never binds it,
// so `Dispatcher.dispatch` fails READY_TIMEOUT_MS later as "agent session never appeared",
// a message pointing nowhere near the cause.
//
// It used to content-match the WHOLE `ps` command string for `claude ... daemon` and
// `mcp serve`. That was safe while a dispatched session's argv was `<claude> --model <id>`.
// It no longer is: the ask channel puts a state-dir path and the entire ~1.2KB redirect
// prompt on that same line, so the filter's input now includes an operator-chosen path and a
// block of English prose. An operator whose `MISSION_HOME` is `~/daemon-state`, or one edit
// adding the word "daemon" to the prompt, would take out every dispatched session.
//
// So the property under test is that the decision is made on the INVOCATION - argv0 and the
// subcommand after it - and cannot be reached by argument text, while the real background
// invocations it exists to catch still are.

const home = mkdtempSync(join(tmpdir(), "mission-bg-filter-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { isBackgroundAgent, classifyAgent } = await import("../src/server/discovery/processes.ts");
const { askChannelPrompt, ASK_TOOL, DISALLOWED_TOOL } = await import(
  "../src/server/ask-channel.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

const CLAUDE = "/Users/x/.local/bin/claude";

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

test("the real background invocations are still recognised", () => {
  // Observed forms, not invented ones: both are `<claude> <subcommand>`.
  assert.equal(
    isBackgroundAgent(`${CLAUDE} daemon run --json-path /Users/x/.claude/daemon.json`),
    true,
  );
  assert.equal(isBackgroundAgent(`${CLAUDE} mcp serve`), true);
});

test("an ordinary interactive session is not a background agent", () => {
  assert.equal(isBackgroundAgent(`${CLAUDE} --model claude-opus-4-8`), false);
  assert.equal(isBackgroundAgent("claude"), false);
});

test("a state-dir path containing 'daemon' does not disarm discovery", () => {
  // MISSION_HOME is the operator's to choose, and `--mcp-config` puts it on the command line.
  const line = dispatchedLine("/Users/x/daemon-state/ask-channel/mcp.json", "irrelevant");
  assert.equal(isBackgroundAgent(line), false, "an operator's path must not hide their agent");
  assert.equal(classifyAgent(line), "claude", "and it still classifies as the agent it is");
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

test("the redirect prompt that actually ships leaves a dispatched session detectable", () => {
  // The regression case built from the REAL prompt rather than a stand-in, so an edit to
  // `REDIRECT_PROMPT` that would blind discovery fails here instead of in production.
  const line = dispatchedLine(
    "/Users/x/.mission-control/ask-channel/mcp.json",
    askChannelPrompt,
  );
  assert.equal(isBackgroundAgent(line), false);
  assert.equal(classifyAgent(line), "claude");
});
