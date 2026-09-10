import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// What is at stake: a Bedrock model id that reaches Pi as something else.
//
// A provider-qualified id is the whole contract of this feature - Mission Control never
// translates one, never allowlists one, and never re-derives the provider from anything but
// the string. `amazon-bedrock/deepseek.v3.2` also happens to be the shape that breaks a
// naive path: it carries a dot, and Pi's catalog emits ids whose model half carries slashes
// of its own. Both must reach `--model` byte-for-byte, and the only way to know is to read
// the argv the dispatcher actually spawns with.
//
// The MANAGED runtime's half of the same rule is `pi-sdk-adapter.test.ts` ("the exact model
// id reaches Pi's runtime and is never rewritten"). The two runtimes are the same promise
// made twice, so they are checked twice.

const home = mkdtempSync(join(tmpdir(), "mission-pi-terminal-model-"));
process.env.MISSION_HOME = home;
process.env.HERDR_BIN = join(home, "missing-herdr");
// A binary that exists, so bin resolution can never be what fails a launch. The terminal
// home itself is faked through the dispatcher's `spawn` seam - a test that reached the real
// backend would open tmux sessions on the machine running the suite.
process.env.MISSION_PI_BIN = "/bin/echo";

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function seedRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

/** Dispatch one terminal Pi task and hand back the argv the spawn seam was given. */
async function terminalArgv(taskId: string, model: string): Promise<string[]> {
  const repo = seedRepo(taskId);
  setHarnessesConfig({ sessionRuntime: { pi: "terminal" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: taskId,
      status: "dispatching",
      repoRoot: repo,
      title: "Bedrock model",
      intent: "summarize this repository",
      agent: "pi",
      model,
    }),
  );
  let captured: string[] = [];
  const dispatcher = new Dispatcher(registry, async () => {}, {
    missionMcpDescriptor: async () => null,
    spawn: async (_label, _short, _cwd, _bin, args) => {
      captured = [...(args ?? [])];
      // Nothing is discovered, so the dispatch stops here rather than waiting out a pane
      // that will never appear. The argv is what this test is about.
      throw new Error("stop after argv");
    },
  });
  await dispatcher.dispatch(taskId).catch(() => {});
  return captured;
}

test("a Bedrock model id reaches Pi's --model flag byte-for-byte", async () => {
  const argv = await terminalArgv("pi-bedrock", "amazon-bedrock/deepseek.v3.2");
  const at = argv.indexOf("--model");
  assert.notEqual(at, -1, `no --model in ${JSON.stringify(argv)}`);
  assert.equal(argv[at + 1], "amazon-bedrock/deepseek.v3.2");
  // And the launch still carries Pi's own conversation id and turn one, in that order -
  // `preparePiLaunch`'s contract, unchanged by the managed runtime landing beside it.
  const sessionAt = argv.indexOf("--session-id");
  assert.notEqual(sessionAt, -1, `no --session-id in ${JSON.stringify(argv)}`);
  assert.match(argv[sessionAt + 1] ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(argv.at(-1)?.includes("summarize this repository"), true);
});

test("a model id whose model half carries slashes is not re-split on the way to Pi", async () => {
  const argv = await terminalArgv("pi-nested", "amazon-bedrock/us/meta.llama4-maverick-17b");
  assert.equal(argv[argv.indexOf("--model") + 1], "amazon-bedrock/us/meta.llama4-maverick-17b");
});
