import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("fake acli records argv, uses captured auth and search shapes, and refuses unsupported commands", () => {
  const env = { ...process.env, MC_E2E_RECORD_DIR: recordDir };
  const call = (args: string[]) => spawnSync(agents.bins.acli, args, { cwd: home, env, encoding: "utf8" });
  assert.match(call(["--version"]).stdout, /acli version .* \(fake\)/);
  const status = call(["jira", "auth", "status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Site: example.atlassian.net/);
  const issues = [{ key: "MC-1", self: "https://jira-prod-us-0-0.prod.atl-paas.net/rest/api/3/issue/1", fields: { summary: "Synthetic issue" } }];
  writeFileSync(join(recordDir, "fake-acli-state.json"), JSON.stringify({ issues, afterSearchSite: "other.atlassian.net" }));
  const args = ["jira", "workitem", "search", "--jql", "project = MC", "--json", "--limit", "1"];
  assert.deepEqual(JSON.parse(call(args).stdout), issues);
  assert.match(call(["jira", "auth", "status"]).stdout, /Site: other.atlassian.net/);
  const records = readdirSync(recordDir).filter((name) => /^acli-\d/.test(name))
    .map((name) => JSON.parse(readFileSync(join(recordDir, name), "utf8")));
  assert.ok(records.some((r) => JSON.stringify(r.argv) === JSON.stringify(args) && r.cwd === home));
  writeFileSync(join(recordDir, "fake-acli-state.json"), JSON.stringify({ unauthorized: true }));
  assert.equal(call(["jira", "auth", "status"]).status, 1);
  assert.match(call(args).stderr, /auth login/);
  writeFileSync(join(recordDir, "fake-acli-state.json"), "{}");
  assert.equal(call(["jira", "workitem", "delete", "MC-1"]).status, 1);
});

test("fake acli absorbs write verbs, records argv and models refusals, confirmation and site switches", () => {
  const env = { ...process.env, MC_E2E_RECORD_DIR: recordDir };
  const call = (args: string[]) => spawnSync(agents.bins.acli, args, { cwd: home, env, encoding: "utf8" });
  const state = (value: unknown) => writeFileSync(join(recordDir, "fake-acli-state.json"), JSON.stringify(value));
  const comment = ["jira", "workitem", "comment", "create", "--key", "MC-2", "--body", '{"type":"doc"}'];
  const transition = ["jira", "workitem", "transition", "--key", "MC-2", "--status", "Done", "--yes", "--json"];
  const view = ["jira", "workitem", "view", "MC-2", "--fields", "status", "--json"];
  state({});
  assert.equal(call(comment).status, 0);
  assert.equal(call(transition).status, 0);
  assert.equal(JSON.parse(call(view).stdout).fields.status.name, "Done");
  state({ transition: "refused", reason: "Review needed" });
  assert.match(call(transition).stderr, /✗ Error: Review needed/);
  state({ transition: "json-failure" });
  assert.equal(JSON.parse(call(transition).stdout)[0].success, false);
  state({ transition: "unchanged" });
  call(transition);
  assert.equal(JSON.parse(call(view).stdout).fields.status.name, "In Review");
  state({ confirmError: true });
  call(transition);
  assert.equal(call(view).status, 1);
  state({ afterWriteSite: "other.atlassian.net" });
  call(comment);
  assert.match(call(["jira", "auth", "status"]).stdout, /other.atlassian.net/);
  const records = readdirSync(recordDir).filter((name) => /^acli-\d/.test(name))
    .map((name) => JSON.parse(readFileSync(join(recordDir, name), "utf8")));
  assert.ok(records.some((r) => JSON.stringify(r.argv) === JSON.stringify(comment)));
  assert.ok(records.some((r) => JSON.stringify(r.argv) === JSON.stringify(transition)));
  state({});
});
