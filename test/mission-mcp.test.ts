import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// What is at stake: a dispatched session told a tool exists that it cannot call.
//
// Two harnesses register the SAME MCP bundle through two completely different launch
// grammars - Claude reads a JSON file named by `--mcp-config`, Codex takes three `-c`
// TOML overrides - and an agent then calls the tools by a name derived from the server
// name in that registration. Every one of those is silent when it is wrong: a stale path
// registers a server that never starts, an Electron runtime without `ELECTRON_RUN_AS_NODE`
// registers one that starts and immediately dies, and a pre-approved tool name that does
// not match what the server publishes pre-approves nothing while looking like it did.
//
// So these pin the EXACT bytes each harness receives, for paths that carry the characters
// a real absolute path can carry, and pin the tool vocabulary against the server's own
// `registerTool` calls.

const home = mkdtempSync(join(tmpdir(), "mission-mcp-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

// A stand-in for the built bundle: only its EXISTENCE is checked, and pointing at a real
// file keeps this test off `npm run build`.
const fakeBundle = join(home, "server.mjs");
writeFileSync(fakeBundle, "// not executed by this test\n");
process.env.HARNESS_MCP_SERVER = fakeBundle;

const {
  MISSION_MCP_SERVER_NAME,
  MISSION_MCP_TOOLS,
  claudeMissionMcpArgs,
  codexMissionMcpArgs,
  missionMcpConfigJson,
  missionMcpDescriptor,
  missionMcpPaths,
  missionMcpToolName,
} = await import("../src/server/mission-mcp.ts");
const { mcpServerPath } = await import("../src/server/config.ts");
const { askChannelArgs, ASK_TOOL } = await import("../src/server/ask-channel.ts");
const { prepareCodexLaunch } = await import("../src/server/harness/codex/launch.ts");
const { CODEX_HOOK_EVENTS } = await import("../src/server/harness/codex/hooks.ts");

/** The requirable tool union, derived from the runtime list so the scrape can be cast to it. */
type MissionMcpTool = (typeof MISSION_MCP_TOOLS)[number];

after(() => rmSync(home, { recursive: true, force: true }));

/** The value passed to a flag, so assertions read as pairs rather than by index. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Every `-c` value in an argv, in order. */
function overrides(args: string[]): string[] {
  return args.flatMap((a, i) => (a === "-c" ? [args[i + 1]!] : []));
}

/** An awkward but entirely legal descriptor: a runtime path with a space and a quote. */
const AWKWARD = {
  serverName: MISSION_MCP_SERVER_NAME,
  command: "/Applications/My App/Contents/it's/node",
  args: ["/Users/a b/Library/Application Support/dist/mcp/server.mjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

// ---- the descriptor ------------------------------------------------------------------

test("the descriptor points at the ONE resolved server path with an absolute runtime", async () => {
  const d = await missionMcpDescriptor();
  assert.ok(d, "the bundle exists, so there is a way to launch it");
  assert.equal(d.serverName, "mission-control");
  assert.deepEqual(d.args, [mcpServerPath()], "the packaged-safe resolver, never a second path");
  // The agent launches this as an EXTERNAL process, so a bare `node` off the spawned
  // shell's PATH is not good enough.
  assert.ok(d.command.startsWith("/"), `runtime should be absolute, got ${d.command}`);
});

test("a missing bundle is null, not a descriptor pointing at nothing", async () => {
  const prior = process.env.HARNESS_MCP_SERVER;
  process.env.HARNESS_MCP_SERVER = join(home, "never-built.mjs");
  try {
    assert.equal(await missionMcpDescriptor(), null);
  } finally {
    process.env.HARNESS_MCP_SERVER = prior;
  }
});

test("the packaged bundle path is the one two levels above the server source", () => {
  // esbuild collapses the daemon into `dist/server/index.mjs`, so only a resolver that
  // already sits two levels down in the source tree lands on the same file before and
  // after bundling. This is what `mcpServerPath()` promises, and the reason it lives in
  // `config.ts` rather than beside its callers.
  const prior = process.env.HARNESS_MCP_SERVER;
  delete process.env.HARNESS_MCP_SERVER;
  try {
    const expected = fileURLToPath(new URL("../dist/mcp/server.mjs", import.meta.url));
    assert.equal(mcpServerPath(), expected);
  } finally {
    process.env.HARNESS_MCP_SERVER = prior;
  }
});

test("the tool vocabulary matches what the MCP server actually registers", () => {
  // A name here that the server does not publish pre-approves nothing, and the agent
  // stops on a permission prompt for a tool we believed was waved through. A name the
  // server publishes but this list omits cannot be required by a launch at all.
  const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
  const registered = [...source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.ok(registered.length > 0, "the scrape found nothing - has registerTool been renamed?");
  assert.deepEqual([...MISSION_MCP_TOOLS].sort(), [...registered].sort());
});

test("every tool the server registers is reachable by a launch that requires it", async () => {
  // Companion to the vocabulary test above, and the gap that let create_task read as
  // present-but-uncallable. That test pins WHAT a launch may require - the list and the
  // server's registrations name the same tools. This one pins the STEP AFTER: that
  // requiring a tool actually delivers it, pre-approved on the argv the child receives, so
  // a dispatched session can call it without stopping on a permission prompt (auto mode does
  // NOT blanket-approve MCP tools). Neither `--allowed-tools` nor this list can put a tool
  // into a session's `tools/list` - only the running bundle does that, which is why the
  // observed miss was a stale `dist/mcp/server.mjs` and not a drift this suite could see -
  // but once the tool IS published, this is what proves a caller can actually reach it.
  //
  // Anchored on the server's OWN registrations, so a tool that exists yet no launch can
  // pre-approve fails here rather than passing a check written against a list that forgot it.
  const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
  const registered = [...source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.ok(registered.length > 0, "the scrape found nothing - has registerTool been renamed?");

  // One launch that requires the whole published set. Every tool must come back pre-approved,
  // each namespaced under the server it is registered on, and there must still be exactly one
  // registration - widening the allowlist never adds a second `--mcp-config`.
  const args = await askChannelArgs("claude", { tools: registered as MissionMcpTool[] });
  assert.equal(args.filter((a) => a === "--mcp-config").length, 1, "one registration, always");
  const allowed = new Set(flag(args, "--allowed-tools")?.split(",") ?? []);
  for (const tool of registered) {
    assert.ok(
      ([...MISSION_MCP_TOOLS] as string[]).includes(tool),
      `the server registers "${tool}" but no caller can require it - add it to MISSION_MCP_TOOLS`,
    );
    assert.ok(
      allowed.has(missionMcpToolName(tool as MissionMcpTool)),
      `the server registers "${tool}" but a launch requiring it never pre-approves ` +
        `mcp__${MISSION_MCP_SERVER_NAME}__${tool} - it would stop on a permission prompt`,
    );
  }
});

test("a tool name is namespaced by the server name it is registered under", () => {
  assert.equal(missionMcpToolName("request_input"), "mcp__mission-control__request_input");
  assert.equal(ASK_TOOL, missionMcpToolName("request_input"), "one derivation, not two spellings");
});

// ---- Claude's config file ------------------------------------------------------------

test("Claude's config names our server, the bundle, and the runtime env verbatim", () => {
  const json = missionMcpConfigJson(AWKWARD);
  assert.deepEqual(JSON.parse(json), {
    mcpServers: {
      "mission-control": {
        command: "/Applications/My App/Contents/it's/node",
        args: ["/Users/a b/Library/Application Support/dist/mcp/server.mjs"],
        // Dropping this would register a server that starts an Electron binary as an app
        // instead of as node, which fails at launch and looks like a missing tool.
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  });
});

test("Claude's argv points at the file that was just written", async () => {
  const d = await missionMcpDescriptor();
  const args = claudeMissionMcpArgs(d!);
  assert.deepEqual(args, ["--mcp-config", missionMcpPaths.config]);
  assert.equal(readFileSync(missionMcpPaths.config, "utf8"), missionMcpConfigJson(d!));
});

// ---- Codex's TOML overrides ----------------------------------------------------------

test("Codex gets command, args and env as three overrides that round-trip exactly", () => {
  // Probed against codex-cli 0.145.0: `codex mcp list --json` with exactly these overrides
  // reports the server with all three fields byte-identical, including the space and the
  // single quote below. That probe is why this is a fixture and not an installed-Codex
  // dependency of the suite.
  const args = codexMissionMcpArgs(AWKWARD);
  assert.deepEqual(args, [
    "-c", `mcp_servers.mission-control.command="/Applications/My App/Contents/it's/node"`,
    "-c", `mcp_servers.mission-control.args=["/Users/a b/Library/Application Support/dist/mcp/server.mjs"]`,
    "-c", `mcp_servers.mission-control.env={"ELECTRON_RUN_AS_NODE"="1"}`,
  ]);
});

test("a runtime needing no env still says so, rather than omitting the key", () => {
  // An empty inline table is a statement - "this runtime needs nothing" - and Codex accepts
  // it (probed). An omitted key would make "no env" and "we forgot the env" the same argv.
  const args = codexMissionMcpArgs({ ...AWKWARD, env: {} });
  assert.equal(args.at(-1), `mcp_servers.mission-control.env={}`);
  assert.equal(overrides(args).length, 3, "all three keys together or none");
});

test("a path carrying a double quote or a backslash is escaped, not injected", () => {
  // TOML basic strings share JSON's escape grammar for exactly these characters, which is
  // why JSON.stringify is the encoder. Without it the value would end early and the rest
  // would be parsed as TOML.
  const args = codexMissionMcpArgs({ ...AWKWARD, command: String.raw`/we"ird\node` });
  const command = overrides(args)[0]!;
  const encoded = /^mcp_servers\.mission-control\.command=("(?:\\.|[^"])*")$/.exec(command)?.[1];
  assert.ok(encoded, "the command is not a well-formed TOML basic string");
  assert.equal(JSON.parse(encoded), String.raw`/we"ird\node`);
});

// ---- composition on a real launch ----------------------------------------------------

test("Codex combines auto-mode flags, MCP registration, hooks and the trust bypass", async () => {
  const bridge = join(home, "codex-hook.mjs");
  writeFileSync(bridge, "");
  process.env.MISSION_CODEX_HOOK = bridge;
  try {
    const prepared = await prepareCodexLaunch(true, { tools: ["request_input"] });
    assert.equal(prepared.instrumented, true);
    assert.equal(prepared.missionMcp, true);

    // Auto mode first, unchanged.
    assert.deepEqual(
      prepared.args.slice(0, 4),
      ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    );
    // The trust bypass still rides at the end, and still only with the hooks.
    assert.equal(prepared.args.at(-1), "--dangerously-bypass-hook-trust");

    const cfg = overrides(prepared.args);
    assert.equal(cfg.length, 3 + CODEX_HOOK_EVENTS.length, "three MCP keys plus one per hook event");
    assert.deepEqual(cfg.slice(0, 3), overrides(codexMissionMcpArgs((await missionMcpDescriptor())!)));
    for (const [i, event] of CODEX_HOOK_EVENTS.entries()) {
      assert.match(cfg[3 + i]!, new RegExp(`^hooks\\.${event}=`));
    }
  } finally {
    delete process.env.MISSION_CODEX_HOOK;
  }
});

test("a missing MCP bundle costs Codex the registration and nothing else", async () => {
  const bridge = join(home, "codex-hook.mjs");
  writeFileSync(bridge, "");
  process.env.MISSION_CODEX_HOOK = bridge;
  const priorBundle = process.env.HARNESS_MCP_SERVER;
  process.env.HARNESS_MCP_SERVER = join(home, "never-built.mjs");
  try {
    const prepared = await prepareCodexLaunch(false, { tools: ["request_input"] });
    // Partial registration is the thing that must not happen: a `command` with no `args`
    // is a server that appears configured and can never start.
    assert.equal(prepared.missionMcp, false);
    assert.ok(!prepared.args.some((a) => a.startsWith("mcp_servers.")), "no half a registration");
    // The other unit is untouched - hooks and their trust bypass are a separate all-or-none.
    assert.equal(prepared.instrumented, true);
    assert.equal(prepared.args.at(-1), "--dangerously-bypass-hook-trust");
  } finally {
    process.env.HARNESS_MCP_SERVER = priorBundle;
    delete process.env.MISSION_CODEX_HOOK;
  }
});

test("a missing hook bridge still never produces a lone trust bypass, MCP or not", async () => {
  const priorHook = process.env.MISSION_CODEX_HOOK;
  process.env.MISSION_CODEX_HOOK = join(home, "no-such-bridge.mjs");
  try {
    const prepared = await prepareCodexLaunch(true, { tools: ["request_input"] });
    assert.equal(prepared.instrumented, false);
    assert.ok(!prepared.args.includes("--dangerously-bypass-hook-trust"));
    assert.ok(!prepared.args.some((a) => a.startsWith("hooks.")));
    // …and the MCP registration, which needs no trust bypass, survives on its own.
    assert.equal(prepared.missionMcp, true);
    assert.equal(overrides(prepared.args).length, 3);
  } finally {
    if (priorHook === undefined) delete process.env.MISSION_CODEX_HOOK;
    else process.env.MISSION_CODEX_HOOK = priorHook;
  }
});

test("Codex without a requirement is byte-identical to before this seam existed", async () => {
  const bridge = join(home, "codex-hook.mjs");
  writeFileSync(bridge, "");
  process.env.MISSION_CODEX_HOOK = bridge;
  try {
    const prepared = await prepareCodexLaunch(false);
    assert.equal(prepared.missionMcp, false);
    assert.equal(overrides(prepared.args).length, CODEX_HOOK_EVENTS.length, "hooks only");
  } finally {
    delete process.env.MISSION_CODEX_HOOK;
  }
});

test("a required tool is pre-approved beside the ask tool, on one registration", async () => {
  // Claude already carries our MCP server on every dispatch - that is what supplies
  // `request_input` - so requiring another of our tools must widen the pre-approval
  // rather than register the server a second time.
  const args = await askChannelArgs("claude", { tools: ["report_status", "request_input"] });
  assert.equal(args.filter((a) => a === "--mcp-config").length, 1, "one registration, always");
  assert.equal(
    flag(args, "--allowed-tools"),
    `${ASK_TOOL},${missionMcpToolName("report_status")}`,
    "ask tool first, required tools after, each once",
  );
});

test("a dispatch that requires nothing pre-approves exactly what it always did", async () => {
  const args = await askChannelArgs("claude");
  assert.equal(flag(args, "--allowed-tools"), ASK_TOOL);
});

test("a harness with no MCP client is not handed one", async () => {
  // pi declares `mcp: null`. Requiring Mission tools of it cannot silently produce flags
  // for somebody else's CLI.
  assert.deepEqual(await askChannelArgs("pi", { tools: ["request_input"] }), []);
});
