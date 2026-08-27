import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG_IMAGE, writeImageDescriptor } from "./helpers/llm-image-fixtures.ts";

// A headless `claude -p` runs Claude Code for real, so it fires the SAME hooks a human's
// session does. `hooks/harness-hook.mjs` binds an event to a card with `captureTerminalEnv()`,
// which reads TMUX_PANE / WEZTERM_PANE from its own process - and the hook is a child of
// `claude`, which is a child of whatever spawned it. So if a headless run inherits the
// spawner's pane env, its hooks impersonate the card sitting in that pane.
//
// That is not hypothetical: it had already poisoned 3 of the 12 rows in this machine's live
// `session_agent_bindings` (two DIFFERENT real cards fused onto one headless uuid), because
// `applyHook` writes `agentSessionId: evt.sessionId ?? target.agentSessionId` - so the
// headless run's uuid becomes the card's, rotating `noteKeyFor` and orphaning the note and
// work queue it was keyed on.
//
// The fake bin reports the env it was handed, which is exactly what the hook would capture.
const dir = mkdtempSync(join(tmpdir(), "headless-env-"));
const fakeBin = join(dir, "fake-claude.sh");
const runArgs = join(dir, "args");
const runStdin = join(dir, "stdin");
process.env.RUN_ARGS = runArgs;
process.env.RUN_STDIN = runStdin;
writeFileSync(
  fakeBin,
  `#!/bin/sh
cat > "$RUN_STDIN"
: > "$RUN_ARGS"
stream_output=
previous=
for a in "$@"; do
  printf '%s\\n' "$a" >> "$RUN_ARGS"
  if [ "$previous" = "--output-format" ] && [ "$a" = "stream-json" ]; then stream_output=1; fi
  previous="$a"
done
if [ "$stream_output" = "1" ]; then
  printf '%s\\n' \\
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"mcp__plugin_example__search","input":{"query":"exact"}}]}}' \\
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"model-facing text"}]},"tool_use_result":{"rows":[{"id":1}],"pageInfo":{"hasNextPage":false}}}' \\
    '{"type":"result","result":"model summary"}'
else
  printf '{"tmuxPane":"%s","weztermPane":"%s","marker":"%s"}' \\
    "$TMUX_PANE" "$WEZTERM_PANE" "$MISSION_HEADLESS"
fi
`,
);
chmodSync(fakeBin, 0o755);
process.env.MISSION_CLAUDE_BIN = fakeBin;

// Both imports stay below the override. `registry.ts` reaches the harness registry, which reaches
// `claude-cli.ts`; importing the registry statically would freeze the real binary before this
// test's fake exists and make a supposedly isolated test spend a model call.
const { overlayKeyFromEnv } = await import("../src/server/registry.ts");
const { runClaudeText, runClaudeToolTrace } = await import("../src/server/claude-cli.ts");

function argv(): string[] {
  return readFileSync(runArgs, "utf8").split("\n").slice(0, -1);
}

