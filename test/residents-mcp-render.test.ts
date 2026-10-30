import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexResidentMcpVerdict,
  operatorRolloutPath,
  prepareResidentCodexHome,
  residentCodexConfig,
  residentMcpToml,
  stripMcpServers,
} from "../src/server/harness/codex/resident-home.ts";
import { claudeSdkSpec } from "../src/server/harness/claude/sdk.ts";
import { codexSdkSpec } from "../src/server/harness/codex/sdk.ts";
import type { AppServerTransport } from "../src/server/harness/codex/app-server/client.ts";
import type { ResidentMcpEntry, ResidentMcpLaunch, SdkLaunchOptions } from "../src/server/harness/types.ts";

// How a resident's pinned MCP set reaches each harness, and how the scoped launcher hands a
// secret to its one server. Drivers run against their scripted seams; the launcher runs as a
// real process against a loopback redemption stand-in and fixture servers.

const root = mkdtempSync(join(tmpdir(), "mission-mcp-render-"));
after(() => rmSync(root, { recursive: true, force: true }));

const SECRET = "render-sentinel-secret-7731";

// ---- the Codex overlay's TOML ----

test("MCP statements are removed in every TOML form, and every other byte is kept", () => {
  const source = [
    "# operator comment",
    'model = "gpt-5"',
    "startup_val = 1.0",
    "when = 1979-05-27T07:32:00Z",
    'mcp_servers.dotted.command = "a"',
    'mcp_servers = { inline = { command = "b" } }',
    'notes = """',
    "[mcp_servers.not_a_table]",
    '"""',
    "[mcp_servers.alpha]",
    `command = "node"`,
    `env = { TOKEN = "${SECRET}" }`,
    "args = [",
    '  "x", # comment',
    "  [1, 2],",
    "]",
    "[mcp_servers.alpha.env]",
    `MORE = "${SECRET}"`,
    `[mcp_servers."foo.bar"]`,
    'url = "https://x"',
    "[ profiles . p ]",
    'model = "o3"',
    "[[mcp_servers]]",
    'name = "array"',
    "[projects.'/repo']",
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const stripped = stripMcpServers(source);
  assert.ok(!stripped.includes(SECRET));
  assert.ok(!/^\s*\[?\[?mcp_servers/m.test(stripped.replace(/notes = """[\s\S]*?"""/, "")), stripped);
  for (const kept of ["# operator comment", "startup_val = 1.0", "when = 1979-05-27T07:32:00Z", "[mcp_servers.not_a_table]", "[ profiles . p ]", 'model = "o3"', "[projects.'/repo']", 'trust_level = "trusted"']) {
    assert.ok(stripped.includes(kept), kept);
  }
  assert.throws(() => stripMcpServers('key = "unterminated\n'), /unterminated/);
});

const entries: ResidentMcpEntry[] = [
  { name: "foo.bar", options: { codex: { startupTimeoutSec: 12, toolTimeoutSec: 1.5, enabledTools: ["read"], disabledTools: ["write"] } }, shape: "stdio", command: "/usr/bin/srv", args: ['a "quoted" arg', "b"], env: { MODE: "fast" } },
  { name: "web", options: {}, shape: "http", url: "https://web.example.com/mcp", headers: { Accept: "application/json" } },
  { name: "secret", options: {}, shape: "launcher", command: "/usr/bin/node", args: ["/l.mjs", "--run", "r", "--server", "secret", "--credential", "/c.json"], env: {} },
];

test("the snapshot's servers are written under quoted keys with their allowlisted options", () => {
  const toml = residentMcpToml(entries, ["proj.dot"]);
  assert.match(toml, /^\[mcp_servers\."foo\.bar"\]$/m, "a dotted name stays one server");
  assert.match(toml, /^args = \["a \\"quoted\\" arg", "b"\]$/m);
  assert.match(toml, /^startup_timeout_sec = 12$/m);
  assert.match(toml, /^tool_timeout_sec = 1\.5$/m);
  assert.match(toml, /^enabled_tools = \["read"\]$/m);
  assert.match(toml, /^disabled_tools = \["write"\]$/m);
  assert.match(toml, /^\[mcp_servers\."web"\]\nurl = "https:\/\/web\.example\.com\/mcp"\nhttp_headers = \{ "Accept" = "application\/json" \}$/m);
  assert.match(toml, /^\[mcp_servers\."proj\.dot"\]\nenabled = false$/m);
});

test("the generated configuration keeps the operator's settings, points the databases home, and holds no native server", () => {
  const operator = `model = "gpt-5"\n[mcp_servers.native]\ncommand = "n"\nenv = { K = "${SECRET}" }\n`;
  const config = residentCodexConfig(operator, entries, [], "/operator/.codex");
  assert.ok(config.startsWith('sqlite_home = "/operator/.codex"\n'));
  assert.ok(config.includes('model = "gpt-5"'));
  assert.ok(!config.includes("native") && !config.includes(SECRET));
  const own = residentCodexConfig('sqlite_home = "/elsewhere"\n', [], [], "/operator/.codex");
  assert.equal(own, 'sqlite_home = "/elsewhere"\n', "an operator's own choice is kept");
});

test("the overlay links the operator's home, writes an owner-only configuration, and maps rollouts back", () => {
  const operator = join(root, "operator-codex");
  const overlay = join(root, "run", "codex-home");
  mkdirSync(operator, { recursive: true });
  writeFileSync(join(operator, "config.toml"), `[mcp_servers.native]\ncommand = "n"\nenv = { K = "${SECRET}" }\n`);
  writeFileSync(join(operator, "auth.json"), "{}");
  writeFileSync(join(operator, "AGENTS.md"), "instructions");
  const path = prepareResidentCodexHome({ overlay, entries, operatorHome: operator });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, "utf8").includes(SECRET));
  for (const name of ["auth.json", "AGENTS.md", "sessions"]) {
    assert.ok(lstatSync(join(overlay, name)).isSymbolicLink(), name);
    assert.equal(readlinkSync(join(overlay, name)), join(operator, name));
  }
  assert.equal(lstatSync(join(overlay, "config.toml")).isSymbolicLink(), false);
  // A native entry added later is linked on the next start; one that disappears is unlinked.
  writeFileSync(join(operator, "later.json"), "{}");
  rmSync(join(operator, "AGENTS.md"));
  prepareResidentCodexHome({ overlay, entries, operatorHome: operator });
  assert.ok(lstatSync(join(overlay, "later.json")).isSymbolicLink());
  assert.equal(existsSync(join(overlay, "AGENTS.md")), false);
  assert.equal(
    operatorRolloutPath(join(overlay, "sessions", "2026", "rollout.jsonl"), overlay, operator),
    join(operator, "sessions", "2026", "rollout.jsonl"),
  );
  assert.equal(operatorRolloutPath("/elsewhere/rollout.jsonl", overlay, operator), "/elsewhere/rollout.jsonl");
});

// ---- verifying the layers before any server loads ----

const user = (servers: Record<string, unknown>) => ({ name: { type: "user", file: "/run/codex-home/config.toml" }, config: { mcp_servers: servers } });
const project = (servers: Record<string, unknown>) => ({ name: { type: "project", dotCodexFolder: "/repo/.codex" }, config: { mcp_servers: servers } });
const flags = { name: { type: "sessionFlags" }, config: { mcp_servers: { "mission-control": { command: "m" } } } };
const input = { overlayConfig: "/run/codex-home/config.toml", names: ["snap"], disabled: [] as string[], missionServer: "mission-control" };

test("Codex's layers decide whether a start is exact, needs foreign servers switched off, or is refused", () => {
  const exact = { config: { mcp_servers: { snap: { command: "s" }, "mission-control": { command: "m" } } }, layers: [flags, user({ snap: { command: "s" } })] };
  assert.deepEqual(codexResidentMcpVerdict(exact, input), { kind: "exact" });
  const foreign = { config: { mcp_servers: { snap: {}, "proj.dot": { command: "p" } } }, layers: [flags, project({ "proj.dot": { command: "p" } }), user({ snap: {} })] };
  assert.deepEqual(codexResidentMcpVerdict(foreign, input), { kind: "disable", names: ["proj.dot"] });
  const disabled = { config: { mcp_servers: { snap: {}, "mission-control": { command: "m" }, "proj.dot": { command: "p", enabled: false } } }, layers: [flags, project({ "proj.dot": { command: "p" } }), user({ snap: {}, "proj.dot": { enabled: false } })] };
  assert.deepEqual(codexResidentMcpVerdict(disabled, { ...input, disabled: ["proj.dot"] }), { kind: "exact" });
  const forced = { config: { mcp_servers: { snap: {}, forced: { enabled: true } } }, layers: [flags, project({ forced: { enabled: true } }), user({ snap: {}, forced: { enabled: false } })] };
  assert.match((codexResidentMcpVerdict(forced, { ...input, disabled: ["forced"] }) as { reason: string }).reason, /enables the MCP server forced itself/);
  const merged = { config: { mcp_servers: { snap: { env: { X: "1" } } } }, layers: [flags, project({ snap: { env: { X: "1" } } }), user({ snap: {} })] };
  assert.match((codexResidentMcpVerdict(merged, input) as { reason: string }).reason, /\/repo\/\.codex also defines the resident's MCP server snap/);
  assert.equal(codexResidentMcpVerdict({}, input).kind, "refuse", "an answer without layers is never trusted");
  assert.equal(codexResidentMcpVerdict({ config: {}, layers: [flags] }, input).kind, "refuse", "the overlay must have loaded");
});

test("another layer that switches off or changes Mission Control's own server refuses the start", () => {
  const disabled = { config: { mcp_servers: { snap: {}, "mission-control": { command: "m", enabled: false } } }, layers: [flags, project({ "mission-control": { enabled: false } }), user({ snap: {} })] };
  assert.match((codexResidentMcpVerdict(disabled, input) as { reason: string }).reason, /also defines Mission Control's own MCP server mission-control/);
  const changed = { config: { mcp_servers: { snap: {}, "mission-control": { command: "m", env: { X: "1" } } } }, layers: [flags, project({ "mission-control": { env: { X: "1" } } }), user({ snap: {} })] };
  assert.equal(codexResidentMcpVerdict(changed, input).kind, "refuse");
  const absent = { config: { mcp_servers: { snap: {} } }, layers: [flags, user({ snap: {} })] };
  assert.match((codexResidentMcpVerdict(absent, input) as { reason: string }).reason, /would not start Mission Control's own MCP server/);
});

// ---- the drivers ----

function residentLaunch(
  names: string[],
  built: () => ResidentMcpEntry[],
  onStart: () => void = () => {},
): ResidentMcpLaunch & { starts: number } {
  const launch = {
    names,
    privateDir: join(root, `private-${Math.random().toString(36).slice(2)}`),
    starts: 0,
    forStart() {
      launch.starts += 1;
      onStart();
      return built();
    },
    preview: () => built().map((entry) => (entry.shape === "launcher" ? { ...entry, args: [...entry.args.slice(0, -1), "unissued"] } : entry)),
  };
  return launch;
}

function sdkOptions(over: Partial<SdkLaunchOptions>): SdkLaunchOptions {
  return {
    cwd: "/wt", stateHome: "/tmp/state", prompt: "go", model: null, effort: null, permissionMode: null,
    mcp: { serverName: "mission-control", command: "/usr/bin/node", args: ["/mcp.mjs"], env: { MISSION_PORT: "1" } },
    extraDirs: [], standingInstructions: "", standingInstructionsPrompt: "", resume: null,
    ...over,
  };
}

function idleQuery(configured: () => string[]) {
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => { release = resolve; });
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => { await closed; return { value: undefined, done: true as const }; } };
    },
    async return() { release(); return { value: undefined, done: true as const }; },
    async interrupt() { return undefined; },
    async setPermissionMode() {},
    async applyFlagSettings() {},
    async setModel() {},
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {} as never; },
    async mcpServerStatus() { return configured().map((name) => ({ name, status: "connected" })); },
  };
}

