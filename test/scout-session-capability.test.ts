import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { AGENT_TYPES, TASK_KINDS, type AgentType } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-session-scout-"));
process.env.MISSION_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { RegistryArchiveTaskGateway } = await import("../src/server/archives/task-gateway.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { verifyScoutSubmissionCredential } = await import("../src/server/scouts/submission-auth.ts");
const { sessionScoutCredentialPath, readSessionScoutSubmissionCredential } = await import("../src/shared/harness-runtime.mjs");
const paths = new Set<string>();
after(() => { for (const path of paths) rmSync(path, { force: true }); rmSync(home, { recursive: true, force: true }); });
let serial = 0;

function fixture(shared?: InstanceType<typeof Registry>, agent: AgentType = "claude") {
  const registry = shared ?? new Registry();
  const stop = shared ? () => {} : maintainScoutSessionCredentials(registry);
  const id = `scout-session-${process.pid}-${++serial}`;
  const pid = 700000 + process.pid + serial;
  const cwd = join(home, "checkout");
  const path = sessionScoutCredentialPath(`session:${id}`);
  paths.add(path); paths.add(sessionScoutCredentialPath(`pid:${pid}`));
  registry.applyDiscovery([{ syntheticId: id, agent, name: id, nameSource: "process", cwd,
    gitBranch: "feature/reports", gitRoot: cwd, repoRoot: cwd, pid, tty: null, terminals: [], startedAt: 0 }]);
  registry.applyHook({ agent, event: "Stop", sessionId: `native-${id}`, cwd, transcriptPath: null, env: {} });
  const gateway = new RegistryArchiveTaskGateway(registry);
  const token = () => readFileSync(path, "utf8").trim();
  const authority = () => { const value = verifyScoutSubmissionCredential(token()); assert(value); return value; };
  return { registry, gateway, stop, id, pid, cwd, token, authority, path };
}

test("every harness, task kind and discovered taskless session uses signed live capabilities", () => {
  for (const agent of AGENT_TYPES) for (const kind of [null, ...TASK_KINDS]) {
    const h = fixture(undefined, agent);
    try {
      if (kind) h.registry.upsertTask(mkTask({ id: `task-${h.id}`, kind, status: "running", sessionId: h.id, repoRoot: home, worktreePath: home }));
      const authority = h.authority();
      const lookup = h.gateway.subjectForSubmission(authority);
      assert(lookup.ok, JSON.stringify(lookup));
      assert.equal(lookup.subject.taskId, kind ? `task-${h.id}` : null);
      assert.equal(lookup.subject.sessionId, h.id);
      assert.equal(lookup.subject.origin.session?.id, h.id);
      assert.equal(lookup.subject.episodeId, authority.episodeId);
      if (kind !== "scout") assert.equal(h.gateway.scoutPromptTrailFor(lookup.subject), null);
      const [payload, signature] = h.token().split(".");
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), sessionId: "someone-else" })).toString("base64url");
      assert.equal(verifyScoutSubmissionCredential(`${forged}.${signature}`), null);
      assert.equal(h.gateway.subjectForSubmission({ ...authority, pid: h.pid + 1 }).ok, false);
      assert.equal(h.gateway.subjectForSubmission({ ...authority, episodeId: "stale" }).ok, false);
      assert.equal(h.gateway.subjectForSubmission({ ...authority, cwd: "/different" }).ok, false);
      h.registry.beginSessionReset(h.id);
      assert.equal(h.gateway.subjectForSubmission(authority).ok, false);
      h.registry.endSessionReset(h.id);
      h.registry.applyDiscovery([]);
      assert.equal(h.gateway.subjectForSubmission(authority).ok, false);
    } finally { h.stop(); }
  }
});

