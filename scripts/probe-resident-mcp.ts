/**
 * Real-installation probe for resident MCP pinning and secret scope
 * (`HARNESS_CAPABILITIES[agent].mcpSelection`). Run:
 *
 *   npm run build:resident-mcp-launcher && node --import tsx scripts/probe-resident-mcp.ts
 *
 * Drives the PRODUCTION drivers (`claudeSdkSpec`, `codexSdkSpec`) against the real `claude` and
 * `codex` binaries, with every home, configuration and state directory disposable and both model
 * APIs answered by loopback mocks, so no model token is spent and no operator configuration is
 * read or written. Every agent environment is built from scratch here; nothing inherits the
 * operator's.
 *
 * What it measures, per harness, at launch and again on resume:
 *
 * - Exact set: fixture MCP servers that record their own start are placed in every native
 *   source a fixture can reach (Claude: user, local, project and plugin; Codex: user and a
 *   trusted project). Only Mission's server and the run's snapshot may start, each with its
 *   snapshot definition; a server added natively after launch, and fields added to a snapshot
 *   server's native entry, never reach the resume.
 * - Codex refusals: a project layer that adds a field to a snapshot server, or forces a server
 *   on, refuses the launch before any thread loads a server.
 * - Secret scope: sentinel secrets on a stdio and an HTTP server, both through the scoped
 *   launcher, and the launch tickets themselves. Each secret must reach only its own server;
 *   neither kind may appear in any process argument of this probe's own descendants, the agent's
 *   environment, a shell command the agent runs, another server's environment, the generated
 *   configuration, the transcript or the logs. Tickets may appear only in their credential files,
 *   which must be gone after the start.
 *
 * Output is pass/fail facts only: never an environment, an argument list or a value.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mission-mcp-probe-"));
const freePort = await new Promise<number>((resolve) => {
  const probe = createNetServer().listen(0, "127.0.0.1", () => {
    const port = (probe.address() as { port: number }).port;
    probe.close(() => resolve(port));
  });
});
// Disposable Mission state and the daemon's loopback port, BEFORE anything reaches config.ts.
process.env.MISSION_HOME = join(root, "state");
mkdirSync(process.env.MISSION_HOME, { recursive: true });
process.env.MISSION_PORT = String(freePort);
const launcherBundle = join(process.cwd(), "dist/satellites/resident-mcp-launcher.mjs");
if (!existsSync(launcherBundle)) throw new Error("build the launcher first: npm run build:resident-mcp-launcher");
process.env.MISSION_RESIDENT_MCP_LAUNCHER = launcherBundle;

const logs: string[] = [];
for (const method of ["log", "warn", "error"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    if (method !== "log") original(...args.map((arg) => (typeof arg === "string" ? arg.slice(0, 200) : "[object]")));
  };
}
const say = (fact: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(fact)}\n`);
};

const { initializeExecutableEnvironment, locateExecutable } = await import("../src/server/executables/locator.ts");
await initializeExecutableEnvironment();
const claude = await locateExecutable("claude");
const codex = await locateExecutable("codex");
if (!claude || !codex) throw new Error("This probe requires real Claude Code and Codex installations.");
for (const [harness, executable] of [["claude", claude.path], ["codex", codex.path]] as const) {
  const versionHome = join(root, `version-${harness}`);
  mkdirSync(join(versionHome, ".codex"), { recursive: true });
  say({
    harness,
    version: execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: versionHome, CODEX_HOME: join(versionHome, ".codex"), CLAUDE_CONFIG_DIR: join(versionHome, ".claude") },
    }).trim(),
    executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  });
}

const { openDb } = await import("../src/server/db.ts");
const store = await import("../src/server/residents/mcp-store.ts");
const { residentMcpLaunchForRun, redeemResidentMcpTicket } = await import("../src/server/residents/mcp-launch.ts");
const { RedeemResidentMcpTicketSchema } = await import("../src/shared/resident-mcp.ts");
const { claudeSdkSpec } = await import("../src/server/harness/claude/sdk.ts");
const { defaultClaudeSdkDeps } = await import("../src/server/harness/claude/sdk-deps.ts");
const { codexSdkSpec } = await import("../src/server/harness/codex/sdk.ts");
const { spawnAppServer } = await import("../src/server/harness/codex/sdk-deps.ts");
type Launch = NonNullable<ReturnType<typeof residentMcpLaunchForRun>>;
type Handle = Awaited<ReturnType<ReturnType<typeof claudeSdkSpec>["launch"]>>;

// ---- fixtures ----

const startsLog = join(root, "starts.jsonl");
const httpLog = join(root, "http.jsonl");
const stdioFixture = join(root, "fixture-stdio.mjs");
writeFileSync(stdioFixture, `
import { appendFileSync } from "node:fs";
const [log, name] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ name, pid: process.pid, argv: process.argv.slice(2), env: process.env }) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result = msg.method === "initialize"
      ? { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1" } }
      : msg.method === "tools/list" ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`);

/** A streamable-HTTP MCP fixture recording the URL and headers of every request it receives. */
const httpFixture: Server = createServer(async (req: IncomingMessage, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  writeFileSync(httpLog, `${JSON.stringify({ url: req.url, headers: req.headers })}\n`, { flag: "a" });
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const msg = JSON.parse(raw || "{}") as { id?: number | string; method?: string; params?: { protocolVersion?: string } };
  if (msg.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result = msg.method === "initialize"
    ? { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
    : msg.method === "tools/list" ? { tools: [] } : {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
await new Promise<void>((resolve) => httpFixture.listen(0, "127.0.0.1", resolve));
const httpPort = (httpFixture.address() as { port: number }).port;

/** The daemon's redemption route, served by the production redemption function. */
const redeemServer: Server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.method !== "POST" || req.url !== "/api/residents/mcp/redeem") {
    res.writeHead(404).end();
    return;
  }
  const parsed = RedeemResidentMcpTicketSchema.safeParse(JSON.parse(raw || "{}"));
  if (!parsed.success) {
    res.writeHead(400).end("{}");
    return;
  }
  const redeemed = redeemResidentMcpTicket(parsed.data);
  res.writeHead(redeemed.ok ? 200 : redeemed.status, { "content-type": "application/json" })
    .end(JSON.stringify(redeemed.ok ? { definition: redeemed.definition } : { error: redeemed.error }));
});
await new Promise<void>((resolve) => redeemServer.listen(freePort, "127.0.0.1", resolve));

const sentinel = (label: string): string => `mcp-probe-${label}-${randomBytes(12).toString("hex")}`;
const secrets = {
  stdio: sentinel("stdio-env"),
  header: sentinel("http-header"),
  query: sentinel("http-query"),
  global: sentinel("global-env"),
};
const tickets: string[] = [];

const fixture = (name: string) => ({ command: process.execPath, args: [stdioFixture, startsLog, name] });
const starts = (): Array<{ name: string; env: Record<string, string> }> =>
  existsSync(startsLog)
    ? readFileSync(startsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { name: string; env: Record<string, string> })
    : [];
const httpRequests = (): Array<{ url: string; headers: Record<string, string> }> =>
  existsSync(httpLog) ? readFileSync(httpLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const reset = (): void => {
  rmSync(startsLog, { force: true });
  rmSync(httpLog, { force: true });
};

/** Seed one open run and its snapshot through the production store. */
function seedRun(runId: string): void {
  const d = openDb();
  d.prepare(
    `INSERT INTO resident_runs (id, profile_id, profile_revision, task_id, launch_request_id, launch_input,
       launch_state, persona_snapshot, created_at) VALUES (?, 'probe', 1, ?, ?, '{}', 'launched', '{}', ?)`,
  ).run(runId, `task-${runId}`, `req-${runId}`, Date.now());
  const plain = fixture("snap");
  const dotted = fixture("foo.bar");
  const secretStdio = fixture("secret-stdio");
  const global = fixture("global-stdio");
  store.writeRunMcpSnapshot(runId, [
    { source: "custom", name: "snap", transport: { type: "stdio", ...plain, env: { PLAIN: "visible" }, secretEnv: [], cwd: null }, launcher: false, options: {}, secrets: new Map() },
    { source: "custom", name: "foo.bar", transport: { type: "stdio", ...dotted, env: {}, secretEnv: [], cwd: null }, launcher: false, options: {}, secrets: new Map() },
    {
      source: "custom", name: "secret-stdio",
      transport: { type: "stdio", ...secretStdio, env: {}, secretEnv: ["PROBE_SECRET"], cwd: null },
      launcher: true, options: {}, secrets: new Map([["env:PROBE_SECRET", secrets.stdio]]),
    },
    {
      source: "custom", name: "secret-http",
      transport: { type: "http", url: `http://127.0.0.1:${httpPort}/mcp`, headers: {}, secretHeaders: ["X-Probe-Secret"], secretQuery: ["key"] },
      launcher: true, options: {}, secrets: new Map([["header:X-Probe-Secret", secrets.header], ["query:key", secrets.query]]),
    },
    {
      source: "global", name: "global-stdio",
      transport: { type: "stdio", ...global, env: {}, secretEnv: ["GLOBAL_SECRET"], cwd: null },
      launcher: true, options: {}, secrets: new Map([["env:GLOBAL_SECRET", secrets.global]]),
    },
  ], Date.now());
}

/** The run's launch, recording each start's tickets so their reach can be checked too. */
function observedLaunch(runId: string): Launch {
  const launch = residentMcpLaunchForRun(runId);
  assert.ok(launch, "the run has a snapshot");
  return {
    ...launch,
    forStart: () => {
      const entries = launch.forStart();
      for (const entry of entries) {
        if (entry.shape !== "launcher") continue;
        const path = entry.args[entry.args.indexOf("--credential") + 1]!;
        assert.equal(statSync(path).mode & 0o777, 0o600, "a credential file is owner-only");
        tickets.push((JSON.parse(readFileSync(path, "utf8")) as { ticket: string }).ticket);
      }
      return entries;
    },
  };
}

const SNAPSHOT_SERVERS = ["foo.bar", "global-stdio", "mission-control", "secret-stdio", "snap"];

/** Only this probe's own descendants, by pid and parent alone; then just their argv. */
function descendantArgs(): string[] {
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 2 && row.every(Number.isFinite));
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
  const mine: number[] = [];
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      mine.push(child);
      walk(child);
    }
  };
  walk(process.pid);
  if (mine.length === 0) return [];
  try {
    return execFileSync("ps", ["-ww", "-o", "args=", "-p", mine.join(",")], { encoding: "utf8" }).split("\n");
  } catch {
    return [];
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Every artifact a secret or ticket must stay out of, checked without printing any of it. */
function leaks(label: string, artifacts: Record<string, string>): void {
  const all = [...Object.values(secrets), ...tickets];
  for (const [where, text] of Object.entries(artifacts)) {
    const found = all.filter((value) => text.includes(value)).length;
    say({ check: `${label}: no secret or ticket in ${where}`, pass: found === 0 });
    assert.equal(found, 0, `${label}: a secret or ticket reached ${where}`);
  }
}

function serverEnvChecks(label: string): void {
  const rows = starts();
  const own: Record<string, string> = { "secret-stdio": secrets.stdio, "global-stdio": secrets.global };
  for (const row of rows) {
    const env = JSON.stringify(row.env);
    const others = Object.values(secrets).filter((value) => value !== own[row.name]);
    const reachesOwn = own[row.name] ? env.includes(own[row.name]!) : true;
    const leaked = others.some((value) => env.includes(value)) || tickets.some((ticket) => env.includes(ticket));
    say({ check: `${label}: ${row.name} has its own secret and no other`, pass: reachesOwn && !leaked });
    assert.ok(reachesOwn, `${label}: ${row.name} did not receive its own secret`);
    assert.ok(!leaked, `${label}: ${row.name} received another server's secret or a ticket`);
  }
  const requests = httpRequests();
  const http = requests.length > 0
    && requests.every((request) => request.headers["x-probe-secret"] === secrets.header && request.url.includes(`key=${secrets.query}`));
  say({ check: `${label}: the HTTP server received its secret header and query through the bridge`, pass: http, requests: requests.length });
  assert.ok(http, `${label}: the HTTP fixture did not receive its secrets`);
}

async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Read events until a turn completes, without closing the handle's stream. */
async function nextTurnDone(handle: Handle): Promise<string | null> {
  let bound: string | null = null;
  const events = handle.events[Symbol.asyncIterator]();
  for (;;) {
    const next = await events.next();
    if (next.done) return bound;
    const event = next.value;
    if (event.kind === "bound") bound = event.agentSessionId;
    if (event.kind === "turn_done") return bound;
    if (event.kind === "exited") throw new Error(`the session exited: ${event.reason}`);
  }
}

/** A shell command whose OUTPUT carries a marker its text does not, so a run is observable. */
const shellCommand = (phase: string): string => `env; echo PROBE_SHELL_$((40+2))_${phase}`;
const shellRanIn = (bodies: readonly string[], phase: string): boolean =>
  bodies.some((body) => body.includes(`PROBE_SHELL_42_${phase}`));

/** A Mission server stand-in: a fixture under Mission's name, attached the production way. */
const missionDescriptor = { serverName: "mission-control", ...fixture("mission-control"), env: {} };

// ---- Claude Code ----

async function probeClaude(): Promise<void> {
  const home = join(root, "claude-home");
  const config = join(home, ".claude");
  const repo = join(root, "claude-repo");
  const plugin = join(root, "claude-plugin");
  for (const dir of [config, join(repo, ".git"), join(plugin, ".claude-plugin")]) mkdirSync(dir, { recursive: true });
  const native = (extra: Record<string, unknown> = {}) => ({
    hasCompletedOnboarding: true,
    mcpServers: {
      "native-user": { type: "stdio", ...fixture("native-user") },
      // A snapshot server's NATIVE entry: the run must start the snapshot's definition instead.
      snap: { type: "stdio", ...fixture("snap"), env: { NATIVE_FIELD: "native" } },
      ...extra,
    },
    projects: { [repo]: { hasTrustDialogAccepted: true, mcpServers: { "native-local": { type: "stdio", ...fixture("native-local") } } } },
  });
  writeFileSync(join(config, ".claude.json"), JSON.stringify(native()));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { "native-project": { type: "stdio", ...fixture("native-project") } } }));
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "probeplug", mcpServers: { "native-plugin": { type: "stdio", ...fixture("native-plugin") } } }));

  let bodies: string[] = [];
  let phaseName = "launch";
  let toolSent = false;
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean; tools?: Array<{ name?: string }> };
    if (req.url?.includes("count_tokens")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ input_tokens: 20 }));
      return;
    }
    bodies.push(raw);
    // Each phase's first agent request asks for a shell command, so its output - the shell's
    // environment - comes back in the next request, where it can be checked.
    const tool = !toolSent && (body.tools ?? []).some((candidate) => candidate.name === "Bash");
    if (tool) toolSent = true;
    const content = tool
      ? { type: "tool_use", id: `probe-${phaseName}-${bodies.length}`, name: "Bash", input: { command: shellCommand(phaseName), description: "probe" } }
      : { type: "text", text: "PROBE_DONE" };
    const msg = { id: "msg-probe", type: "message", role: "assistant", model: body.model, content: [content], stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 } };
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(msg));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    const emit = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("message_start", { message: { ...msg, content: [], stop_reason: null } });
    emit("content_block_start", { index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify((content as { input: unknown }).input) } : { type: "text_delta", text: "PROBE_DONE" } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
    emit("message_stop", {});
    res.end();
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelPort = (model.address() as { port: number }).port;
  const agentEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    ANTHROPIC_API_KEY: "probe-local-only",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
  };
  const spec = claudeSdkSpec({
    ...defaultClaudeSdkDeps,
    executable: async () => claude!.path,
    env: () => ({ ...agentEnv }),
    // The plugin source an installed plugin would contribute, injected beside the production options.
    query: (params) => defaultClaudeSdkDeps.query({ ...params, options: { ...params.options, plugins: [{ type: "local", path: plugin }] } as never }),
  });
  const runId = "00000000-0000-4000-8000-00000000c1a0";
  seedRun(runId);
  const options = (resume: string | null) => ({
    cwd: repo,
    stateHome: join(root, "claude-state"),
    prompt: resume ? "" : "Run the probe.",
    model: "sonnet",
    effort: null,
    permissionMode: "bypassPermissions" as const,
    mcp: missionDescriptor,
    residentMcp: observedLaunch(runId),
    extraDirs: [],
    standingInstructions: "",
    standingInstructionsPrompt: "",
    resume,
  });
  try {
    for (const phase of ["launch", "resume"] as const) {
      reset();
      bodies = [];
      phaseName = phase;
      toolSent = false;
      const handle: Handle = await spec.launch(options(phase === "resume" ? sessionId! : null));
      if (phase === "resume") await handle.send({ text: "Run the probe again." });
      const bound = await nextTurnDone(handle);
      if (phase === "launch") sessionId = bound;
      await until(() => new Set(starts().map((row) => row.name)).size >= SNAPSHOT_SERVERS.length && httpRequests().length > 0, 20_000, "the snapshot servers to start");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const started = [...new Set(starts().map((row) => row.name))].sort();
      say({ harness: "claude", phase, check: "exactly Mission's server and the snapshot started", pass: JSON.stringify(started) === JSON.stringify(SNAPSHOT_SERVERS), started });
      assert.deepEqual(started, SNAPSHOT_SERVERS);
      const snap = starts().find((row) => row.name === "snap")!;
      say({ harness: "claude", phase, check: "the snapshot server ran its snapshot definition, not the native one", pass: snap.env.PLAIN === "visible" && snap.env.NATIVE_FIELD === undefined });
      assert.equal(snap.env.NATIVE_FIELD, undefined);
      serverEnvChecks(`claude ${phase}`);
      if (!shellRanIn(bodies, phase)) await until(() => shellRanIn(bodies, phase), 15_000, "the shell command's output").catch(() => {});
      const shellRan = shellRanIn(bodies, phase);
      say({ harness: "claude", phase, check: "the agent ran a shell command whose output was captured", pass: shellRan, requests: bodies.length, toolSent });
      assert.ok(shellRan, "the shell command did not run");
      leaks(`claude ${phase}`, {
        "process arguments": descendantArgs().join("\n"),
        "the agent environment": JSON.stringify(agentEnv),
        "the shell command's environment and every model request": bodies.join("\n"),
        transcripts: filesUnder(join(config, "projects")).map((path) => readFileSync(path, "utf8")).join("\n"),
        logs: logs.join("\n"),
      });
      const leftover = filesUnder(join(process.env.MISSION_HOME!, "residents", "mcp", runId, "credentials"));
      say({ harness: "claude", phase, check: "every credential file was removed by its launcher", pass: leftover.length === 0 });
      assert.equal(leftover.length, 0);
      await handle.stop();
      if (phase === "launch") {
        // After launch: a new native server, and new fields on a snapshot server's native entry.
        writeFileSync(join(config, ".claude.json"), JSON.stringify(native({
          "native-added": { type: "stdio", ...fixture("native-added") },
          snap: { type: "stdio", ...fixture("snap"), args: [stdioFixture, startsLog, "snap", "--native-arg"], env: { NATIVE_FIELD: "native", ADDED: "1" } },
        })));
      }
    }
  } finally {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
}
let sessionId: string | null = null;

