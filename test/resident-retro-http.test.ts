import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/server/registry.ts";
import { buildApp } from "../src/server/routes.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { setSkillsConfig } from "../src/server/skills/config.ts";
import { forgetInjections, originOf } from "../src/server/injections.ts";
import { RESIDENT_RETRO_LEAD } from "../src/server/residents/retro-packet.ts";
import { runRetro } from "../src/server/retro.ts";
import { ResidentProfileRevisionSchema, residentLaunchInput } from "../src/shared/residents.ts";
import * as store from "../src/server/residents/store.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";

// A resident's retro, asked for from the Complete dialog. It runs in the resident's own
// conversation, types a packet that carries its whole procedure, and needs no skill: the only
// write it can make is a proposal the daemon applies after the operator selects from it.

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };
let serial = 0;

function fixture(options: { builtin?: boolean } = {}) {
  serial += 1;
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const typed: string[] = [];
  const sdkSessions = {
    send: async (_id: string, turn: { text: string }) => {
      typed.push(turn.text);
      return "started" as const;
    },
  } as unknown as SdkSupervisor;
  const app = buildApp({ registry, reviews: {} as never, tasks, queues: {} as never, sdkSessions });
  const profileId = options.builtin ? `builtin:retro-${serial}` : `retro-profile-${serial}`;
  store.createResidentProfile({
    id: profileId,
    settings: ResidentProfileRevisionSchema.parse({ identity: { name: `Retro resident ${serial}` }, instructions: { markdown: "Watch the queue." } }),
    at: Date.now(),
  });
  const taskId = `retro-resident-task-${serial}`;
  store.reserveResidentRun({
    id: `retro-run-${serial}`, profileId, profileRevision: 1, taskId, launchRequestId: `retro-launch-${serial}`,
    launchInput: residentLaunchInput(null, ""), repoSpelling: "", persona: null, runInstructions: "", at: Date.now(),
  });
  store.markResidentRunLaunched(`retro-run-${serial}`, null);
  const session = registry.registerSdkSession({
    id: `sdk:retro-resident-${serial}`, agent: "claude", name: "Retro resident", cwd: `/workspace-${serial}`,
    agentSessionId: `native-retro-resident-${serial}`, initialState: "idle",
  });
  registry.upsertTask(mkTask({ id: taskId, kind: "resident", status: "running", sessionId: session.id, repoRoot: "/workspace" }));
  const retro = () => app.request(`/api/sessions/${session.id}/retro`, { method: "POST", headers: HEADERS });
  return { registry, tasks, typed, session, retro };
}

test("a resident's retro is typed into its own conversation, with its procedure and no skill", async () => {
  // Skills off: a memory retro would be refused here; a resident's needs none.
  setSkillsConfig({ enabled: false, skills: {} });
  const f = fixture();
  forgetInjections(f.session.id);
  try {
    const response = await f.retro();
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { kind: string; sessionId: string };
    assert.equal(body.kind, "delivered");
    assert.equal(body.sessionId, f.session.id);

    assert.equal(f.typed.length, 1, "exactly one turn is typed");
    const payload = f.typed[0]!;
    assert.ok(payload.startsWith("Mission Control session action: Resident retro\n"), payload.slice(0, 80));
    assert.ok(payload.includes(`Session: ${f.session.id}`));
    assert.ok(payload.includes(RESIDENT_RETRO_LEAD));
    assert.ok(payload.includes("get_resident_instructions"));
    assert.ok(payload.includes("propose_resident_instruction_changes"));
    assert.ok(!payload.includes(".agents/memory"), "a resident's retro does not write repository memory");
    assert.equal(originOf(f.session.id, payload), "harness");
  } finally { await f.tasks.stop(); }
});

test("a built-in resident's retro is refused before anything is typed", async () => {
  const f = fixture({ builtin: true });
  try {
    const response = await f.retro();
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /built-in resident[\s\S]*Duplicate it/);
    assert.equal(f.typed.length, 0);
  } finally { await f.tasks.stop(); }
});

test("a resident that cannot take a turn is refused, not filed as a task", async () => {
  const f = fixture();
  try {
    const session = { ...f.registry.getSession(f.session.id)!, state: "exited" as const };
    const result = await runRetro(session, { tasks: f.tasks, promptBlocker: () => null });
    assert.equal(result.kind, "refused");
    assert.match(result.kind === "refused" ? result.error : "", /can no longer receive a turn/);
    assert.equal(f.typed.length, 0);
    assert.equal(f.tasks.list().filter((task) => task.title.startsWith("Retro:")).length, 0);
  } finally { await f.tasks.stop(); }
});
