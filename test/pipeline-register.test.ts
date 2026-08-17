import { test } from "node:test";
import assert from "node:assert/strict";

import { registerConductorRepo } from "../src/server/pipelines/conductor/register.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

const REPO = "/workspace/demo";

function deps(result: RunResult) {
  const calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> = [];
  return {
    calls,
    value: {
      resolveBinPath: async (bin: string) => (bin === "conduct-ts" ? "/bin/conduct-ts" : null),
      run: async (bin: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ bin, args, opts });
        return result;
      },
    },
  };
}

test("registration spawns the provider CLI with the exact canonical root and confirms it", async () => {
  const fake = deps(stubRun({
    code: 0,
    stdout: `Registered demo (${REPO}).\n`,
    stderr: "",
  }));
  const result = await registerConductorRepo(REPO, fake.value);

  assert.equal(result.ok, true);
  assert.equal(result.repoRoot, REPO);
  assert.deepEqual(fake.calls, [
    {
      bin: "/bin/conduct-ts",
      args: ["register", REPO],
      opts: { timeoutMs: 10_000, maxBuffer: 16 * 1024, cwd: REPO },
    },
  ]);
});

test("repeated exact confirmations remain successful and provider-defined idempotence is preserved", async () => {
  const fake = deps(stubRun({
    code: 0,
    stdout: `Registered demo (${REPO}).\n`,
    stderr: "",
  }));

  assert.equal((await registerConductorRepo(REPO, fake.value)).ok, true);
  assert.equal((await registerConductorRepo(REPO, fake.value)).ok, true);
  assert.deepEqual(
    fake.calls.map((call) => call.args),
    [["register", REPO], ["register", REPO]],
  );
});

test("a clean exit only succeeds when stdout confirms the exact target", async () => {
  for (const stdout of [
    "registration command completed\n",
    "Registered demo (/workspace/other).\n",
    `Registered  (${REPO}).\n`,
    `prefix\nRegistered demo (${REPO}).\n`,
  ]) {
    const result = await registerConductorRepo(
      REPO,
      deps(stubRun({ code: 0, stdout, stderr: "" })).value,
    );
    assert.equal(result.ok, false, stdout);
    assert.match(result.detail, /without confirming this exact repository/);
  }
});

test("missing binary is a total refusal and never spawns", async () => {
  let spawned = false;
  const result = await registerConductorRepo(REPO, {
    resolveBinPath: async () => null,
    run: async () => {
      spawned = true;
      return stubRun({ code: 0, stdout: "", stderr: "" });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /not on this daemon's PATH/);
  assert.equal(spawned, false);
});

test("nonzero, timeout, overflow, and thrown execution all return bounded refusals", async () => {
  const cases: Array<{ result: RunResult; detail: RegExp }> = [
    { result: stubRun({ code: 2, stdout: "", stderr: "registry refused" }), detail: /exited with code 2/ },
    {
      result: { ...stubRun({ code: 1, stdout: "", stderr: "late" }), outcomeUnknown: true },
      detail: /timed out/,
    },
    {
      result: { ...stubRun({ code: 1, stdout: "", stderr: "large" }), overflowed: true },
      detail: /too much output/,
    },
  ];
  for (const entry of cases) {
    const result = await registerConductorRepo(REPO, deps(entry.result).value);
    assert.equal(result.ok, false);
    assert.match(result.detail, entry.detail);
  }

  const thrown = await registerConductorRepo(REPO, {
    resolveBinPath: async () => "/bin/conduct-ts",
    run: async () => {
      throw new Error("spawn refused");
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.detail, "spawn refused");

  const bounded = await registerConductorRepo(
    REPO,
    deps(stubRun({ code: 2, stdout: "", stderr: "x".repeat(8_000) })).value,
  );
  assert.equal(bounded.ok, false);
  assert.equal(bounded.output.length, 4_000);
  assert.match(bounded.output, /…$/);
});
