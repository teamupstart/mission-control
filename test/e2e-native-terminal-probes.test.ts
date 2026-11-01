import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFakeAgents } from "../e2e/fixtures/fake-agents.ts";
import { cmuxControlProbe } from "../src/server/terminal/cmux.ts";
import { createHerdrClient } from "../src/server/terminal/herdr-client.ts";
import { run } from "../src/server/util/exec.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";

const root = mkdtempSync(join(tmpdir(), "native-probe-fakes-"));
after(() => rmSync(root, { recursive: true, force: true }));
const blockedRuntime = join(root, "blocked-runtime.cjs");
writeFileSync(blockedRuntime, "process.stderr.write('JavaScript startup unavailable\\n'); process.exit(77);\n");

function fixture(name: string) {
  const home = join(root, `${name} space ' quote`);
  const fake = writeFakeAgents(home);
  const env = { ...process.env, HOME: home, MISSION_HOME: home,
    MC_E2E_RECORD_DIR: fake.recordDir, NODE_OPTIONS: `--require ${JSON.stringify(blockedRuntime)}` };
  return { home, fake, env };
}

// This tests native fixture execution and response classification, not host scheduling.
// Keep the production deadline assertion, but give real child startup/collection its own
// bounded budget so a busy full-suite worker does not turn a valid response into a timeout.
function nativeProbeExec(bin: string, env: NodeJS.ProcessEnv, onSpawn?: () => void): TerminalExec {
  return (_bin, args, options) => {
    assert.equal(options?.timeoutMs, 1_000, "the production probe deadline must stay unchanged");
    return run(bin, args, { ...options, env, timeoutMs: 10_000, onSpawn });
  };
}

for (const mode of ["ready", "stopped", "refused"]) {
  test(`native cmux ${mode} probe does not depend on JavaScript startup`, async () => {
    const { fake, env } = fixture(`cmux-${mode}`);
    const execute = nativeProbeExec(fake.bins.cmux, { ...env, MC_E2E_CMUX_CONTROL: mode });
    assert.deepEqual(await cmuxControlProbe(execute), mode === "ready"
      ? { state: "ready", accessMode: "allowAll" } : { state: mode });
    assert.equal(readdirSync(fake.recordDir).length, 0, "health reads must not become launch records");
  });
}

for (const mode of ["stable", "newer", "incompatible"]) {
  for (const running of [false, true]) {
    test(`native Herdr ${mode} ${running ? "running" : "stopped"} status survives JavaScript startup refusal`, async () => {
      const { home, fake, env } = fixture(`herdr-${mode}-${running}`);
      const socket = join(home, "fake-herdr.sock");
      if (running) writeFileSync(socket, "fixture socket presence");
      const execute = nativeProbeExec(fake.bins.herdr, { ...env, MC_E2E_HERDR_MODE: mode });
      const result = await createHerdrClient(execute, { env: null, candidates: [fake.bins.herdr], dropEnv: [] }).probe();
      const version = mode === "newer" ? "0.9.0" : mode === "incompatible" ? "0.7.0" : "0.8.2";
      if (mode === "incompatible") {
        assert.equal(result.state, "failed");
        if (result.state === "failed") assert.match(result.error, /incompatible|protocol|restart/i);
      } else assert.deepEqual(result, running ? { state: "ready", socket, version } : { state: "stopped", socket });
    });
  }
}

test("native Herdr classification survives a test-worker stall beyond the production deadline", async () => {
  const { home, fake, env } = fixture("herdr-starved");
  writeFileSync(join(home, "fake-herdr.sock"), "fixture socket presence");
  const execute = nativeProbeExec(fake.bins.herdr, { ...env, MC_E2E_HERDR_MODE: "incompatible" }, () => {
    // Model the full-suite worker not servicing child events for longer than one second.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_250);
  });
  const result = await createHerdrClient(execute, { env: null, candidates: [fake.bins.herdr], dropEnv: [] }).probe();
  assert.equal(result.state, "failed");
  if (result.state === "failed") assert.match(result.error, /incompatible|protocol|restart/i);
});