/** Run the fake bin with a spawner env standing in for a pane-attached daemon/worker. */
async function envSeenByHook(): Promise<Record<string, string>> {
  const prev = { tmux: process.env.TMUX_PANE, wez: process.env.WEZTERM_PANE };
  process.env.TMUX_PANE = "%42";
  process.env.WEZTERM_PANE = "7";
  try {
    return JSON.parse(await runClaudeText("summarise this session", { timeoutMs: 5000 }));
  } finally {
    if (prev.tmux === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prev.tmux;
    if (prev.wez === undefined) delete process.env.WEZTERM_PANE;
    else process.env.WEZTERM_PANE = prev.wez;
  }
}

test("a headless run cannot be bound to the spawner's pane", async () => {
  const seen = await envSeenByHook();
  // Asserted through `overlayKeyFromEnv` rather than on the raw vars, because the key is what
  // actually decides impersonation: it is the first thing `findSessionByEnv` matches on, and a
  // null key is the whole defence.
  const key = overlayKeyFromEnv({
    tmuxPane: seen.tmuxPane || undefined,
    weztermPane: seen.weztermPane || undefined,
    termProgram: undefined,
  });
  assert.equal(key, null, `headless run inherited a pane key (${key}) and would impersonate that card`);
});

test("a headless run is marked so the hook can decline to report it", async () => {
  // Stripping the pane env stops the daemon binding the event; the marker stops the hook
  // POSTing at all. Independent layers on purpose - the hook script is installed globally
  // from a checkout that may lag this code, so neither can be assumed present.
  const seen = await envSeenByHook();
  assert.equal(seen.marker, "1", "headless run carries no MISSION_HEADLESS marker for the hook to see");
});

test("text-only and empty-image print calls retain exact argv and raw stdin", async () => {
  for (const images of [undefined, []] as const) {
    await runClaudeText("text-only prompt", { timeoutMs: 5_000, images });
    assert.deepEqual(argv(), ["-p", "--output-format", "json", "--tools", ""]);
    assert.equal(readFileSync(runStdin, "utf8"), "text-only prompt");
  }
});

test("a plugin-backed print call loads and pre-approves only its selected tools", async () => {
  const tools = "Skill,ToolSearch,mcp__plugin_example__search";
  await runClaudeText("query the configured source", {
    timeoutMs: 5_000,
    tools,
    allowedTools: tools,
    settingSources: ["user"],
  });
  assert.deepEqual(argv(), [
    "-p",
    "--output-format",
    "json",
    "--tools",
    tools,
    "--allowed-tools",
    tools,
    "--setting-sources",
    "user",
  ]);
});

test("a tool trace retains provider output separately from Claude's summary", async () => {
  const tools = "Skill,ToolSearch,mcp__plugin_example__search";
  const trace = await runClaudeToolTrace("query the configured source", {
    timeoutMs: 5_000,
    tools,
    allowedTools: tools,
    settingSources: ["user"],
  });

  assert.deepEqual(argv(), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    tools,
    "--allowed-tools",
    tools,
    "--setting-sources",
    "user",
  ]);
  assert.equal(trace.result, "model summary");
  assert.deepEqual(trace.toolCalls, [
    {
      name: "mcp__plugin_example__search",
      input: { query: "exact" },
      output: { rows: [{ id: 1 }], pageInfo: { hasNextPage: false } },
    },
  ]);
});

test("image-bearing print calls use one fresh stream-json user message", async () => {
  const first = writeImageDescriptor(dir, "first.png", PNG_IMAGE, "image/png", "first");
  const second = writeImageDescriptor(dir, "second.png", PNG_IMAGE, "image/png", "second");
  await runClaudeText("compare the screenshots", {
    timeoutMs: 5_000,
    images: [first, second],
  });

  const args = argv();
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "json",
    "--input-format",
    "stream-json",
    "--tools",
    "",
  ]);
  for (const forbidden of ["--resume", "--continue", "--session-id"]) {
    assert.equal(args.includes(forbidden), false);
  }
  const lines = readFileSync(runStdin, "utf8").split("\n");
  assert.equal(lines.at(-1), "", "the stream-json message must end at a frame boundary");
  assert.equal(lines.length, 2, "the call sent more than one user message");
  assert.deepEqual(JSON.parse(lines[0]!), {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: PNG_IMAGE.toString("base64"),
          },
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: PNG_IMAGE.toString("base64"),
          },
        },
        { type: "text", text: "compare the screenshots" },
      ],
    },
    parent_tool_use_id: null,
  });
});

test("print refuses an unreadable image before spawning", async () => {
  const image = writeImageDescriptor(dir, "gone.png", PNG_IMAGE, "image/png", "gone");
  rmSync(image.path);
  rmSync(runArgs, { force: true });
  await assert.rejects(
    runClaudeText("inspect this", { timeoutMs: 5_000, images: [image] }),
    /LLM image input refused/,
  );
  assert.equal(existsSync(runArgs), false, "an invalid image still spawned claude -p");
});