test("Claude starts exactly Mission's server and the snapshot, under strict MCP config, minting each start", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const resident = residentLaunch(["foo.bar", "web", "secret"], () => entries.map((entry) => ({ ...entry })));
  let configured: string[] = [];
  const spec = claudeSdkSpec({
    executable: async () => "/fake/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ options }) => {
      seen.push(options as unknown as Record<string, unknown>);
      configured = Object.keys((options as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
      return idleQuery(() => configured) as never;
    },
  });
  const handle = await spec.launch(sdkOptions({ residentMcp: resident }));
  const options = seen[0]!;
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settings, { disableClaudeAiConnectors: true });
  const servers = options.mcpServers as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(servers), ["mission-control", "foo.bar", "web", "secret"], "Mission's descriptor kept, never replaced");
  assert.deepEqual(servers.web, { type: "http", url: "https://web.example.com/mcp", headers: { Accept: "application/json" } });
  assert.deepEqual(servers.secret!.args, ["/l.mjs", "--run", "r", "--server", "secret", "--credential", "/c.json"]);
  assert.equal(resident.starts, 1);
  await handle.stop();

  // Allowlisted options round-trip exactly.
  const optioned = residentLaunch(["opt"], () => [{ name: "opt", options: { claude: { timeoutMs: 4000, alwaysLoad: true } }, shape: "stdio", command: "o", args: [], env: {} }]);
  const second = await spec.launch(sdkOptions({ residentMcp: optioned }));
  assert.deepEqual((seen[1]!.mcpServers as Record<string, unknown>).opt, { type: "stdio", command: "o", args: [], env: {}, timeout: 4000, alwaysLoad: true });
  await second.stop();

  // Every other launch is exactly what it was: no strict mode, no flag settings.
  const ordinary = await spec.launch(sdkOptions({}));
  assert.equal(seen[2]!.strictMcpConfig, undefined);
  assert.equal(seen[2]!.settings, undefined);
  await ordinary.stop();
});