// ---- Codex ----

async function probeCodex(): Promise<void> {
  const home = join(root, "codex-home");
  const nativeHome = join(home, ".codex");
  const repo = join(root, "codex-repo");
  for (const dir of [nativeHome, join(repo, ".codex"), join(repo, ".git")]) mkdirSync(dir, { recursive: true });
  process.env.CODEX_HOME = nativeHome;
  let bodies: string[] = [];
  let shellTool: string | null = null;
  let phaseName = "launch";
  let toolSent = false;
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) {
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    bodies.push(raw);
    const body = JSON.parse(raw) as { tools?: Array<{ name?: string; type?: string }>; input?: unknown };
    const names = (body.tools ?? []).map((tool) => tool.name ?? tool.type ?? "");
    shellTool ??= ["exec_command", "shell_command", "shell"].find((name) => names.includes(name)) ?? null;
    const call = !toolSent && shellTool;
    if (call) toolSent = true;
    const command = shellCommand(phaseName);
    const args = shellTool === "exec_command" ? { cmd: command } : shellTool === "shell_command" ? { command } : { command: ["/bin/sh", "-c", command] };
    const item = call
      ? { id: "fc-probe", type: "function_call", status: "completed", call_id: `call-${phaseName}-${bodies.length}`, name: shellTool, arguments: JSON.stringify(args) }
      : { id: "msg-probe", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "PROBE_DONE", annotations: [] }] };
    res.setHeader("content-type", "text/event-stream");
    const emit = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("response.created", { response: { id: "resp-probe", status: "in_progress", output: [] } });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id: "resp-probe", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
    res.end();
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelPort = (model.address() as { port: number }).port;
  const toml = (name: string): string => `command = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([stdioFixture, startsLog, name])}\n`;
  const nativeConfig = (extra = ""): string => [
    `model = "gpt-5.4"`,
    `model_provider = "probe"`,
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    `[model_providers.probe]`,
    `name = "probe"`,
    `base_url = "http://127.0.0.1:${modelPort}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `[projects.${JSON.stringify(repo)}]`,
    `trust_level = "trusted"`,
    `[mcp_servers.native-user]`,
    toml("native-user"),
    // A snapshot server's NATIVE entry, which the overlay must never carry.
    `[mcp_servers.snap]`,
    toml("snap") + `env = { NATIVE_FIELD = "native" }`,
    extra,
  ].join("\n");
  writeFileSync(join(nativeHome, "config.toml"), nativeConfig());
  writeFileSync(join(nativeHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "probe-local-only" }));
  writeFileSync(join(nativeHome, "AGENTS.md"), "PROBE_USER_INSTRUCTIONS\n");
  writeFileSync(join(repo, ".codex/config.toml"), `[mcp_servers."native.project"]\n${toml("native.project")}`);
  const agentEnvs: Array<Record<string, string | undefined>> = [];
  const spec = codexSdkSpec({
    async connect(args, cwd, _stateHome, options) {
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: options?.codexHome ?? nativeHome };
      agentEnvs.push(env);
      return spawnAppServer(codex!.path, args, cwd, env);
    },
  });
  const runId = "00000000-0000-4000-8000-00000000c0de";
  seedRun(runId);
  const overlay = join(process.env.MISSION_HOME!, "residents", "mcp", runId, "codex-home");
  const options = (resume: string | null) => ({
    cwd: repo,
    stateHome: join(root, "codex-state"),
    prompt: resume ? "" : "Run the probe.",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: missionDescriptor,
    residentMcp: observedLaunch(runId),
    extraDirs: [],
    standingInstructions: "",
    standingInstructionsPrompt: "",
    resume,
  });
  let threadId: string | null = null;
  try {
    for (const phase of ["launch", "resume"] as const) {
      reset();
      bodies = [];
      phaseName = phase;
      toolSent = false;
      const handle = await spec.launch(options(phase === "resume" ? threadId : null));
      if (phase === "resume") await handle.send({ text: "Run the probe again." });
      const bound = await nextTurnDone(handle);
      if (phase === "launch") threadId = bound;
      await until(() => new Set(starts().map((row) => row.name)).size >= SNAPSHOT_SERVERS.length && httpRequests().length > 0, 20_000, "the snapshot servers to start");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const started = [...new Set(starts().map((row) => row.name))].sort();
      say({ harness: "codex", phase, check: "exactly Mission's server and the snapshot started", pass: JSON.stringify(started) === JSON.stringify(SNAPSHOT_SERVERS), started });
      assert.deepEqual(started, SNAPSHOT_SERVERS);
      const snap = starts().find((row) => row.name === "snap")!;
      say({ harness: "codex", phase, check: "the snapshot server ran its snapshot definition, not the native one", pass: snap.env.PLAIN === "visible" && snap.env.NATIVE_FIELD === undefined });
      assert.equal(snap.env.NATIVE_FIELD, undefined);
      serverEnvChecks(`codex ${phase}`);
      const shellRan = shellTool !== null && shellRanIn(bodies, phase);
      say({ harness: "codex", phase, check: "the agent ran a shell command whose output was captured", pass: shellRan, tool: shellTool });
      assert.ok(shellRan, "the shell command did not run");
      const generated = readFileSync(join(overlay, "config.toml"), "utf8");
      const mode = statSync(join(overlay, "config.toml")).mode & 0o777;
      say({ harness: "codex", phase, check: "the generated config.toml is owner-only and holds no native MCP server", pass: mode === 0o600 && !generated.includes("native-user") && !generated.includes("NATIVE_FIELD") });
      assert.equal(mode, 0o600);
      assert.ok(!generated.includes("native-user") && !generated.includes("NATIVE_FIELD"));
      const { lstatSync, readlinkSync } = await import("node:fs");
      const linked = ["auth.json", "AGENTS.md", "sessions"].every((name) =>
        lstatSync(join(overlay, name)).isSymbolicLink() && readlinkSync(join(overlay, name)) === join(nativeHome, name));
      const instructions = bodies.some((body) => body.includes("PROBE_USER_INSTRUCTIONS"));
      say({ harness: "codex", phase, check: "the overlay keeps authentication, user instructions and the session files, linked to the operator's home", pass: linked && instructions });
      assert.ok(linked && instructions);
      const strayDatabases = readdirSync(overlay, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.sqlite/.test(entry.name)).map((entry) => entry.name);
      say({ harness: "codex", phase, check: "no Codex database was created inside the overlay instead of the operator's home", pass: strayDatabases.length === 0, strayDatabases });
      assert.equal(strayDatabases.length, 0, "a Codex database was created inside the overlay");
      leaks(`codex ${phase}`, {
        "process arguments": descendantArgs().join("\n"),
        "the agent environment": JSON.stringify(agentEnvs),
        "the shell command's environment and every model request": bodies.join("\n"),
        "the generated configuration": generated,
        transcripts: filesUnder(join(nativeHome, "sessions")).map((path) => readFileSync(path, "utf8")).join("\n"),
        logs: logs.join("\n"),
      });
      const leftover = filesUnder(join(process.env.MISSION_HOME!, "residents", "mcp", runId, "credentials"));
      say({ harness: "codex", phase, check: "every credential file was removed by its launcher", pass: leftover.length === 0 });
      assert.equal(leftover.length, 0);
      await handle.stop();
      if (phase === "launch") {
        writeFileSync(join(nativeHome, "config.toml"), nativeConfig(`[mcp_servers.native-added]\n${toml("native-added")}`).replace(
          `env = { NATIVE_FIELD = "native" }`,
          `env = { NATIVE_FIELD = "native", ADDED = "1" }\nstartup_timeout_sec = 9`,
        ));
      }
    }
    // A project layer that adds a field to a snapshot server, or forces a foreign server on,
    // must refuse the start before any thread loads a server.
    for (const [label, project] of [
      ["adds a field to a snapshot server", `[mcp_servers.snap]\nenv = { INJECT = "project" }\n`],
      ["forces a foreign server on", `[mcp_servers.forced]\n${toml("forced")}enabled = true\n`],
    ] as const) {
      reset();
      writeFileSync(join(repo, ".codex/config.toml"), project);
      let refused: string | null = null;
      try {
        const handle = await spec.launch(options(null));
        await handle.stop();
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      const nothing = starts().length === 0;
      say({ harness: "codex", check: `a project layer that ${label} refuses the launch before any server starts`, pass: refused !== null && nothing });
      assert.ok(refused && nothing, label);
    }
  } finally {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
}

try {
  await probeClaude();
  await probeCodex();
  say({ result: "pass", note: "Both harnesses started exactly their snapshot plus Mission's server, at launch and on resume, and every secret reached only its own server." });
} finally {
  httpFixture.closeAllConnections();
  redeemServer.closeAllConnections();
  httpFixture.close();
  redeemServer.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(0);
