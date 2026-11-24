// Headless mode phase 2: the `mctl` command registry and the setup-step list. Every command and
// step is a stub that a later phase replaces without changing its shape.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCli, usageText } from "../src/cli/index.ts";
import { COMMANDS, findCommand, type CliIo } from "../src/cli/commands/index.ts";
import { NOT_IMPLEMENTED_TEXT } from "../src/cli/commands/stub.ts";
import { SETUP_STEPS } from "../src/cli/setup-steps/index.ts";
import { SETUP_STEP_IDS } from "../src/cli/setup-steps/types.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {}, cwd: "/fake/repo", stdinIsTty: false,
  };
  return { io, out, err };
}

// The stub owners of P2's handoff (section 9). A command added without an owner fails here.
const OWNERS: Record<string, string> = {
  get: "P10", describe: "P10", logs: "P10", status: "P10", config: "P10",
  run: "P13", claude: "P13", daemon: "P13",
  setup: "P14", doctor: "P14",
};

test("the registry lists every spec 7.13 command once, each with its owner", () => {
  assert.deepEqual(COMMANDS.map((c) => c.name).sort(), Object.keys(OWNERS).sort());
  for (const command of COMMANDS) assert.equal(command.owner, OWNERS[command.name], command.name);
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length);
});

// P14 replaced `setup` and `doctor`; their behavior is pinned in home-dispatch-setup-doctor.test.ts.
const REPLACED = new Set(["setup", "doctor"]);
for (const command of COMMANDS.filter((c) => !REPLACED.has(c.name))) {
  test(`mctl ${command.name} is a stub that says not implemented and exits 1`, async () => {
    const { io, out, err } = capture();
    assert.equal(command.implemented, false);
    assert.equal(await runCli([command.name, "--anything"], io), 1);
    assert.deepEqual(out, []);
    assert.equal(err.join(""), `mctl ${command.name}: ${NOT_IMPLEMENTED_TEXT}\n`);
    assert.match(command.usage, new RegExp(`^mctl ${command.name}\\b`));
  });
}

test("help lists every command, and an unknown or missing command is a usage error", async () => {
  const help = capture();
  assert.equal(await runCli(["--help"], help.io), 0);
  for (const command of COMMANDS) assert.match(help.out.join(""), new RegExp(`^  ${command.name}\\s+${command.summary}$`, "m"));
  assert.equal(help.out.join(""), usageText());

  const unknown = capture();
  assert.equal(await runCli(["frobnicate"], unknown.io), 2);
  assert.match(unknown.err.join(""), /unknown command frobnicate/);

  const none = capture();
  assert.equal(await runCli([], none.io), 2);
  assert.equal(findCommand("frobnicate"), undefined);
});

// P2's handoff: P14 owns the step bodies except `agents` (P15) and `codex` (P7).
const STEP_OWNERS = { daemon: "P14", flag: "P14", mod: "P14", agents: "P15", codex: "P7", doctor: "P14" };

test("the setup steps are the spec 7.14 list in order; only agents and codex are still stubs", async () => {
  assert.deepEqual(SETUP_STEPS.map((s) => s.id), [...SETUP_STEP_IDS]);
  assert.deepEqual(Object.fromEntries(SETUP_STEPS.map((s) => [s.id, s.owner])), STEP_OWNERS);
  assert.deepEqual([...SETUP_STEP_IDS], ["daemon", "flag", "mod", "agents", "codex", "doctor"]);
  for (const step of SETUP_STEPS) {
    assert.equal(step.implemented, step.owner === "P14", `${step.id} implemented only when P14 owns it`);
    if (step.implemented) continue;
    for (const live of [false, true]) {
      const result = await step.run({ live });
      assert.equal(result.id, step.id);
      assert.equal(result.status, "skipped");
    }
  }
  // Spec 7.14: until P15 and P7 merge, these two steps report that they are not built yet.
  const stubs = SETUP_STEPS.filter((s) => !s.implemented);
  const messages = Object.fromEntries(await Promise.all(stubs.map(async (s) => [s.id, (await s.run({ live: false })).message])));
  assert.equal(messages.agents, "agents: not built yet");
  assert.equal(messages.codex, "codex: not built yet");
});

test("the built mctl bundle that bin.mctl names runs: help exits 0, a stub exits 1, an unknown command exits 2", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.equal(pkg.bin.mctl, "dist/cli/mctl.mjs");
  assert.match(pkg.scripts["build:cli"]!, /--outfile=dist\/cli\/mctl\.mjs/);
  assert.match(pkg.scripts.build!, /npm run build:cli/);
  const dir = mkdtempSync(join(tmpdir(), "mission-mctl-build-"));
  try {
    const bundle = join(dir, "mctl.mjs");
    // The same script `bin.mctl` is built by, with its output redirected so `dist/` is untouched.
    const built = spawnSync("npm", ["run", "build:cli", "--", "--outfile=" + bundle], { cwd: root, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    assert.match(readFileSync(bundle, "utf8"), /^#!\/usr\/bin\/env node\n/);
    const run = (...args: string[]) => spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8" });
    const help = run("--help");
    assert.equal(help.status, 0);
    for (const command of COMMANDS) assert.match(help.stdout, new RegExp("^  " + command.name + "\\s", "m"));
    const stub = run("get");
    assert.equal(stub.status, 1);
    assert.equal(stub.stderr, "mctl get: not implemented\n");
    const unknown = run("frobnicate");
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown command frobnicate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
