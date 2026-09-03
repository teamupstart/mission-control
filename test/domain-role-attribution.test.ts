import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookIngest } from "@shared/protocol.ts";

// What is at stake: a session that delegates does not do its own work, so "subagent
// finished" is the same line for every one of ten different roles, and nothing anywhere
// records WHICH role ran. On a machine running the role-based domain setup that is the
// single most useful fact a hook carries, and the bridge was dropping it on the floor.
//
// Three things pinned here:
//
//   1. The ticker NAMES the role, and falls back to the old wording rather than to an
//      empty name when the bridge predates the field.
//   2. The wire accepts an arbitrary role string. The set of roles is whatever a user
//      defined plus whatever their plugins ship, so an enum would reject unseen ones.
//   3. The role lands in `session_events` as its own payload key, because the reason to
//      record it is arithmetic and nobody should have to parse it back out of a display
//      string.
//   4. Both halves are recorded INDEPENDENTLY, which is what makes the arithmetic
//      survive the harness. Claude Code declares `agent_type` required on
//      `SubagentStop` and in practice usually omits it there while sending it faithfully
//      on the tool events, so a `SubagentStop` that names only an `agentId` must still
//      record that id, and a main-thread `--agent` event that names only a role must
//      still record the role.

const home = mkdtempSync(join(tmpdir(), "mission-role-attr-"));
process.env.HARNESS_HOME = join(home, "state");

const { claudeHooks } = await import("../src/server/harness/claude/hooks.ts");
const { HookIngestSchema } = await import("../src/shared/protocol.ts");
const { logEvent, openDb } = await import("../src/server/db.ts");

process.on("exit", () => rmSync(home, { recursive: true, force: true }));

/** A SubagentStop ingest, which is the only event that names a role today. */
function subagentStop(over: Partial<HookIngest> = {}): HookIngest {
  return {
    agent: "claude",
    event: "SubagentStop",
    sessionId: "agent-1",
    cwd: "/repo",
    transcriptPath: null,
    env: {},
    ...over,
  } as HookIngest;
}

test("the ticker names the role that finished", () => {
  assert.equal(
    claudeHooks.toState(subagentStop({ agentType: "investigator" })).activity,
    "investigator finished",
  );
  assert.equal(
    claudeHooks.toState(subagentStop({ agentType: "fact-finder" })).activity,
    "fact-finder finished",
  );
  // Still working: a worker returning means the parent has more to do.
  assert.equal(claudeHooks.toState(subagentStop({ agentType: "qa" })).state, "working");
});

test("a plugin's namespaced role reaches the ticker verbatim", () => {
  // The namespace is the useful half when two marketplaces ship a role by one name,
  // so nothing here trims it back to the last segment.
  assert.equal(
    claudeHooks.toState(subagentStop({ agentType: "pr-review-toolkit:code-reviewer" })).activity,
    "pr-review-toolkit:code-reviewer finished",
  );
});

test("a SubagentStop that names no role keeps the generic wording", () => {
  // Not a legacy path. Claude Code's own schema marks `agent_type` required on this
  // event and it arrives absent anyway - 10 of 11 events over three measured hours,
  // each carrying an `agent_id` alone. So this is the line an operator will usually
  // read, and "undefined finished" would be worse than the one it replaced.
  const reading = claudeHooks.toState(subagentStop({ agentId: "a99c9983ff26e558a" }));
  assert.equal(reading.activity, "subagent finished");
  assert.equal(reading.state, "working");
});

test("the wire accepts any role name, and omits both fields when absent", () => {
  const withRole = HookIngestSchema.parse({
    event: "SubagentStop",
    env: {},
    agentType: "a-role-nobody-has-shipped-yet",
    agentId: "a963f1944a93deefa",
  });
  assert.equal(withRole.agentType, "a-role-nobody-has-shipped-yet");
  assert.equal(withRole.agentId, "a963f1944a93deefa");

  const without = HookIngestSchema.parse({ event: "Stop", env: {} });
  assert.equal(without.agentType, undefined);
  assert.equal(without.agentId, undefined, "a main-loop event must name no agent");
});

