// One rule names an agent on every surface (`inbox` preview flag). These pin every rank with
// whether it is a spoken name, the fallbacks between them, and the resident join the dashboard
// and the alert engine share.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_NAME_FALLBACK,
  agentDisplayName,
  agentNameColor,
  agentNamePair,
  sessionDisplayNameInput,
  withCurrentReferenceNames,
  type ResidentNameSource,
} from "../src/shared/display-name.ts";
import { agentNamePairView, agentNameView } from "../src/web/lib/agent-names.ts";
import { detectAlerts, stuckAlert } from "../src/shared/alerts.ts";
import type { Stall } from "../src/shared/stall.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

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
  const input = sessionDisplayNameInput({ name: "watcher-1", task: { id: "t-resident", title: "Watch lint", kind: "resident" as const } }, runs);
  assert.deepEqual(input, {
    callSign: null,
    resident: { referenceName: null, name: "Linter watcher", colorId: "teal" },
    taskTitle: "Watch lint",
    sessionName: "watcher-1",
  });
  const display = agentDisplayName(input);
  assert.equal(display.name, "Linter watcher");
  assert.equal(agentNameColor(input, display), "teal");
  assert.equal(sessionDisplayNameInput({ name: "o", task: { id: "t-odd", title: "x", kind: "resident" as const } }, runs).resident?.colorId, "cyan");
});

test("a session with no resident run is named by its task title, with no colour", () => {
  const input = sessionDisplayNameInput({ name: "fix-parser", task: { id: "t-plain", title: "Fix the parser", kind: "ship" as const } }, runs);
  assert.equal(input.resident, null);
  const display = agentDisplayName(input);
  assert.equal(display.name, "Fix the parser");
  assert.equal(agentNameColor(input, display), null);
  assert.equal(agentDisplayName(sessionDisplayNameInput({ name: "bare", task: null }, runs)).name, "bare");
});

test("with the flag off a surface prints exactly what it printed before", () => {
  const session = { name: "watcher-1", task: { id: "t-resident", title: "Watch lint", kind: "resident" as const } };
  assert.deepEqual(agentNameView(session, "watcher-1", false, runs), { name: "watcher-1", colorId: null });
  assert.deepEqual(agentNameView({ name: "", task: null }, "(unnamed)", false, runs), { name: "(unnamed)", colorId: null });
  assert.deepEqual(agentNameView(session, "watcher-1", true, runs), { name: "Linter watcher", colorId: "teal" });
  assert.deepEqual(agentNameView({ name: "fix", task: { id: "t", title: "Fix it", kind: "ship" as const } }, "fix", true, runs),
    { name: "Fix it", colorId: null });
});

test("with voice on, a session's call sign is its name, above its task title", () => {
  const session = { name: "s-9", task: { id: "t-plain", title: "Fix the parser", kind: "ship" as const, callSign: "Alice" } };
  const input = sessionDisplayNameInput(session, runs, true);
  assert.equal(input.callSign, "Alice");
  assert.deepEqual(agentDisplayName(input), { name: "Alice", source: "call-sign", spoken: true });
  assert.equal(agentNameColor(input, agentDisplayName(input)), null, "a session has no board colour");
  assert.deepEqual(agentNameView(session, "s-9", true, runs, true), { name: "Alice", colorId: null });
  assert.equal(agentNameView(session, "s-9", false, runs, true).name, "s-9", "the inbox flag off still prints what it printed before");
});

