import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubIssuesConfigSchema, type SweepContext } from "../src/shared/task-source.ts";
import { candidateFrom, githubIssues, refusedRelationFields } from "../src/server/task-sources/github-issues.ts";

// A gh released before `blockedBy` and `parent` existed refuses them as unknown JSON fields.
// Before sources could relate, such a gh swept fine, so it must keep sweeping.
const dir = mkdtempSync(join(tmpdir(), "mission-old-gh-"));
const log = join(dir, "calls");
writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[0] === "auth") process.exit(0);
const fields = (args[args.indexOf("--json") + 1] || "").split(",");
if (fields.includes("blockedBy")) {
  process.stderr.write('Unknown JSON field: "blockedBy"\\nAvailable fields:\\n  assignees\\n');
  process.exit(1);
}
const issue = (n) => ({ number: n, title: "Issue " + n, body: "Body", url: "https://github.com/acme/demo/issues/" + n, labels: [] });
process.stdout.write(JSON.stringify(args[1] === "list" ? [issue(1)] : issue(Number(args[2].split("/").pop()))));
`, { mode: 0o755 });
const previous = process.env.MISSION_GH_BIN;
process.env.MISSION_GH_BIN = join(dir, "gh");
after(() => {
  if (previous === undefined) delete process.env.MISSION_GH_BIN;
  else process.env.MISSION_GH_BIN = previous;
  rmSync(dir, { recursive: true, force: true });
});

const cfg = GithubIssuesConfigSchema.parse({});
const ctx: SweepContext = { sourceId: "s", repoRoot: dir, signal: new AbortController().signal };
const calls = (): string[] => readFileSync(log, "utf8").trim().split("\n");
const ref = (n: number) => ({ sourceId: "s", externalId: `acme/demo#${n}`, url: `https://github.com/acme/demo/issues/${n}` });

test("only gh refusing a relation field counts as an older gh", () => {
  assert.equal(refusedRelationFields({ code: 1, stderr: 'Unknown JSON field: "blockedBy"\n' }), true);
  assert.equal(refusedRelationFields({ code: 1, stderr: 'Unknown JSON field: "stateReason"\n' }), true);
  assert.equal(refusedRelationFields({ code: 1, stderr: 'Unknown JSON field: "assignees"\n' }), false);
  assert.equal(refusedRelationFields({ code: 1, stderr: "HTTP 401: Bad credentials" }), false);
  assert.equal(refusedRelationFields({ code: 0, stderr: 'Unknown JSON field: "blockedBy"' }), false);
});

test("a candidate read without the relation fields says so, whatever the row carries", () => {
  const row = { number: 4, title: "Four", url: "https://github.com/acme/demo/issues/4", state: "CLOSED",
    blockedBy: { nodes: [{ url: "https://github.com/acme/demo/issues/5" }] }, parent: { url: "https://github.com/acme/demo/issues/6" } };
  const unknown = candidateFrom(row, cfg, ctx, false)!;
  assert.equal(unknown.relationsUnknown, true);
  assert.equal("blockedBy" in unknown || "parent" in unknown || "state" in unknown, false);
  assert.equal("relationsUnknown" in candidateFrom(row, cfg, ctx)!, false);
});

test("an older gh still sweeps, passes preflight and reads linked issues, with relations marked unknown", async () => {
  const swept = await githubIssues.sweep(cfg, ctx);
  assert.equal(swept.error, null);
  assert.deepEqual(swept.items.map((c) => [c.ref.externalId, c.relationsUnknown]), [["acme/demo#1", true]]);
  assert.equal(await githubIssues.preflight(cfg, ctx), null);

  const linked = await githubIssues.readLinked(cfg, [ref(2), ref(3)], ctx);
  assert.equal(linked.error, null);
  assert.equal(linked.itemErrors, undefined);
  assert.deepEqual(linked.items.map((c) => [c.ref.externalId, c.relationsUnknown, c.state]).sort(),
    [["acme/demo#2", true, undefined], ["acme/demo#3", true, undefined]]);
  // Every answer came from a retry that asked for neither the links nor a state without its reason.
  const answered = calls().filter((call) => !call.startsWith("auth") && !call.includes("blockedBy"));
  assert.ok(answered.length >= 4);
  assert.ok(answered.every((call) => !/\bstate\b/.test(call.split("--json ")[1] ?? "")));
});
