import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mcpFixtureSpawns, writeMcpFixture } from "./helpers/mcp-fixture.ts";
import { pipelineCredentialFromDescriptor } from "./helpers/pipeline-credential.ts";

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
  missionMcpDescriptorForPipelineTask,
  missionMcpPaths,
  missionMcpProductIssueClient,
  resolveMissionMcpRuntime,
  missionMcpToolName,
  verifyMissionMcpTools,
  verifyMissionMcpToolsForRunningSession,
} = await import("../src/server/mission-mcp.ts");
const { PRODUCT_ISSUE_CLIENT_ENV } = await import("../src/shared/product-issues.ts");
const { PIPELINE_CALLER_CREDENTIAL_FILE_ENV } = await import("../src/shared/pipeline.ts");
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
  assert.equal(
    d.env[PRODUCT_ISSUE_CLIENT_ENV],
    "browser",
    "the Node daemon tells its external MCP child which dashboard client launched it",
  );
  assert.notEqual(d.env.MISSION_HOME, join(home, "state"));
  assert.ok(statSync(d.env.MISSION_HOME!).isDirectory(), "the MCP child receives a disposable state home");
  assert.equal(d.env.MISSION_PORT, "7317");
  // The agent launches this as an EXTERNAL process, so a bare `node` off the spawned
  // shell's PATH is not good enough.
  assert.ok(d.command.startsWith("/"), `runtime should be absolute, got ${d.command}`);
});

test("a located Node runtime keeps the locator-owned child environment", async () => {
  const runtime = await resolveMissionMcpRuntime(
    "/Applications/Mission Control.app/Contents/MacOS/Mission Control",
    async () => ({
      path: "/custom/node/bin/node",
      env: { PATH: "/custom/node/bin", NODE_OPTIONS: "--require=/custom/register.cjs" },
    }),
  );
  assert.deepEqual(runtime, {
    command: "/custom/node/bin/node",
    env: { PATH: "/custom/node/bin", NODE_OPTIONS: "--require=/custom/register.cjs" },
  });
});

test("Pipeline task scoping clones the descriptor and puts its capability in a private file", () => {
  const descriptor = {
    serverName: "mission-control",
    command: "/usr/bin/node",
    args: ["/dist/mcp/server.mjs"],
    env: { MISSION_HOME: home },
  };
  const scoped = missionMcpDescriptorForPipelineTask(
    descriptor,
    "pipeline-caller-credential",
  );
  assert.notEqual(scoped, descriptor);
  assert.notEqual(scoped?.args, descriptor.args);
  assert.notEqual(scoped?.env, descriptor.env);
  assert.equal(scoped?.env.MISSION_HOME, home);
  assert.match(scoped?.env[PIPELINE_CALLER_CREDENTIAL_FILE_ENV] ?? "", /pipeline-caller-[0-9a-f]+\.json$/);
  assert.equal(pipelineCredentialFromDescriptor(scoped), "pipeline-caller-credential");
  assert.deepEqual(descriptor.env, { MISSION_HOME: home });
});

