import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsJsonState, parseAgentsJson } from "../src/server/discovery/agents-json.ts";

// `claude agents --json` is an unpublished shape we read from a binary that ships weekly.
// What is at stake is that a change to it degrades to "no reading" rather than to a
// confident wrong one: this feeds a comparison whose entire purpose is to tell us whether
// our own state is right, so a parser that invents data would corrupt the measurement it
// exists to take. The null-vs-empty distinction carries that weight and is asserted here.

test("parses a real payload, including the fields the comparison needs", () => {
  const recs = parseAgentsJson(
    JSON.stringify([
      {
        pid: 28039,
        id: "4f3c6018",
        cwd: "/repo",
        kind: "interactive",
        sessionId: "4f3c6018-088a-4df9-a1ff-9b1aad9536c7",
        name: "ai-harness-c5",
        status: "waiting",
        waitingFor: "input needed",
        state: "blocked",
      },
    ]),
  );
  assert.ok(recs);
  assert.equal(recs.length, 1);
  const [r] = recs;
  assert.ok(r);
  assert.equal(r.sessionId, "4f3c6018-088a-4df9-a1ff-9b1aad9536c7");
  assert.equal(r.status, "waiting");
  assert.equal(r.waitingFor, "input needed");
  assert.equal(r.kind, "interactive");
  assert.equal(r.pid, 28039);
});

test("a record with no status is data, not an error", () => {
  // Frequent and real: the daemon lists a session it has not heard from recently. It must
  // survive parsing and be counted, then skipped by the comparison - dropping it here
  // would silently shrink the denominator.
  const recs = parseAgentsJson(
    JSON.stringify([{ id: "abc12345", sessionId: "abc12345-0000-0000-0000-000000000000" }]),
  );
  assert.ok(recs);
  assert.equal(recs.length, 1);
  assert.equal(recs[0]?.status, undefined);
});

test("unreadable output is null, not an empty list", () => {
  // The distinction the caller depends on: [] means "nothing is running", null means "we
  // could not tell". Collapsing them would report every session as having vanished the
  // first time the CLI changed its output.
  assert.equal(parseAgentsJson(""), null);
  assert.equal(parseAgentsJson("   "), null);
  assert.equal(parseAgentsJson("not json"), null);
  assert.equal(parseAgentsJson('{"sessions":[]}'), null, "a non-array payload is unreadable");
  assert.deepEqual(parseAgentsJson("[]"), [], "an empty array is a successful reading");
});

test("a malformed entry is dropped without poisoning the batch", () => {
  const recs = parseAgentsJson(
    JSON.stringify([
      null,
      "nonsense",
      { nothing: "useful" },
      { id: "good1234", sessionId: "good1234-0000-0000-0000-000000000000", status: "busy" },
    ]),
  );
  assert.ok(recs);
  assert.equal(recs.length, 1);
  assert.equal(recs[0]?.id, "good1234");
});

test("a record carrying only sessionId keeps it and derives the short id", () => {
  const recs = parseAgentsJson(
    JSON.stringify([{ sessionId: "deadbeef-1111-2222-3333-444444444444", status: "idle" }]),
  );
  assert.ok(recs);
  assert.equal(recs[0]?.id, "deadbeef");
  assert.equal(recs[0]?.sessionId, "deadbeef-1111-2222-3333-444444444444");
});

test("status maps onto our vocabulary, and unknown maps to nothing", () => {
  assert.equal(agentsJsonState("idle"), "idle");
  assert.equal(agentsJsonState("busy"), "working");
  assert.equal(agentsJsonState("waiting"), "awaiting_input");
  assert.equal(agentsJsonState(undefined), null);
  assert.equal(agentsJsonState("something-new"), null, "an unknown status must not guess");
});