test("the role lands in session_events as its own key, queryable by role", () => {
  // This is the shape the whole change exists to produce: one row per worker return,
  // grouped by role, without parsing a display string.
  logEvent("s-roles", 1, "SubagentStop", {
    activity: "investigator finished",
    state: "working",
    role: "investigator",
    agentId: "a1",
  });
  logEvent("s-roles", 2, "SubagentStop", {
    activity: "investigator finished",
    state: "working",
    role: "investigator",
    agentId: "a2",
  });
  logEvent("s-roles", 3, "SubagentStop", {
    activity: "fact-finder finished",
    state: "working",
    role: "fact-finder",
    agentId: "a3",
  });
  // A main-loop event in the same session, which must not be counted as a worker run.
  logEvent("s-roles", 4, "Stop", { activity: "idle", state: "idle" });

  const rows = openDb()
    .prepare(
      `SELECT json_extract(payload, '$.role') AS role, COUNT(*) AS runs
         FROM session_events
        WHERE session_id = ? AND kind = 'SubagentStop'
        GROUP BY role
        ORDER BY runs DESC`,
    )
    .all("s-roles") as { role: string | null; runs: number }[];

  // Mapped to plain objects on purpose: node:sqlite hands back null-prototype rows,
  // which deepStrictEqual rejects even when every key and value matches.
  const counts = rows.map((r) => ({ role: r.role, runs: r.runs }));
  assert.deepEqual(counts, [
    { role: "investigator", runs: 2 },
    { role: "fact-finder", runs: 1 },
  ]);

  const mainLoop = openDb()
    .prepare(`SELECT json_extract(payload, '$.role') AS role FROM session_events WHERE kind = 'Stop'`)
    .all() as { role: string | null }[];
  assert.deepEqual(
    mainLoop.map((r) => ({ role: r.role })),
    [{ role: null }],
    "a main-loop event must record no role",
  );
});

test("an id without a role, and a role without an id, are both recorded", () => {
  // The two shapes the harness actually produces, and neither is degenerate.
  //
  // A `SubagentStop` naming only an `agentId` is the common case measured live. Recording
  // that id is what lets a later query attribute the run by joining it to the tool events
  // the same worker fired, which DO name the role - so dropping it because no role came
  // with it would throw away the only handle on that worker's return.
  //
  // A role with no id is the main thread of a session started with `--agent`, which is
  // exactly how a domain manager runs. It is not a worker run and must not be counted as
  // one, which is why the absence of `agentId` is the discriminator rather than a
  // convenience.
  logEvent("s-halves", 1, "SubagentStop", {
    activity: "subagent finished",
    state: "working",
    agentId: "a99c9983ff26e558a",
  });
  logEvent("s-halves", 2, "PreToolUse", {
    activity: "running Agent",
    state: "working",
    role: "domain-manager",
  });

  const rows = openDb()
    .prepare(
      `SELECT kind,
              json_extract(payload, '$.role')    AS role,
              json_extract(payload, '$.agentId') AS agent_id
         FROM session_events
        WHERE session_id = ?
        ORDER BY ts`,
    )
    .all("s-halves") as { kind: string; role: string | null; agent_id: string | null }[];

  assert.deepEqual(
    rows.map((r) => ({ kind: r.kind, role: r.role, agentId: r.agent_id })),
    [
      { kind: "SubagentStop", role: null, agentId: "a99c9983ff26e558a" },
      { kind: "PreToolUse", role: "domain-manager", agentId: null },
    ],
  );

  // And the discriminator itself, stated as the query a cost panel would run: a worker
  // run is a row with an id, whatever else it carries.
  const workerRuns = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM session_events
        WHERE session_id = ? AND json_extract(payload, '$.agentId') IS NOT NULL`,
    )
    .get("s-halves") as { n: number };
  assert.equal(workerRuns.n, 1, "the manager's own main-loop event is not a worker run");
});

test("the main thread of an --agent session names its role and no id", () => {
  // The shape `PreToolUse` sends for a domain manager, pinned on the wire rather than
  // only in the log: the schema must accept a role with no id, or the manager's own turns
  // fail ingest and the session goes dark at exactly the layer this change instruments.
  const mainThread = HookIngestSchema.parse({
    event: "PreToolUse",
    env: {},
    agentType: "domain-manager",
  });
  assert.equal(mainThread.agentType, "domain-manager");
  assert.equal(mainThread.agentId, undefined);
});