test("a Claude session that configured a server outside its snapshot fails the launch", async () => {
  const spec = claudeSdkSpec({
    executable: async () => "/fake/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async () => idleQuery(() => ["mission-control", "snap", "claude.ai Gmail"]) as never,
  });
  await assert.rejects(
    spec.launch(sdkOptions({ residentMcp: residentLaunch(["snap"], () => [{ name: "snap", options: {}, shape: "stdio", command: "s", args: [], env: {} }]) })),
    /configured the MCP server claude\.ai Gmail, which is not in its snapshot/,
  );
});

test("a Claude session that did not configure a snapshot server fails the launch", async () => {
  const spec = claudeSdkSpec({
    executable: async () => "/fake/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async () => idleQuery(() => ["mission-control"]) as never,
  });
  await assert.rejects(
    spec.launch(sdkOptions({ residentMcp: residentLaunch(["snap"], () => [{ name: "snap", options: {}, shape: "stdio", command: "s", args: [], env: {} }]) })),
    /did not configure its MCP server snap/,
  );
});

test("a server name that is an Object.prototype key is an own mcpServers entry, so it is not silently dropped", async () => {
  let servers: Record<string, unknown> = {};
  const spec = claudeSdkSpec({
    executable: async () => "/fake/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ options }) => {
      servers = (options as { mcpServers: Record<string, unknown> }).mcpServers;
      return idleQuery(() => Object.keys(servers)) as never;
    },
  });
  const handle = await spec.launch(sdkOptions({
    residentMcp: residentLaunch(["__proto__"], () => [{ name: "__proto__", options: {}, shape: "stdio", command: "p", args: [], env: {} }]),
  }));
  assert.deepEqual(Object.keys(servers), ["mission-control", "__proto__"]);
  assert.deepEqual(JSON.parse(JSON.stringify(servers)).__proto__, { type: "stdio", command: "p", args: [], env: {} }, "serialized into --mcp-config");
  await handle.stop();
});

