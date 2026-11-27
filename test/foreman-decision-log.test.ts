import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  FOREMAN_LOG_MAX_BYTES,
  FOREMAN_LOG_NAME,
  formatCompletionDecision,
  foremanLogPath,
  recordCompletionDecision,
  type CompletionDecisionRecord,
} from "../src/server/foreman/decision-log.ts";
import { openPathUtilityLog } from "../src/main/utility-log.ts";
import { tempDir } from "./temp-root.mjs";

const dir = tempDir("mission-foreman-decision-log-");
after(() => rmSync(dir, { recursive: true, force: true }));

const held: CompletionDecisionRecord = {
  at: Date.UTC(2026, 10, 22, 21, 15, 15),
  sessionId: "sdk:1d3e41fb",
  sessionName: "Agent Reports and\nInbox Upgrades Phased Plan",
  taskKind: "plan",
  generation: 1,
  episodeKey: "intent:1:3",
  outcome: "held",
  summary: "Plan Validation has no\ncompleted result.",
  gaps: [{ id: "plan-validation-pending", kind: "unverified" }, { id: "rendered html", kind: undefined }],
};

test("a decision is one timestamped line naming why, never the gap details", () => {
  assert.equal(
    formatCompletionDecision(held),
    '2026-11-22T21:15:15.000Z [foreman] completion outcome=held session=sdk:1d3e41fb '
      + 'name="Agent Reports and Inbox Upgrades Phased Plan" task=plan generation=1 episode=intent:1:3 '
      + 'gaps=plan-validation-pending:unverified,rendered-html summary="Plan Validation has no completed result."',
  );
});

test("a claimed workflow names its run and omits empty fields", () => {
  const line = formatCompletionDecision({
    ...held, outcome: "workflow_claimed", gaps: [], summary: "", runId: "2256f731", taskKind: null,
  });
  assert.match(line, / outcome=workflow_claimed /);
  assert.match(line, / task=none /);
  assert.match(line, / run=2256f731$/);
  assert.doesNotMatch(line, /gaps=|summary=/);
});

test("a long summary is clamped to one bounded line", () => {
  const line = formatCompletionDecision({ ...held, summary: "x".repeat(5000), sessionName: "n".repeat(500) });
  assert.ok(line.length < 700, `line was ${line.length} chars`);
  assert.ok(!line.includes("\n"));
});

test("decisions append to foreman.log beside the supervisor's lines", () => {
  const path = foremanLogPath(dir);
  assert.equal(path, join(dir, FOREMAN_LOG_NAME));
  writeFileSync(path, "[mission-control] mission-control-foreman stopped\n");
  recordCompletionDecision(held, path);
  recordCompletionDecision({ ...held, generation: 2, outcome: "empty", gaps: [] }, path);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^\[mission-control\]/);
  assert.match(lines[1]!, /outcome=held .* generation=1 /);
  assert.match(lines[2]!, /outcome=empty .* generation=2 /);
});

test("a log just under the cap takes the next line in place", () => {
  const filling = join(dir, "filling");
  writeFileSync(filling, "a".repeat(FOREMAN_LOG_MAX_BYTES - 1));
  recordCompletionDecision(held, filling);
  assert.equal(existsSync(`${filling}.1`), false, "rotated before the cap was reached");
  const contents = readFileSync(filling, "utf8");
  assert.ok(contents.startsWith("a".repeat(FOREMAN_LOG_MAX_BYTES - 1)));
  assert.match(contents.slice(FOREMAN_LOG_MAX_BYTES - 1), /^\S+ \[foreman\] completion outcome=held .*\n$/);
});

test("a full log rotates to one previous file before the next line", () => {
  const rotating = join(dir, "rotate");
  writeFileSync(`${rotating}`, "a".repeat(FOREMAN_LOG_MAX_BYTES));
  recordCompletionDecision(held, rotating);
  assert.equal(statSync(`${rotating}.1`).size, FOREMAN_LOG_MAX_BYTES);
  assert.match(readFileSync(rotating, "utf8"), /^\S+ \[foreman\] completion outcome=held /);
});

test("no supervisor or in-flight line is lost across repeated rotations", () => {
  // The Electron supervisor writes Foreman's lifecycle lines through a path-only log and the
  // worker rotates by rename, so nobody holds foreman.log open across a rotation. A line lands
  // in whichever file was foreman.log when it was opened. The earlier designs each lost lines:
  // a spawn-time handle followed .1 and then wrote nowhere once .1 was replaced, and an
  // in-place copy-then-truncate dropped a line written between its two steps.
  mkdirSync(join(dir, "supervised"));
  const path = join(dir, "supervised", FOREMAN_LOG_NAME);
  const supervisor = openPathUtilityLog(path);

  // Round 1: a writer that opened the file just before the rotation finishes after it.
  writeFileSync(path, "a".repeat(FOREMAN_LOG_MAX_BYTES));
  const inFlight = openSync(path, "a");
  recordCompletionDecision({ ...held, generation: 1 }, path);
  writeSync(inFlight, "[mission-control] in-flight line\n");
  closeSync(inFlight);
  supervisor.write("[mission-control] supervisor line 1\n");
  assert.match(readFileSync(`${path}.1`, "utf8"), /\[mission-control\] in-flight line\n$/, "the in-flight line was kept in .1");
  const afterFirst = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(afterFirst.length, 2, afterFirst.join("\n"));
  assert.match(afterFirst[0]!, /\[foreman\] completion outcome=held .* generation=1 /);
  assert.equal(afterFirst[1], "[mission-control] supervisor line 1");

  // Round 2: the second rotation replaces .1. Round 1's supervisor line moves with it.
  appendFileSync(path, "a".repeat(FOREMAN_LOG_MAX_BYTES));
  recordCompletionDecision({ ...held, generation: 2 }, path);
  supervisor.end("[mission-control] mission-control-foreman stopped\n");
  const previous = readFileSync(`${path}.1`, "utf8");
  const current = readFileSync(path, "utf8");
  assert.match(previous, /generation=1 [\s\S]*\[mission-control\] supervisor line 1\n/);
  assert.match(current, /^\S+ \[foreman\] completion outcome=held .* generation=2 /);
  assert.match(current, /\[mission-control\] mission-control-foreman stopped\n$/);
  assert.equal(supervisor.writableEnded, true);
});

test("an unwritable log costs the line, never the decision, and says why", () => {
  let result: string | null = "unset";
  assert.doesNotThrow(() => {
    result = recordCompletionDecision(held, join(dir, "missing", "dir", "foreman.log"));
  });
  // The code, never the message: a filesystem message carries the state directory path.
  assert.equal(result, "ENOENT");
  assert.equal(recordCompletionDecision(held, join(dir, "writable.log")), null);
});