test("the launch descriptor preserves Electron client context across the Node child boundary", () => {
  assert.equal(missionMcpProductIssueClient("43.0.0"), "electron");
  assert.equal(missionMcpProductIssueClient(undefined), "browser");
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

test("create_task publishes bounded repository selectors and never falls back to legacy", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
  const start = source.indexOf('server.registerTool(\n  "create_task"');
  const end = source.indexOf("// This is the replacement", start);
  assert.ok(start >= 0 && end > start, "the create_task registration is present");
  const registration = source.slice(start, end);

  assert.match(registration, /repository: z/);
  assert.match(registration, /additionalRepositories: z/);
  assert.match(registration, /\.max\(MAX_TASK_EXTRA_REPOS\)/);
  assert.match(
    registration,
    /repository !== undefined \|\| Boolean\(additionalRepositories\?\.length\)/,
    "an explicitly empty attachment list keeps the legacy current-repository route",
  );
  assert.match(registration, /explicitRepositories \? "\/mcp\/v2\/tasks" : "\/mcp\/tasks"/);
  assert.match(registration, /targetRepository: repository/);
  assert.match(registration, /res\.status === 404/);
  assert.match(registration, /no task was created/);
  assert.doesNotMatch(
    registration,
    /res\.status === 404[\s\S]*http\("\/mcp\/tasks"/,
    "a selector-bearing call must not be retried after an old daemon's 404",
  );
  assert.match(registration, /repository: task\.repoRoot/);
  assert.match(registration, /additionalRepositories: task\.extraRepos\.map/);
});

test("product issue registration requires public confirmation and bounded attachment ids", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
  const start = source.indexOf('server.registerTool(\n  "report_product_issue"');
  const end = source.indexOf('server.registerTool(\n  "report_status"', start);
  assert.ok(start >= 0 && end > start, "report_product_issue registration is present");
  const registration = source.slice(start, end);
  assert.match(registration, /only after the user explicitly/);
  assert.match(registration, /public GitHub issue/);
  assert.match(registration, /Submit public issue/);
  assert.match(registration, /Optional screenshot/);
  assert.match(registration, /inputSchema: ProductIssueDraftSchema\.shape/);
  assert.match(registration, /\.\.\.productIssueTransport/);
  assert.match(registration, /PRODUCT_ISSUE_CLIENT/);
  assert.doesNotMatch(
    registration,
    /process\.versions\.electron/,
    "the external MCP child cannot infer whether its dashboard owner is Electron",
  );
});

test("submit_workflow_evidence exposes bounded evidence and criterion coverage", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
  const registration = source.slice(
    source.indexOf('server.registerTool(\n  "submit_workflow_evidence"'),
    source.indexOf("// Submit this scout's finished report"),
  );
  assert.match(registration, /artifacts: z\.array\(z\.object/);
  assert.match(registration, /WORKFLOW_TEXT_EVIDENCE_LIMITS\.maxCount/);
  assert.match(registration, /WORKFLOW_TEXT_EVIDENCE_LIMITS\.locatorJsonBytes/);
  assert.match(registration, /commandOutputs: z\.array\(z\.object/);
  assert.match(registration, /workflowCommandEvidenceContent/);
  assert.match(registration, /coverage: z\.array\(z\.object/);
  assert.match(registration, /WORKFLOW_EVIDENCE_PROOF_CLASSES/);
  assert.match(registration, /WORKFLOW_EVIDENCE_PROOF_ROLES/);
  assert.match(registration, /unique by evidence item and proof role/);
  assert.match(registration, /submitWorkflowEvidenceToDaemon/);
  assert.match(registration, /exact command, exit/);
  assert.match(registration, /Do not commit evidence artifacts/);
});

test("the bundle smoke can resolve every name MISSION_MCP_TOOLS is written with", () => {
  // `scripts/smoke-bundles.mjs` is plain node with no TypeScript loader, so it SCRAPES that
  // list and resolves any imported constant through a hand-written name -> module map. A name
  // added to the list as a constant and not to that map makes the smoke FAIL - correctly, but
  // only after a build, and only in CI if nobody ran `npm run smoke` locally. This is the same
  // check for milliseconds, so the gap closes where it is cheap to notice.
  //
  // Deliberately about the SPELLING rather than the value: the smoke's own comparison against
  // the running bundle is what checks the values, and duplicating that here would be the
  // fourth copy of the vocabulary that both files exist to prevent.
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
  const block = /export const MISSION_MCP_TOOLS = \[([\s\S]*?)\] as const;/
    .exec(read("src/server/mission-mcp.ts"))?.[1];
  assert.ok(block, "MISSION_MCP_TOOLS could not be scraped - the smoke reads it the same way");

  const smoke = read("scripts/smoke-bundles.mjs");
  const referenced = [...block.matchAll(/^\s*([A-Z_]+),$/gm)].map((m) => m[1]!);
  for (const name of referenced) {
    assert.match(
      smoke,
      new RegExp(`^\\s*${name}: "`, "m"),
      `${name} is in MISSION_MCP_TOOLS but scripts/smoke-bundles.mjs cannot resolve it to a module`,
    );
  }
  // And the map does not name constants the list has stopped using, which would leave a dead
  // path nobody exercises and a module reference nobody keeps true.
  const mapped = [...smoke.matchAll(/^\s*([A-Z_]+): "src\/[^"]+",$/gm)].map((m) => m[1]!);
  assert.deepEqual([...mapped].sort(), [...referenced].sort());
});

test("every tool the server registers is reachable by a launch that requires it", async () => {
  // Companion to the vocabulary test above, and the gap that let create_task read as
  // present-but-uncallable. That test pins WHAT a launch may require - the list and the
  // server's registrations name the same tools. This one pins the STEP AFTER: that
  // requiring a tool actually delivers it, pre-approved on the argv the child receives, so
  // a dispatched session can call it without stopping on a permission prompt (auto mode does
  // NOT blanket-approve MCP tools). Neither `--allowed-tools` nor this list can put a tool
  // into a session's `tools/list` - only the running bundle does that, which is why the
  // observed miss was a stale `dist/mcp/server.mjs` rather than a drift between the two
  // SOURCES this test reads. Once the tool IS published, this proves a caller can reach it.
  //
  // That remaining gap - "is it published at all" - is no longer unwatched, and this comment
  // used to say it was. It is answered by a real handshake now: see the fixture-bundle cases
  // below, and `dispatcher-runtime.test.ts` for the same refusal driven through a launch.
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

// ---- what the bundle actually PUBLISHES ----------------------------------------------
//
// The two tests above scrape `registerTool(` out of SOURCE, and say so: they pin what this
// build BELIEVES, which is why neither could see the incident they document. The daemon runs
// from source under `tsx watch` and hands every dispatched agent `dist/mcp/server.mjs`, which
// only `npm run build` refreshes and which git ignores - so the bytes an agent runs can be
// arbitrarily far behind the source these tests read, and were: a bundle built six days before
// `submit_scout_artifacts` landed served its other seven tools perfectly while a scout that
// MUST call it to finish was told to call it.
//
// So these run a real MCP handshake - `initialize`, `notifications/initialized`, `tools/list` -
// against a real child process, and assert on the names that come back. Against fixture servers
// rather than `dist/`, for the reason the fake bundle at the top of this file exists: everything
// in `test/` runs against `src/` and must pass on a fresh checkout, so a case that needed
// `npm run build` would report a missing build as a broken guard.

/** A real stdio MCP server publishing exactly `tools`. See `helpers/mcp-fixture.ts`. */
function fixtureServer(name: string, tools: readonly string[]): string {
  return writeMcpFixture(join(home, `${name}.mjs`), tools);
}

/** Point the resolver at a fixture for one test, then put it back. */
async function withBundle<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.HARNESS_MCP_SERVER;
  process.env.HARNESS_MCP_SERVER = path;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.HARNESS_MCP_SERVER;
    else process.env.HARNESS_MCP_SERVER = prior;
  }
}

test("a bundle missing a declared tool is REFUSED, naming the tool and the rebuild", async () => {
  // The observed bundle, reproduced exactly: every tool but the scout's, which is the one
  // shape that reads as a healthy install to every existence check we had. The launch this
  // refuses is the launch that would otherwise deadlock - a scout is told to call
  // `submit_scout_artifacts` and its task cannot reach `done` until it does.
  const stale = fixtureServer(
    "stale",
    MISSION_MCP_TOOLS.filter((t) => t !== "submit_scout_artifacts"),
  );
  await withBundle(stale, async () => {
    const check = await verifyMissionMcpTools(["submit_scout_artifacts"]);
    assert.equal(check.ok, false, "a tool the server does not publish must not pass");
    assert.match(check.reason!, /submit_scout_artifacts/, "name the tool that is missing");
    assert.match(check.reason!, /npm run build/, "name the fix, not just the fault");

    // Everything the bundle DOES publish still launches. A refusal that widened to the
    // whole toolbox would ground every ensemble over one absent scout tool.
    assert.deepEqual(await verifyMissionMcpTools(["submit_ensemble_result", "report_status"]), {
      ok: true,
    });
  });
});

test("a complete bundle is accepted, handshaked ONCE, and re-read after a rebuild", async () => {
  const bundle = fixtureServer("rebuilt", MISSION_MCP_TOOLS.filter((t) => t !== "report_status"));
  await withBundle(bundle, async () => {
    assert.equal((await verifyMissionMcpTools(["report_status"])).ok, false);

    // One handshake, not one per dispatch: ten more asks spawn nothing.
    for (let i = 0; i < 10; i++) await verifyMissionMcpTools(["report_status"]);
    assert.equal(mcpFixtureSpawns(bundle), 1, "the answer is cached per build, not re-probed per launch");

    // …and the cache is keyed by the bundle's identity on disk rather than held for the
    // daemon's lifetime, which is the whole reason it is keyed at all. `npm run build` does
    // not touch `src/`, so it does NOT restart a `tsx watch` daemon - a lifetime-cached
    // refusal would outlive the rebuild that fixed it and go on refusing dispatches to an
    // operator who had just done exactly the right thing.
    fixtureServer("rebuilt", MISSION_MCP_TOOLS);
    assert.deepEqual(await verifyMissionMcpTools(MISSION_MCP_TOOLS), { ok: true });
    assert.equal(mcpFixtureSpawns(bundle), 2, "a rebuilt bundle is re-read");
  });
});

test("a bundle that cannot complete a handshake is refused, not assumed good", async () => {
  // Present on disk, loads, and dies - which is what the `jsonc-parser` UMD defect did to the
  // daemon bundle, and what an `ELECTRON_RUN_AS_NODE`-less Electron runtime does to this one.
  // Every `existsSync` guard passes it. An MCP client gets nothing out of it, so the tool it
  // was supposed to publish is exactly as absent as if the file had never been built.
  const broken = join(home, "broken.mjs");
  writeFileSync(broken, `throw new Error("Dynamic require of \\"./impl/format\\" is not supported");\n`);
  await withBundle(broken, async () => {
    const check = await verifyMissionMcpTools(["submit_scout_artifacts"]);
    assert.equal(check.ok, false);
    assert.match(check.reason!, /could not be interrogated/);
    assert.match(check.reason!, /npm run build/);
  });
});

test("a bundle rebuilt after an agent started cannot vouch for that agent's toolbox", async () => {
  // A launch and an assignment ask different questions of the same file, and conflating them
  // reintroduces the bug one path over. A dispatch is about to SPAWN an agent, so the bundle on
  // disk is exactly what its MCP client will load. An assignment targets an agent that is
  // already running, whose MCP server is a child it spawned at launch and which holds whatever
  // the file contained THEN. Rebuild in between and the file answers perfectly while the child
  // still cannot call the tool - so a disk probe would wave through an assignment that resets
  // the agent's checkout for a task it still cannot submit.
  const bundle = fixtureServer("running-session", MISSION_MCP_TOOLS);
  const writtenAt = statSync(bundle).mtimeMs;
  await withBundle(bundle, async () => {
    // Started BEFORE this bundle was written: its child is a different build, and no handshake
    // with the current file can say what that child publishes.
    const rebuilt = await verifyMissionMcpToolsForRunningSession(
      ["submit_scout_artifacts"],
      writtenAt - 1000,
    );
    assert.equal(rebuilt.ok, false, "the file on disk is not the file that agent is running");
    assert.match(rebuilt.reason!, /rebuilt after this agent started/);
    assert.match(rebuilt.reason!, /Restart the session/, "name the remedy, which is not a rebuild");

    // Started AFTER it: the file IS what that child loaded, so the handshake speaks for it.
    assert.deepEqual(
      await verifyMissionMcpToolsForRunningSession(["submit_scout_artifacts"], writtenAt + 1000),
      { ok: true },
      "a guard that refused this would ground assignment on a healthy machine",
    );

    // An unknown start cannot order the two. Falls back to the disk check rather than refusing:
    // a backend that could not report a process start is not evidence of a stale bundle.
    assert.deepEqual(
      await verifyMissionMcpToolsForRunningSession(["submit_scout_artifacts"], null),
      { ok: true },
    );
  });
});

test("a session-scoped check still refuses a bundle that never had the tool", async () => {
  // The ordering rule widens what is refused; it must not narrow it. An agent that started
  // after a bundle was built is running that bundle - and if that bundle never published the
  // tool, the assignment is exactly as doomed as before.
  const bundle = fixtureServer(
    "running-session-stale",
    MISSION_MCP_TOOLS.filter((t) => t !== "submit_scout_artifacts"),
  );
  const writtenAt = statSync(bundle).mtimeMs;
  await withBundle(bundle, async () => {
    const check = await verifyMissionMcpToolsForRunningSession(
      ["submit_scout_artifacts"],
      writtenAt + 1000,
    );
    assert.equal(check.ok, false);
    assert.match(check.reason!, /does not publish submit_scout_artifacts/);
  });
});

test("what the bundle prints on stderr never reaches the refusal it produces", async () => {
  // `reason` is not a log line. A dispatch persists it as the task's `error` - into SQLite and
  // onto the task card - and the startup check prints it to the daemon log. The bundle we probe
  // inherits this daemon's environment and reads a harness token and a scout credential of its
  // own, so a server that logged one on its way down would have it copied into durable,
  // user-visible state by the very probe that exists to make dispatch safer.
  //
  // A bundle that dies loudly, printing something that must not be echoed.
  const leaky = join(home, "leaky.mjs");
  const secret = "sk-live-DO-NOT-ECHO-4a9f2c";
  writeFileSync(
    leaky,
    `process.stderr.write("FATAL: auth failed for token ${secret}\\n");\nprocess.exit(3);\n`,
  );
  await withBundle(leaky, async () => {
    const check = await verifyMissionMcpTools(["submit_scout_artifacts"]);
    assert.equal(check.ok, false, "a bundle that dies on load is still a refusal");
    assert.ok(
      !check.reason!.includes(secret),
      `the refusal repeated the child's stderr: ${check.reason}`,
    );
    assert.ok(!check.reason!.includes("FATAL"), "no part of the child's output is echoed");
    // The FACT of stderr survives, because it is what separates a bundle that died silently
    // from one that explained itself - and it points at reproducing the spawn by hand.
    assert.match(check.reason!, /bytes to stderr/);
    assert.match(check.reason!, /npm run build/, "the fix is still named");
  });
});

test("a bundle that floods stdout with no newline is refused, not buffered", async () => {
  // The timeout bounds how long this probe listens; it says nothing about how much arrives in
  // that time. MCP's stdio framing is line-delimited JSON, so an unterminated line is the one
  // part of the stream that accumulates - and a broken or hostile bundle can produce one as
  // fast as the pipe allows. Fifteen seconds of that is a daemon-sized heap on the machine
  // whose control plane this is.
  const flood = join(home, "flood.mjs");
  writeFileSync(
    flood,
    // No newline, ever. Writes until the probe stops reading.
    `const chunk = "x".repeat(64 * 1024);\n` +
      `function pump() { while (process.stdout.write(chunk)) {} }\n` +
      `process.stdout.on("drain", pump);\npump();\nsetInterval(() => {}, 1000);\n`,
  );
  await withBundle(flood, async () => {
    const before = process.memoryUsage().heapUsed;
    const check = await verifyMissionMcpTools(["submit_scout_artifacts"]);
    const grew = process.memoryUsage().heapUsed - before;
    assert.equal(check.ok, false);
    assert.match(check.reason!, /no newline/, "say what is wrong with the stream, not just that it failed");
    // The bound is the point. Well under the 15s timeout's worth of a 64KB-per-write flood,
    // and generous enough that a real answer (9,082 bytes for eight tools) is never near it.
    assert.ok(
      grew < 32 * 1024 * 1024,
      `the probe retained ${Math.round(grew / 1024 / 1024)}MB of a flooding bundle's stdout`,
    );
  });
});

test("a bundle that ignores SIGTERM is killed, not left running", async () => {
  // `SIGTERM` is a request, and the bundles this probe exists to catch are the ones least
  // likely to honour it. Sending one and resolving would leave a process alive with our stdio
  // listeners attached, burning CPU and holding the probe's closure open - and because the
  // answer is cached per bundle identity, every rebuild probed afterwards would add another.
  // A guard against a broken bundle must not be a way to accumulate orphans.
  const stubborn = join(home, "stubborn.mjs");
  const pidFile = `${stubborn}.pid`;
  writeFileSync(
    stubborn,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      // Refuses to die politely.
      `process.on("SIGTERM", () => {});\n` +
      // Survives its stdout being torn away, so EPIPE cannot be what ends it. Without this the
      // fixture dies of a broken pipe the moment the probe detaches, and the case would pass
      // whether or not the SIGKILL escalation exists - proving nothing.
      `process.stdout.on("error", () => {});\n` +
      // One oversized frame with no newline, then silence: enough to trip the probe's cap so it
      // gives up in milliseconds rather than at the 15s timeout, and nothing after it.
      `process.stdout.write("x".repeat(2 * 1024 * 1024));\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  await withBundle(stubborn, async () => {
    assert.equal((await verifyMissionMcpTools(["submit_scout_artifacts"])).ok, false);
  });

  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0, "the fixture never recorded its pid");
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // SIGTERM is ignored, so only the SIGKILL escalation can end this. Polled well past the
  // grace period rather than slept through it, so the case stays fast when it passes.
  const deadline = Date.now() + 15_000;
  while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, `the probe left pid ${pid} running after it gave up on the bundle`);
});

test("a dispatch declaring no Mission tools never spawns the bundle at all", async () => {
  // The status quo this must not touch. A ship task's launch declares nothing, so there is
  // nothing to verify - and a guard that handshook anyway would put a subprocess, and a new
  // way to fail, on the common path. Pointed at a bundle that would refuse if asked.
  await withBundle(join(home, "never-built.mjs"), async () => {
    assert.deepEqual(await verifyMissionMcpTools([]), { ok: true });
  });
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
    assert.match(cfg[0]!, /^mcp_servers\.mission-control\.command=/);
    assert.match(cfg[1]!, /^mcp_servers\.mission-control\.args=/);
    assert.match(cfg[2]!, /^mcp_servers\.mission-control\.env=.*MISSION_HOME/);
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