/** A scripted app-server: replies by method; `config/read` answers from a function. */
class ScriptedServer implements AppServerTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  pid = 1;
  private queued: unknown[] = [];
  private waiting: ((value: IteratorResult<unknown>) => void) | null = null;
  private ended = false;
  constructor(private readonly replies: Record<string, (params: unknown) => unknown>) {}
  send(frame: unknown): void {
    const msg = frame as { id?: number; method?: string; params?: unknown };
    this.sent.push(msg as Record<string, unknown>);
    if (msg.id === undefined || !msg.method) return;
    const reply = this.replies[msg.method];
    this.push(reply ? { id: msg.id, result: reply(msg.params) } : { id: msg.id, error: { code: -32601, message: msg.method } });
  }
  push(frame: unknown): void {
    if (this.ended) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: frame, done: false });
    } else this.queued.push(frame);
  }
  get frames(): AsyncIterable<unknown> {
    const next = async (): Promise<IteratorResult<unknown>> => {
      const queued = this.queued.shift();
      if (queued !== undefined) return { value: queued, done: false };
      if (this.ended) return { value: undefined, done: true };
      return new Promise<IteratorResult<unknown>>((resolve) => { this.waiting = resolve; });
    };
    return { [Symbol.asyncIterator]: () => ({ next }) };
  }
  async close(): Promise<void> {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
  }
  calls(method: string) {
    return this.sent.filter((frame) => frame.method === method);
  }
}