test("shared checkout capabilities stay distinct and the bridge refreshes at call time", () => {
  const a = fixture();
  const registry = a.registry;
  const stop = maintainScoutSessionCredentials(registry);
  const second = registry.registerSdkSession({ id: `sdk:shared-${process.pid}`, agent: "claude", name: "Second", cwd: a.cwd, agentSessionId: "native-shared" });
  const bPath = sessionScoutCredentialPath(`session:${second.id}`);
  paths.add(bPath);
  const b = { id: second.id, token: () => readFileSync(bPath, "utf8").trim(), stop };
  const oldId = process.env.MISSION_SESSION_ID;
  try {
    assert.notEqual(a.token(), b.token());
    process.env.MISSION_SESSION_ID = a.id;
    assert.equal(readSessionScoutSubmissionCredential(home), a.token());
    const before = a.authority();
    a.registry.upsertTask(mkTask({ id: `assigned-${a.id}`, kind: "ship", status: "running", sessionId: a.id, repoRoot: home, worktreePath: null }));
    assert.equal(a.gateway.subjectForSubmission(before).ok, false);
    assert.equal(readSessionScoutSubmissionCredential(home), a.token());
    assert(a.gateway.subjectForSubmission(a.authority()).ok);
    process.env.MISSION_SESSION_ID = b.id;
    assert.equal(readSessionScoutSubmissionCredential(home), b.token());
    process.env.MISSION_SESSION_ID = "unregistered";
    assert.equal(readSessionScoutSubmissionCredential(home), "");
  } finally {
    if (oldId === undefined) delete process.env.MISSION_SESSION_ID; else process.env.MISSION_SESSION_ID = oldId;
    a.stop(); b.stop();
  }
});


test("startup registration recreates restored session capabilities and prunes absent owners", async () => {
  const { provisionSessionScoutCredential } = await import("../src/server/scouts/submission-auth.ts");
  const input = { id: `sdk:restored-${process.pid}`, agent: "claude" as const, name: "Restored", cwd: home, agentSessionId: "restored-native" };
  const first = new Registry();
  const stopFirst = maintainScoutSessionCredentials(first);
  first.registerSdkSession(input);
  const path = sessionScoutCredentialPath(`session:${input.id}`);
  paths.add(path);
  assert(existsSync(path));
  stopFirst();
  rmSync(path);
  const absentId = `absent-${process.pid}`;
  const absentPaths = provisionSessionScoutCredential({ sessionId: absentId, taskId: null, episodeId: "old-episode",
    cwd: home, pid: 0, agentSessionId: "absent-native" });
  for (const absentPath of absentPaths) paths.add(absentPath);
  const restored = new Registry();
  const stopRestored = maintainScoutSessionCredentials(restored);
  try {
    restored.registerSdkSession(input);
    restored.applyDiscovery([]);
    const authority = verifyScoutSubmissionCredential(readFileSync(path, "utf8").trim());
    assert(authority);
    assert(new RegistryArchiveTaskGateway(restored).subjectForSubmission(authority).ok);
    for (const absentPath of absentPaths) assert.equal(existsSync(absentPath), false);
  } finally { stopRestored(); }
});

test("a terminal MCP child resolves its registered parent process without a checkout fallback", async () => {
  const { provisionSessionScoutCredential } = await import("../src/server/scouts/submission-auth.ts");
  const identity = { sessionId: `terminal-parent-${process.pid}`, taskId: null, episodeId: "terminal-episode",
    cwd: home, pid: process.pid, agentSessionId: "terminal-native" };
  for (const path of provisionSessionScoutCredential(identity)) paths.add(path);
  const childEnv = { ...process.env };
  delete childEnv.MISSION_SESSION_ID;
  const moduleUrl = new URL("../src/shared/harness-runtime.mjs", import.meta.url).href;
  const token = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const { readSessionScoutSubmissionCredential } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(readSessionScoutSubmissionCredential(process.cwd()));`],
    { env: childEnv, cwd: home, encoding: "utf8" });
  assert.deepEqual(verifyScoutSubmissionCredential(token), identity);
});