test("with voice off, a saved call sign or reference name names nothing, and the ranks below answer", () => {
  const session = { name: "s-9", task: { id: "t-plain", title: "Fix the parser", kind: "ship" as const, callSign: "Alice" } };
  assert.equal(sessionDisplayNameInput(session, runs).callSign, null, "off unless the caller says voice is on");
  assert.equal(sessionDisplayNameInput(session, runs, false).callSign, null);
  assert.deepEqual(agentNameView(session, "s-9", true, runs), { name: "Fix the parser", colorId: null });
  assert.deepEqual(agentNameView(session, "s-9", true, runs, false), { name: "Fix the parser", colorId: null });
  const named: ResidentNameSource[] = [
    { taskId: "t-resident", settings: { identity: { name: "Release Captain", referenceName: "Sage" }, board: { colorId: "teal" } } },
  ];
  const resident = { name: "w", task: { id: "t-resident", title: "Cut releases", kind: "resident" as const } };
  assert.equal(sessionDisplayNameInput(resident, named).resident?.referenceName, null);
  assert.deepEqual(agentNameView(resident, "w", true, named, false), { name: "Release Captain", colorId: "teal" });
  assert.deepEqual(agentNameView(resident, "w", true, named, true), { isReferenceName: true, name: '"Sage"', colorId: "teal" });
});

test("an alert names its agent by a call sign only while voice is on, in a toast and a stuck line alike", () => {
  const session = mkSession({ id: "s-alice", name: "s-alice", state: "idle", task: mkTaskSummary({ id: "t-alice", title: "Fix the parser", callSign: "Alice" }) });
  const stall: Stall = { sessionId: "s-alice", kind: "silent-working", forMs: 600_000, reason: "No output for a while." };
  assert.equal(stuckAlert(stall, [session], [], true).title, "Alice looks stuck");
  assert.equal(stuckAlert(stall, [session], [], false).title, "Fix the parser looks stuck");
  assert.equal(stuckAlert(stall, [session], []).title, "Fix the parser looks stuck", "absent reads as off");
  const scope = (spokenNames?: boolean) => ({
    sessions: [session], tasks: [], reviews: [], stalls: [stall], names: [],
    ...(spokenNames === undefined ? {} : { spokenNames }),
  });
  const before = { sessions: [session], tasks: [], reviews: [], stalls: [], names: [] };
  assert.equal(detectAlerts(before, scope(true)).find((alert) => alert.kind === "stuck")?.title, "Alice looks stuck");
  assert.equal(detectAlerts(before, scope(false)).find((alert) => alert.kind === "stuck")?.title, "Fix the parser looks stuck");
  assert.equal(detectAlerts(before, scope()).find((alert) => alert.kind === "stuck")?.title, "Fix the parser looks stuck");
});

test("with voice on, a resident's reference name wins over its profile name, in its board colour", () => {
  const named: ResidentNameSource[] = [
    { taskId: "t-resident", settings: { identity: { name: "Release Captain", referenceName: "Sage" }, board: { colorId: "teal" } } },
  ];
  const input = sessionDisplayNameInput({ name: "w", task: { id: "t-resident", title: "Cut releases", kind: "resident" as const } }, named, true);
  const display = agentDisplayName(input);
  assert.deepEqual(display, { name: "Sage", source: "reference-name", spoken: true });
  assert.equal(agentNameColor(input, display), "teal");
});

test("a resident's task never names it by a call sign, the rule the voice roster applies", () => {
  const named: ResidentNameSource[] = [
    { taskId: "t-resident", settings: { identity: { name: "Release Captain", referenceName: "Sage" }, board: { colorId: "teal" } } },
  ];
  const resident = { name: "w", task: { id: "t-resident", title: "Cut releases", kind: "resident" as const, callSign: "Will" } };
  assert.equal(sessionDisplayNameInput(resident, named, true).callSign, null);
  assert.deepEqual(agentNameView(resident, "w", true, named, true), { isReferenceName: true, name: '"Sage"', colorId: "teal" }, "its reference name answers");
  const plain: ResidentNameSource[] = [
    { taskId: "t-resident", settings: { identity: { name: "Release Captain" }, board: { colorId: "teal" } } },
  ];
  assert.deepEqual(agentNameView(resident, "w", true, plain, true), { name: "Release Captain", colorId: "teal" }, "or, with none, its profile name");
  assert.deepEqual(agentNameView(resident, "w", true, [], true), { name: "Cut releases", colorId: null },
    "and with its run not listed yet, its task title rather than the call sign");
});