const THREAD = { thread: { id: "thread-1", path: "/x/rollout.jsonl", status: { type: "idle" }, turns: [] }, model: "gpt-5", modelProvider: "openai", serviceTier: null, cwd: "/wt", instructionSources: [] };

test("Codex starts on the run's overlay, switches off a foreign server, and verifies before the thread exists", async () => {
  const operator = join(root, "codex-operator");
  mkdirSync(operator, { recursive: true });
  writeFileSync(join(operator, "config.toml"), `model = "gpt-5"\n[mcp_servers.native]\ncommand = "n"\n`);
  process.env.CODEX_HOME = operator;
  let layerReadsAtMint = -1;
  const resident = residentLaunch(
    ["snap", "secret"],
    () => [
      { name: "snap", options: {}, shape: "stdio", command: "s", args: [], env: {} },
      { name: "secret", options: {}, shape: "launcher", command: "/usr/bin/node", args: ["/l.mjs", "--credential", "/run/credentials/minted.json"], env: {} },
    ],
    () => { layerReadsAtMint = reads; },
  );
  const overlay = join(resident.privateDir, "codex-home");
  const overlayConfig = join(overlay, "config.toml");
  let connected: { codexHome?: string } | undefined;
  let reads = 0;
  let configAtThreadStart = "";
  const server = new ScriptedServer({
    initialize: () => ({ userAgent: "scripted" }),
    "config/read": (params) => {
      if ((params as { includeLayers?: boolean }).includeLayers) reads += 1;
      const disabled = readFileSync(overlayConfig, "utf8").includes('[mcp_servers."proj"]\nenabled = false');
      return {
        config: { mcp_servers: { snap: { command: "s" }, secret: {}, "mission-control": {}, proj: { command: "p", ...(disabled ? { enabled: false } : {}) } } },
        layers: [flags, project({ proj: { command: "p" } }), user({ snap: { command: "s" }, secret: {}, ...(disabled ? { proj: { enabled: false } } : {}) })]
          .map((layer) => (layer.name.type === "user" ? { ...layer, name: { type: "user", file: overlayConfig } } : layer)),
      };
    },
    "thread/start": () => {
      configAtThreadStart = readFileSync(overlayConfig, "utf8");
      return THREAD;
    },
    "turn/start": () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } }),
  });
  const spec = codexSdkSpec({
    async connect(_args, _cwd, _stateHome, options) {
      connected = options;
      return server;
    },
  });
  try {
    const handle = await spec.launch(sdkOptions({ residentMcp: resident }));
    assert.equal(connected?.codexHome, overlay, "the app-server runs on the run's private home");
    assert.equal(reads, 3, "read the layers, switch off, read again, then confirm the minted configuration");
    assert.equal(layerReadsAtMint, 2, "credentials are minted only after the layer checks pass");
    assert.ok(configAtThreadStart.includes("/run/credentials/minted.json"), "the thread starts on the minted configuration");
    assert.ok(!configAtThreadStart.includes("unissued"));
    assert.ok(readFileSync(overlayConfig, "utf8").includes('[mcp_servers."proj"]\nenabled = false'));
    assert.ok(!readFileSync(overlayConfig, "utf8").includes("native"));
    const order = server.sent.map((frame) => frame.method).filter(Boolean);
    assert.ok(order.lastIndexOf("config/read") < order.indexOf("thread/start"), "verified before any thread loads a server");
    assert.equal(resident.starts, 1, "one start, one set of credentials, even across the rewrite");
    await handle.stop();
  } finally {
    delete process.env.CODEX_HOME;
  }
});

