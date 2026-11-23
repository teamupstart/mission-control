import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real `compareCommits` adapter, through a fake `gh` that answers GitHub's compare API
// with a scripted JSON body and applies the adapter's OWN `--jq` expression to it with real jq,
// exactly as `gh api --jq` does. So both halves are under test: the expression the adapter
// sends, and how the adapter reads its output. The lifecycle tests script `compare` itself;
// this is the one place its GitHub reading is checked.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-compare-"));
process.env.HARNESS_HOME = home;
const dir = mkdtempSync(join(tmpdir(), "mission-compare-gh-"));
const bin = join(dir, "gh");
const scenario = join(dir, "scenario.json");
const calls = join(dir, "calls.jsonl");
const previousBin = process.env.MISSION_GH_BIN;
const { compareCommits } = await import("../src/server/inspector/github.ts");

const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

before(() => {
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(scenario)}, "utf8"));
if (s.exit) { process.stderr.write(s.stderr || ""); process.exit(s.exit); }
const jq = args[args.indexOf("--jq") + 1];
process.stdout.write(execFileSync("jq", ["-r", jq], { input: JSON.stringify(s.body) }));
`, { mode: 0o755 });
  process.env.MISSION_GH_BIN = bin;
});
after(() => {
  if (previousBin === undefined) delete process.env.MISSION_GH_BIN;
  else process.env.MISSION_GH_BIN = previousBin;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);

async function answer(s: { body?: unknown; exit?: number; stderr?: string }) {
  writeFileSync(scenario, JSON.stringify(s));
  return compareCommits(dir, "acme", "repo", BASE, HEAD);
}

test("it asks GitHub's compare API for base...head and nothing else", { skip: !hasJq && "jq is not installed" }, async () => {
  writeFileSync(calls, "");
  await answer({ body: { status: "ahead", behind_by: 0, ahead_by: 2 } });
  const argv = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(argv.length, 1, "one read");
  assert.deepEqual(argv[0]!.slice(0, 2), ["api", `repos/acme/repo/compare/${BASE}...${HEAD}`]);
  assert.ok(!argv[0]!.includes("--method"), "a read, never a write");
});

test("ahead and identical: the base is in the head's history", { skip: !hasJq && "jq is not installed" }, async () => {
  assert.deepEqual(await answer({ body: { status: "ahead", behind_by: 0, ahead_by: 3 } }), { ok: true, value: { contains: true, behindBy: 0 } });
  assert.deepEqual(await answer({ body: { status: "identical", behind_by: 0, ahead_by: 0 } }), { ok: true, value: { contains: true, behindBy: 0 } });
  // A count GitHub left out still means "contains" for these two: nothing of the base is missing.
  assert.deepEqual(await answer({ body: { status: "ahead" } }), { ok: true, value: { contains: true, behindBy: 0 } });
});

test("behind and diverged: the parent has commits the child lacks, with GitHub's count", { skip: !hasJq && "jq is not installed" }, async () => {
  assert.deepEqual(await answer({ body: { status: "behind", behind_by: 3, ahead_by: 0 } }), { ok: true, value: { contains: false, behindBy: 3 } });
  assert.deepEqual(await answer({ body: { status: "diverged", behind_by: 2, ahead_by: 5 } }), { ok: true, value: { contains: false, behindBy: 2 } });
  // No count reported: still not contained, and the count is unknown rather than invented.
  assert.deepEqual(await answer({ body: { status: "diverged" } }), { ok: true, value: { contains: false, behindBy: null } });
});

test("a failed call and an unrecognized status are errors, never an ancestry answer", { skip: !hasJq && "jq is not installed" }, async () => {
  const failed = await answer({ exit: 1, stderr: "HTTP 404: No common ancestor between base and head" });
  assert.equal(failed.ok, false);
  assert.equal(failed.value, undefined);
  assert.match(failed.error ?? "", /gh api \(compare\)/);
  assert.match(failed.error ?? "", /No common ancestor/);

  const odd = await answer({ body: { status: "something-new", behind_by: 1 } });
  assert.deepEqual(odd, { ok: false, error: 'compare reported an unrecognized status "something-new"' });

  const empty = await answer({ body: {} });
  assert.equal(empty.ok, false, "no status at all is not an answer");
  assert.match(empty.error ?? "", /unrecognized status/);
});
