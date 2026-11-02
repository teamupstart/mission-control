import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { Registry } from "../src/server/registry.ts";
import { ResidentLoop } from "../src/server/residents/loop.ts";
import { ResidentManager } from "../src/server/residents/manager.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { registerResidentLoopRoutes } from "../src/server/residents/routes.ts";
import { maintainScoutSessionCredentials } from "../src/server/scouts/session-credentials.ts";
import { sessionScoutCredentialLocator } from "../src/server/scouts/submission-auth.ts";
import { sessionScoutCredentialPath } from "../src/shared/harness-runtime.mjs";
import { ensureToken } from "../src/server/auth.ts";
import { ResidentProfileRevisionSchema, residentLaunchInput } from "../src/shared/residents.ts";
import * as store from "../src/server/residents/store.ts";
import { mkTask } from "./helpers/session-fixture.ts";

test("pacing resolves only the signed caller; no session-control grant or body identity can substitute", async () => {
  const registry = new Registry();
  const stopCredentials = maintainScoutSessionCredentials(registry);
  const loop = new ResidentLoop({ registry, refreshSession: () => {}, sdk: { sendWhenIdle: async () => null, compact: async () => 1 } });
  const tasks = new TaskManager(registry);
  const residents = new ResidentManager({ registry, persona: () => null, createTask: () => { throw new Error("unused"); } });
  const app = new Hono(); registerResidentLoopRoutes(app, { registry, loop, tasks, residents });
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Signed resident" }, persona: { personaId: "p" } });
  store.createResidentProfile({ id: "profile", settings, at: Date.now() });
  store.reserveResidentRun({ id: "run", profileId: "profile", profileRevision: 1, taskId: "resident-task", launchRequestId: "launch", launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo", persona: { personaId: "p", name: "Observer", guidanceMarkdown: "" }, runInstructions: "", at: Date.now() });
  store.markResidentRunLaunched("run", null);
  const resident = registry.registerSdkSession({ id: "sdk:resident", agent: "claude", name: "Resident", cwd: "/repo", agentSessionId: "native-resident", initialState: "idle" });
  registry.upsertTask(mkTask({ id: "resident-task", kind: "resident", status: "running", sessionId: resident.id, repoRoot: "/repo" }));
  const ordinary = registry.registerSdkSession({ id: "sdk:ordinary", agent: "claude", name: "Ordinary", cwd: "/repo", agentSessionId: "native-ordinary" });
  const credential = (id: string) => readFileSync(sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(id)}`), "utf8").trim();
  const request = (cred?: string, extra: Record<string, unknown> = {}) => app.request("/mcp/residents/schedule-next-iteration", {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": ensureToken(), ...(cred ? { "x-mission-scout-credential": cred } : {}) },
    body: JSON.stringify({ delaySeconds: 1200, callId: "intent", ...extra }),
  });
  try {
    assert.equal((await request()).status, 409);
    assert.equal((await request(credential(resident.id) + "forged")).status, 409);
    assert.equal((await request(credential(ordinary.id))).status, 409);
    assert.equal((await request(credential(resident.id), { sessionId: ordinary.id })).status, 409);
    assert.equal(registry.sessionControlEnabled(resident.id), false);
    const accepted = await request(credential(resident.id)); assert.equal(accepted.status, 200);
    const receipt = await accepted.json(); assert.equal(receipt.callId, "intent"); assert.equal(receipt.delaySeconds, 1200);
    assert.deepEqual(await (await request(credential(resident.id))).json(), receipt);
    loop.pause("run"); const refused = await request(credential(resident.id), { callId: "paused" });
    assert.equal((await refused.json()).code, "not_recorded");
    store.endResidentRun("run", Date.now());
    for (const control of ["pause", "resume", "run-now", "restart"]) {
      assert.equal((await app.request(`/api/residents/runs/run/${control}`, { method: "POST" })).status, 409);
    }
  } finally { await loop.stop(); residents.stop(); stopCredentials(); await tasks.stop(); }
});
