import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const dir = mkdtempSync(join(tmpdir(), "mission-foreman-decision-log-"));
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

test("the supervisor's open append handle still reaches foreman.log after repeated rotations", () => {
  // The Electron supervisor opens foreman.log once with "a" and keeps that handle for its
  // whole life. A rename-based rotation carried the handle off to .1 and, on the next
  // rotation, replaced .1 - so its lifecycle lines reached no path at all.
  mkdirSync(join(dir, "supervised"));
  const path = join(dir, "supervised", FOREMAN_LOG_NAME);
  const supervisor = openSync(path, "a", 0o600);
  try {
    for (const round of [1, 2]) {
      writeSync(supervisor, "a".repeat(FOREMAN_LOG_MAX_BYTES));
      recordCompletionDecision({ ...held, generation: round }, path);
      writeSync(supervisor, `[mission-control] supervisor line ${round}\n`);

      const current = readFileSync(path, "utf8");
      const lines = current.trim().split("\n");
      assert.equal(lines.length, 2, `round ${round}: foreman.log was not rotated in place`);
      assert.match(lines[0]!, new RegExp(`\\[foreman\\] completion outcome=held .* generation=${round} `));
      // The supervisor's handle still writes to the path an operator opens, with no gap.
      assert.equal(lines[1], `[mission-control] supervisor line ${round}`);

      const previous = readFileSync(`${path}.1`, "utf8");
      assert.ok(previous.endsWith("a".repeat(64)), `round ${round}: .1 holds the full log`);
      if (round === 2) {
        // The first rotation's lines moved into .1 with the second one, rather than vanishing.
        assert.match(previous, /generation=1 [\s\S]*\[mission-control\] supervisor line 1\n/);
      }
    }
  } finally {
    closeSync(supervisor);
  }
});

test("an unwritable log costs the line, never the decision", () => {
  assert.doesNotThrow(() => recordCompletionDecision(held, join(dir, "missing", "dir", "foreman.log")));
});
