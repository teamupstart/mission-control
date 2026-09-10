import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeAgents } from "../e2e/fixtures/fake-agents.ts";

// What is at stake: a fixture PROGRAM this change delivers as executable code, which no other
// layer can see.
//
// The fake `jira` is a template literal written to disk and run in a child process, so a
// coverage report over `e2e/fixtures/fake-agents.ts` cannot attribute a single one of its
// lines: what executes is the generated file, not the string that produced it. That is why it
// needs assertions of its own. It is also the blast dam that keeps a suite run off a real
// ticket - `jira issue move MC-431 "Done"` transitions somebody's board - so "it is there and
// it answers" is a thing to prove, not assume.
//
// Nothing here starts a browser, a daemon or a dashboard. These spawn the generated program
// directly, which is the only layer that can watch it behave.

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-fixture-programs-")));
after(() => rmSync(home, { recursive: true, force: true }));

// ---- 1. the fake `jira`, and the writes it must absorb ----

const agents = writeFakeAgents(join(home, "agents"));
const recordDir = agents.recordDir;

/** Run the fake with a recording directory, and hand back what it printed. */
function jira(args: string[], cwd = home): { stdout: string; records: unknown[] } {
  const before = new Set(readdirSync(recordDir));
  const stdout = execFileSync(agents.bins.jira, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MC_E2E_RECORD_DIR: recordDir },
  });
  const records = readdirSync(recordDir)
    .filter((name) => !before.has(name) && name.startsWith("jira-"))
    .map((name) => JSON.parse(readFileSync(join(recordDir, name), "utf8")) as unknown);
  return { stdout, records };
}

test("the fake jira answers a sweep with an empty, well-formed envelope", () => {
  // Not "prints nothing": the override is whole-codebase, so a Jira source's sweep reaches
  // this too, and output that is not JSON would turn a preflight into a parse error rather
  // than the healthy up-to-date filter every spec that ignores Jira already expects.
  const { stdout } = jira(["issue", "list", "--jql", "project = MC", "--paginate", "0:51", "--raw"]);
  assert.deepEqual(JSON.parse(stdout), { issues: [] });
});

test("the fake jira absorbs a write-back comment, and records exactly what it was asked", () => {
  const body = "Mission Control opened a pull request for this issue.\n\nhttps://example/pr/9";
  const { stdout, records } = jira(["issue", "comment", "add", "MC-431", body, "--no-input"]);
  assert.equal(stdout.trim(), "done");
  assert.equal(records.length, 1);
  const record = records[0] as { argv: string[]; cwd: string };
  // The argv is the assertion surface a spec would read, so the multi-line body has to
  // survive as ONE argument rather than being split.
  assert.deepEqual(record.argv, ["issue", "comment", "add", "MC-431", body, "--no-input"]);
  assert.equal(record.cwd, home);
});

test("the fake jira absorbs a transition, which is the write that would move a real issue", () => {
  const { stdout, records } = jira(["issue", "move", "MC-431", "Done"]);
  assert.equal(stdout.trim(), "done");
  assert.deepEqual((records[0] as { argv: string[] }).argv, ["issue", "move", "MC-431", "Done"]);
});

test("the fake jira answers a version probe, and is silent about anything else", () => {
  assert.match(jira(["version"]).stdout, /jira version .* \(fake\)/);
  // Unrecognised verbs exit 0 having printed nothing, so a caller that reaches one is not
  // handed a parse error about a command this fixture was never asked to model.
  const other = jira(["issue", "view", "MC-431"]);
  assert.equal(other.stdout, "");
});

test("the fake jira exists and is executable, which is what MISSION_JIRA_BIN points at", () => {
  assert.ok(existsSync(agents.bins.jira));
  assert.ok(agents.bins.jira.endsWith("fake-jira"));
});
