import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookIngest } from "../src/shared/protocol.ts";
import type { SubagentSummary } from "../src/shared/types.ts";

const home = mkdtempSync(join(tmpdir(), "mission-registry-subagents-"));
process.env.MISSION_HOME = home;
const { Registry, SESSION_FIELD_COMPARATORS } = await import("../src/server/registry.ts");
const { HookIngestSchema } = await import("../src/shared/protocol.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const running: SubagentSummary = {
  agents: [{
    id: "a", type: "Explore", description: "Map call sites", state: "running", startedAt: 1, endedAt: null,
    toolUses: 3, tokens: 100, lastTool: "Grep", summary: null, launchTurnId: "toolu_a",
  }],
  finishedFolded: 0,
};

function bound(registry: InstanceType<typeof Registry>, id: string, cwd: string): void {
  registry.registerSdkSession({ id, agent: "claude", name: id, cwd });
  registry.applyDriverEvent(id, {
    kind: "bound", agentSessionId: `${id}-native`, transcriptPath: null, modelId: null, pid: null,
  });
}

test("the driver's summary rides session_upsert, and null removes the field", () => {
  const registry = new Registry();
  const id = "sdk:subagents-projection";
  bound(registry, id, join(home, "projection"));
  const upserts: unknown[] = [];
  registry.on("event", (e: { type: string; session?: { id: string; subagents?: unknown } }) => {
    if (e.type === "session_upsert" && e.session?.id === id) upserts.push(e.session.subagents);
  });
  registry.applyDriverEvent(id, { kind: "subagents", subagents: running });
  assert.deepEqual(registry.getSession(id)!.subagents, running);
  assert.deepEqual(upserts, [running]);

  // The same summary again is not news.
  registry.applyDriverEvent(id, { kind: "subagents", subagents: structuredClone(running) });
  assert.equal(upserts.length, 1);

  registry.applyDriverEvent(id, { kind: "subagents", subagents: null });
  assert.equal("subagents" in registry.getSession(id)!, false);
  assert.deepEqual(upserts, [running, undefined]);
});

test("the summary moves neither state nor activity", () => {
  const registry = new Registry();
  const id = "sdk:subagents-state";
  bound(registry, id, join(home, "state"));
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "planning" });
  registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
  const before = registry.getSession(id)!;
  registry.applyDriverEvent(id, { kind: "subagents", subagents: running });
  const after = registry.getSession(id)!;
  assert.equal(after.state, "idle");
  assert.equal(after.activity, before.activity);
  assert.deepEqual(after.workCycle, before.workCycle);
});

test("re-registering a session whose summary was set starts it without one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new Registry();
  const id = "sdk:subagents-reregister";
  const cwd = join(home, "reregister");
  bound(registry, id, cwd);
  registry.applyDriverEvent(id, { kind: "subagents", subagents: running });
  assert.deepEqual(registry.getSession(id)!.subagents, running);

  // The driver's exit is the one way out; the row goes once its linger elapses.
  registry.applyDriverEvent(id, { kind: "exited", reason: "relaunch", resumable: true });
  assert.deepEqual(registry.getSession(id)!.subagents, running, "the exiting card keeps it while it lingers");
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(registry.getSession(id), undefined);

  // The same id, registered again in the same registry, carries nothing over.
  registry.registerSdkSession({ id, agent: "claude", name: id, cwd });
  assert.equal("subagents" in registry.getSession(id)!, false);
});

test("subagents is compared structurally", () => {
  assert.equal(SESSION_FIELD_COMPARATORS.subagents(running, structuredClone(running)), true);
  assert.equal(SESSION_FIELD_COMPARATORS.subagents(running, undefined), false);
  assert.equal(
    SESSION_FIELD_COMPARATORS.subagents(running, { ...running, finishedFolded: 1 }),
    false,
  );
});

test("a hook raised inside a sub-agent leaves an idle parent idle", () => {
  const registry = new Registry();
  const id = "sdk:subagents-hook";
  const cwd = join(home, "hook");
  bound(registry, id, cwd);
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "planning" });
  registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
  const before = registry.getSession(id)!;
  assert.equal(before.state, "idle");

  const hook = (event: string, extra: Partial<HookIngest> = {}): HookIngest => HookIngestSchema.parse({
    agent: "claude", event, sessionId: `${id}-native`, cwd, env: {}, toolName: "Grep", ...extra,
  });
  for (const event of ["PreToolUse", "PostToolUse", "SubagentStop"]) {
    registry.applyHook(hook(event, { agentId: "agent-a" }));
    const s = registry.getSession(id)!;
    assert.equal(s.state, "idle", `${event} from a sub-agent`);
    assert.equal(s.activity, before.activity);
    assert.equal(s.lastActivity, before.lastActivity);
    assert.deepEqual(s.workCycle, before.workCycle);
  }

  // The same hook from the parent itself still moves it.
  registry.applyHook(hook("PreToolUse"));
  assert.equal(registry.getSession(id)!.state, "working");
});

test("an ingest without agentId still parses, as a hook installed before the field did", () => {
  const parsed = HookIngestSchema.parse({ event: "PreToolUse", env: {} });
  assert.equal(parsed.agentId, undefined);
  assert.equal(HookIngestSchema.safeParse({ event: "PreToolUse", env: {}, agentId: "" }).success, false);
});