test("Codex refuses a start another layer would change, before a thread exists", async () => {
  const operator = join(root, "codex-operator-2");
  mkdirSync(operator, { recursive: true });
  process.env.CODEX_HOME = operator;
  const resident = residentLaunch(["snap"], () => [{ name: "snap", options: {}, shape: "stdio", command: "s", args: [], env: {} }]);
  const overlayConfig = join(resident.privateDir, "codex-home", "config.toml");
  const server = new ScriptedServer({
    initialize: () => ({}),
    "config/read": () => ({
      config: { mcp_servers: { snap: { command: "s", env: { INJECT: "1" } } } },
      layers: [flags, project({ snap: { env: { INJECT: "1" } } }), { name: { type: "user", file: overlayConfig }, config: { mcp_servers: { snap: { command: "s" } } } }],
    }),
    "thread/start": () => THREAD,
  });
  try {
    await assert.rejects(
      codexSdkSpec({ connect: async () => server }).launch(sdkOptions({ residentMcp: resident })),
      /cannot be pinned: the project configuration \/repo\/\.codex also defines the resident's MCP server snap/,
    );
    assert.equal(server.calls("thread/start").length, 0);
  } finally {
    delete process.env.CODEX_HOME;
  }
});

// ---- the scoped launcher, as a real process ----

const LAUNCHER = join(process.cwd(), "src/server/residents/mcp-launcher.ts");

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function runLauncher(credential: string, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", LAUNCHER, "--run", "11111111-1111-4111-8111-111111111111", "--server", "fixture", "--credential", credential], {
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdin && stdout.includes("\n")) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    else child.stdin.end();
  });
}

test("the launcher redeems its ticket once, removes the file, and starts its stdio server with the secret in that server's environment only", async () => {
  const log = join(root, "stdio-env.json");
  const fixture = join(root, "stdio-fixture.mjs");
  writeFileSync(fixture, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify({ env: process.env, argv: process.argv }));\n`);
  const redeemed: unknown[] = [];
  const daemon = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    redeemed.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ definition: { transport: "stdio", command: process.execPath, args: [fixture], env: { FIXTURE_SECRET: SECRET }, cwd: root } }));
  });
  const port = await listen(daemon);
  try {
    const credential = join(root, "cred-stdio.json");
    writeFileSync(credential, JSON.stringify({ ticket: "t".repeat(43), expiresAt: Date.now() + 30_000, redeemUrl: `http://127.0.0.1:${port}/api/residents/mcp/redeem` }), { mode: 0o600 });
    const result = await runLauncher(credential);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(credential), false, "the launcher removed its credential file");
    assert.deepEqual(redeemed, [{ ticket: "t".repeat(43), runId: "11111111-1111-4111-8111-111111111111", server: "fixture" }]);
    const seen = JSON.parse(readFileSync(log, "utf8")) as { env: Record<string, string>; argv: string[] };
    assert.equal(seen.env.FIXTURE_SECRET, SECRET, "the secret reached its own server");
    assert.ok(!seen.argv.join(" ").includes(SECRET), "never as an argument");
    assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), "never in the launcher's output");
  } finally {
    daemon.close();
  }
});