test("the naming rule reads a running resident's reference name from its profile as it stands now", () => {
  const pinned = [
    { taskId: "t-a", profileId: "p-a", settings: { identity: { name: "Release Captain", referenceName: "Old" }, board: { colorId: "teal" } } },
    { taskId: "t-b", profileId: "p-b", settings: { identity: { name: "Linter watcher" }, board: { colorId: "violet" } } },
    { taskId: "t-c", profileId: "p-gone", settings: { identity: { name: "Gone", referenceName: "Kept" }, board: { colorId: "rose" } } },
  ];
  const current = withCurrentReferenceNames(pinned, [
    { id: "p-a", settings: { identity: { name: "Release Lead" } } },
    { id: "p-b", settings: { identity: { name: "Linter watcher", referenceName: "Steve" } } },
  ]);
  const nameOf = (taskId: string) => agentDisplayName(sessionDisplayNameInput({ name: "s", task: { id: taskId, title: "t", kind: "resident" as const } }, current, true)).name;
  assert.equal(nameOf("t-a"), "Release Lead", "a reference name taken off the profile is gone at once");
  assert.equal(agentDisplayName(sessionDisplayNameInput({ name: "s", task: { id: "t-a", title: "t", kind: "resident" } }, current, false)).name, "Release Captain");
  assert.equal(nameOf("t-b"), "Steve", "a reference name added to the profile names the running resident at once");
  assert.equal(nameOf("t-c"), "Kept", "a run whose profile is not listed keeps its pinned reference name");
  assert.equal(current[1]!.settings.identity.name, "Linter watcher", "the profile name stays pinned");
  assert.equal(withCurrentReferenceNames(pinned, []).length, 3);
});

test("a name pair keeps the title and carries the call sign or reference name beside it", () => {
  const full = { callSign: "Granite", resident: null, taskTitle: "Split the header", sessionName: "split-header" };
  assert.deepEqual(agentNamePair(full), {
    display: { name: "Split the header", source: "task-title", spoken: false },
    spoken: "Granite",
  });
  assert.deepEqual(agentNamePair({ resident, taskTitle: "Watch lint", sessionName: "w" }), {
    display: { name: "Linter watcher", source: "resident", spoken: true },
    spoken: "Steve",
  });
  assert.equal(agentNamePair({ ...full, callSign: "  " }).spoken, null, "a blank call sign is no call sign");
  assert.equal(agentNamePair({ callSign: "Echo", resident, sessionName: "w" }).spoken, "Echo", "a call sign outranks a reference name");
  assert.equal(agentNamePair({ callSign: " split  THE header ", taskTitle: "Split the header" }).spoken, null,
    "a call sign that repeats the title is not printed twice");
  assert.deepEqual(agentNamePair({ sessionName: "bare" }), {
    display: { name: "bare", source: "session-name", spoken: false },
    spoken: null,
  });
});

test("a pair view prints the title with the call sign beside it only while voice is on", () => {
  const session = { name: "s-9", task: { id: "t-plain", title: "Fix the parser", kind: "ship" as const, callSign: "Alice" } };
  assert.deepEqual(agentNamePairView(session, "s-9", true, runs, true), { name: "Fix the parser", colorId: null, callSign: "Alice" });
  assert.deepEqual(agentNamePairView(session, "s-9", true, runs, false), { name: "Fix the parser", colorId: null });
  assert.deepEqual(agentNamePairView(session, "s-9", false, runs, true), { name: "s-9", colorId: null },
    "the inbox flag off still prints what it printed before");
  const named: ResidentNameSource[] = [
    { taskId: "t-resident", settings: { identity: { name: "Release Captain", referenceName: "Sage" }, board: { colorId: "teal" } } },
  ];
  const residentSession = { name: "w", task: { id: "t-resident", title: "Cut releases", kind: "resident" as const } };
  assert.deepEqual(agentNamePairView(residentSession, "w", true, named, true),
    { name: "Release Captain", colorId: "teal", callSign: "Sage" });
  assert.deepEqual(agentNamePairView(residentSession, "w", true, named, false), { name: "Release Captain", colorId: "teal" });
});
