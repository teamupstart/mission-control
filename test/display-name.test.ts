// One rule names an agent on every surface (`inbox` preview flag). These pin every rank with
// whether it is a spoken name, the fallbacks between them, and the resident join the dashboard
// and the alert engine share.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_NAME_FALLBACK,
  agentDisplayName,
  agentNameColor,
  sessionDisplayNameInput,
  type ResidentNameSource,
} from "../src/shared/display-name.ts";
import { agentNameView } from "../src/web/lib/agent-names.ts";

const resident = { referenceName: "Steve", name: "Linter watcher", colorId: "violet" as const };

test("each rank wins over every rank below it", () => {
  const full = { callSign: "Echo", resident, taskTitle: "Add a linter", sessionName: "add-a-linter" };
  assert.deepEqual(agentDisplayName(full), { name: "Echo", source: "call-sign", spoken: true });
  assert.deepEqual(agentDisplayName({ ...full, callSign: null }),
    { name: "Steve", source: "reference-name", spoken: true });
  assert.deepEqual(agentDisplayName({ ...full, callSign: null, resident: { ...resident, referenceName: null } }),
    { name: "Linter watcher", source: "resident", spoken: true });
  assert.deepEqual(agentDisplayName({ ...full, callSign: null, resident: null }),
    { name: "Add a linter", source: "task-title", spoken: false });
  assert.deepEqual(agentDisplayName({ sessionName: "add-a-linter" }),
    { name: "add-a-linter", source: "session-name", spoken: false });
  assert.deepEqual(agentDisplayName({}), { name: AGENT_NAME_FALLBACK, source: "fallback", spoken: false });
  assert.equal(AGENT_NAME_FALLBACK, "a session");
});

test("a blank value falls through to the next rank, and a kept one is trimmed", () => {
  assert.deepEqual(
    agentDisplayName({ callSign: "  ", resident: { ...resident, referenceName: "", name: " " }, taskTitle: "", sessionName: " s-1 " }),
    { name: "s-1", source: "session-name", spoken: false },
  );
  assert.equal(agentDisplayName({ taskTitle: "  Fix the parser " }).name, "Fix the parser");
});

const runs: ResidentNameSource[] = [
  { taskId: "t-resident", settings: { identity: { name: "Linter watcher" }, board: { colorId: "teal" } } },
  // A stored colour this build no longer knows draws in the palette's first colour, as the board does.
  { taskId: "t-odd", settings: { identity: { name: "Odd" }, board: { colorId: "not-a-colour" } } },
];

test("a session joins its resident run through its task, and takes the resident's colour", () => {
  const input = sessionDisplayNameInput({ name: "watcher-1", task: { id: "t-resident", title: "Watch lint" } }, runs);
  assert.deepEqual(input, {
    resident: { name: "Linter watcher", colorId: "teal" },
    taskTitle: "Watch lint",
    sessionName: "watcher-1",
  });
  const display = agentDisplayName(input);
  assert.equal(display.name, "Linter watcher");
  assert.equal(agentNameColor(input, display), "teal");
  assert.equal(sessionDisplayNameInput({ name: "o", task: { id: "t-odd", title: "x" } }, runs).resident?.colorId, "cyan");
});

test("a session with no resident run is named by its task title, with no colour", () => {
  const input = sessionDisplayNameInput({ name: "fix-parser", task: { id: "t-plain", title: "Fix the parser" } }, runs);
  assert.equal(input.resident, null);
  const display = agentDisplayName(input);
  assert.equal(display.name, "Fix the parser");
  assert.equal(agentNameColor(input, display), null);
  assert.equal(agentDisplayName(sessionDisplayNameInput({ name: "bare", task: null }, runs)).name, "bare");
});

test("with the flag off a surface prints exactly what it printed before", () => {
  const session = { name: "watcher-1", task: { id: "t-resident", title: "Watch lint" } };
  assert.deepEqual(agentNameView(session, "watcher-1", false, runs), { name: "watcher-1", colorId: null });
  assert.deepEqual(agentNameView({ name: "", task: null }, "(unnamed)", false, runs), { name: "(unnamed)", colorId: null });
  assert.deepEqual(agentNameView(session, "watcher-1", true, runs), { name: "Linter watcher", colorId: "teal" });
  assert.deepEqual(agentNameView({ name: "fix", task: { id: "t", title: "Fix it" } }, "fix", true, runs),
    { name: "Fix it", colorId: null });
});