test("a server that fails to start is reported without its private command", async () => {
  // A disposable sentinel inside a command that cannot be spawned, standing in for a global
  // server's private definition.
  const sentinel = `private-command-${crypto.randomUUID()}`;
  const daemon = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ definition: { transport: "stdio", command: join(root, sentinel, "server"), args: [`--root=${sentinel}`], env: { TOKEN: sentinel }, cwd: null } }));
  });
  const port = await listen(daemon);
  try {
    const credential = join(root, "cred-spawn-failure.json");
    writeFileSync(credential, JSON.stringify({ ticket: "f".repeat(43), expiresAt: Date.now() + 30_000, redeemUrl: `http://127.0.0.1:${port}/api/residents/mcp/redeem` }));
    const result = await runLauncher(credential);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /could not start this server's command/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(sentinel), result.stderr);
  } finally {
    daemon.close();
  }
});

test("a missing or expired ticket starts nothing", async () => {
  const missing = await runLauncher(join(root, "no-such-credential.json"));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /credential file is missing/);
  const expired = join(root, "cred-expired.json");
  writeFileSync(expired, JSON.stringify({ ticket: "e".repeat(43), expiresAt: Date.now() - 1, redeemUrl: "http://127.0.0.1:1/api/residents/mcp/redeem" }));
  const late = await runLauncher(expired);
  assert.equal(late.code, 1);
  assert.match(late.stderr, /expired/);
  assert.equal(existsSync(expired), false, "an expired file is removed too");
});

test("the HTTP bridge adds the server's secret headers and query, and answers on stdio", async () => {
  const requests: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const remote = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url ?? "", headers: req.headers });
    const msg = JSON.parse(raw || "{}") as { id?: number };
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1" } } }));
  });
  const remotePort = await listen(remote);
  const daemon = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ definition: { transport: "http", url: `http://127.0.0.1:${remotePort}/mcp?key=${SECRET}`, headers: { "X-Secret": SECRET } } }));
  });
  const port = await listen(daemon);
  try {
    const credential = join(root, "cred-http.json");
    writeFileSync(credential, JSON.stringify({ ticket: "h".repeat(43), expiresAt: Date.now() + 30_000, redeemUrl: `http://127.0.0.1:${port}/api/residents/mcp/redeem` }));
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const result = await runLauncher(credential, `${initialize}\n`);
    const answer = JSON.parse(result.stdout.split("\n")[0]!) as { id: number; result: { serverInfo: { name: string } } };
    assert.equal(answer.id, 1);
    assert.equal(answer.result.serverInfo.name, "remote");
    assert.equal(requests[0]!.headers["x-secret"], SECRET);
    assert.equal(requests[0]!.url, `/mcp?key=${SECRET}`);
    assert.ok(!result.stderr.includes(SECRET));
  } finally {
    remote.closeAllConnections();
    remote.close();
    daemon.close();
  }
});

test("the HTTP bridge follows a redirect only within the configured origin, so no other host gets its headers", async () => {
  const { fetchOnOrigin } = await import("../src/server/residents/mcp-launcher.ts");
  const elsewhere: Array<Record<string, unknown>> = [];
  const other = createServer((req, res) => {
    elsewhere.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const otherPort = await listen(other);
  const seen: Array<{ url: string; method: string; secret: unknown; body: string }> = [];
  const origin = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url ?? "", method: req.method ?? "", secret: req.headers["x-secret"], body });
    if (req.url === "/same") res.writeHead(307, { location: "/mcp" }).end();
    else if (req.url === "/see-other") res.writeHead(303, { location: "/mcp" }).end();
    else if (req.url === "/away") res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/steal` }).end();
    else res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const port = await listen(origin);
  const base = `http://127.0.0.1:${port}`;
  const headers = { "X-Secret": SECRET };
  try {
    const followed = await fetchOnOrigin(base, headers, `${base}/same`, { method: "POST", body: "{\"id\":1}" });
    assert.equal(followed.status, 200);
    assert.deepEqual(seen.map((row) => [row.url, row.method, row.secret, row.body]), [
      ["/same", "POST", SECRET, "{\"id\":1}"],
      ["/mcp", "POST", SECRET, "{\"id\":1}"],
    ], "a 307 within the origin keeps its method, body and headers");
    seen.length = 0;
    await fetchOnOrigin(base, headers, `${base}/see-other`, { method: "POST", body: "{}" });
    assert.deepEqual(seen.map((row) => [row.url, row.method, row.body]), [["/see-other", "POST", "{}"], ["/mcp", "GET", ""]]);
    await assert.rejects(fetchOnOrigin(base, headers, `${base}/away`, { method: "POST", body: "{}" }), /redirected to another origin/);
    await assert.rejects(fetchOnOrigin(base, headers, `http://127.0.0.1:${otherPort}/direct`), /another origin/);
    assert.deepEqual(elsewhere, [], "the other origin received nothing at all");
  } finally {
    origin.close();
    other.close();
  }
});

test("a bridged request redirected off its origin answers with an error, never forwarding the headers", async () => {
  const elsewhere: unknown[] = [];
  const other = createServer((req, res) => {
    elsewhere.push(req.headers);
    res.writeHead(200).end("{}");
  });
  const otherPort = await listen(other);
  const remote = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/mcp` }).end();
  });
  const remotePort = await listen(remote);
  const daemon = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ definition: { transport: "http", url: `http://127.0.0.1:${remotePort}/mcp`, headers: { "X-Secret": SECRET } } }));
  });
  const port = await listen(daemon);
  try {
    const credential = join(root, "cred-redirect.json");
    writeFileSync(credential, JSON.stringify({ ticket: "d".repeat(43), expiresAt: Date.now() + 30_000, redeemUrl: `http://127.0.0.1:${port}/api/residents/mcp/redeem` }));
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const result = await runLauncher(credential, `${initialize}\n`);
    const answer = JSON.parse(result.stdout.split("\n")[0]!) as { id: number; error?: { message: string } };
    assert.equal(answer.id, 7);
    assert.match(answer.error?.message ?? "", /redirected to another origin/);
    assert.deepEqual(elsewhere, []);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
  } finally {
    remote.close();
    other.close();
    daemon.close();
  }
});

test("the launcher refuses to send credentials over plain http to another host, before any request", async () => {
  const daemon = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ definition: { transport: "http", url: "http://mcp.example.invalid/mcp?key=q", headers: { "X-Secret": SECRET } } }));
  });
  const port = await listen(daemon);
  try {
    const credential = join(root, "cred-plaintext.json");
    writeFileSync(credential, JSON.stringify({ ticket: "p".repeat(43), expiresAt: Date.now() + 30_000, redeemUrl: `http://127.0.0.1:${port}/api/residents/mcp/redeem` }));
    const result = await runLauncher(credential);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to send this server's credentials over plain http to another host/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
  } finally {
    daemon.close();
  }
});

test("the configured query rides every bridged request once, on the server's own endpoint and after a redirect", async () => {
  const { fetchOnOrigin } = await import("../src/server/residents/mcp-launcher.ts");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url?.startsWith("/moved")) res.writeHead(307, { location: "/messages" }).end();
    else res.writeHead(200).end("{}");
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const query = new URLSearchParams({ key: SECRET });
  try {
    await fetchOnOrigin(base, {}, `${base}/messages?session=1`, { method: "POST", body: "{}" }, query);
    await fetchOnOrigin(base, {}, `${base}/sse?key=${SECRET}`, {}, query);
    await fetchOnOrigin(base, {}, `${base}/messages?key=old&session=2&key=older`, { method: "POST", body: "{}" }, query);
    await fetchOnOrigin(base, {}, `${base}/moved?key=stale`, { method: "POST", body: "{}" }, query);
    assert.deepEqual(seen, [
      `/messages?session=1&key=${SECRET}`,
      `/sse?key=${SECRET}`,
      `/messages?key=${SECRET}&session=2`,
      `/moved?key=${SECRET}`,
      `/messages?key=${SECRET}`,
    ], "the configured value replaces an endpoint's own, once, on every request including a redirect");
  } finally {
    server.close();
  }
});
