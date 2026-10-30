import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ResidentProfile, ResidentRunSummary } from "../src/shared/residents.ts";
import type { Session } from "../src/shared/types.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

// Phase 2 of residents: how a resident is FOUND. The board section of a profile revision, the
// pinned partition the board, the rail and the arrow keys all walk, the join from a session to
// its live run, and the two run frames' deliberate absence from the Line's inputs.

const home = mkdtempSync(join(tmpdir(), "mission-residents-board-"));
process.env.HARNESS_HOME = home;

const {
  RESIDENT_MARKER_COLORS,
  RESIDENT_RUN_NO_CONTROL,
  ResidentProfileRevisionSchema,
  ResidentProfileRevisionRequestSchema,
  defaultResidentMarkerLabel,
  residentMarker,
  residentRunSummary,
} = await import("../src/shared/residents.ts");
const { fleetRows, orderSessions } = await import("../src/web/lib/fleet-order.ts");
const {
  pinnedResidentSessions,
  residentChipTitle,
  residentMarkTitle,
  residentMarksBySession,
  residentProfileMark,
} = await import("../src/web/residents/marker.ts");
const { DISPLAY_ITEMS } = await import("../src/web/lib/board-card.ts");
const { UI_CONFIG_DEFAULTS } = await import("../src/shared/protocol.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ResidentBand } = await import("../src/web/residents/ResidentBand.tsx");
const { ResidentsDock } = await import("../src/web/residents/ResidentsDock.tsx");

function revision(board?: unknown, name = "Triage Bot") {
  return ResidentProfileRevisionSchema.parse({
    identity: { name },
    persona: { personaId: "builtin:fleet-triage" },
    ...(board === undefined ? {} : { board }),
  });
}

function summary(over: Partial<ResidentRunSummary> & { taskId: string }): ResidentRunSummary {
  return {
    id: `run-${over.taskId}`,
    profileId: "profile-1",
    profileRevision: 1,
    launchState: "launched",
    personaName: "Fleet Triage",
    compaction: { betweenIterations: true, nativeBackstop: false },
    loopState: "waiting" as const, iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null, pauseReason: null, wakeReason: null,
    settings: revision(),
    createdAt: 1,
    ...over,
  };
}

function profile(settings = revision(), over: Partial<ResidentProfile> = {}): ResidentProfile {
  return {
    id: "profile-1",
    name: settings.identity.name,
    revision: 1,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    settings,
    ...over,
  };
}

// ---- the board section ----

test("a revision saved before the board section existed reads with the board defaults", () => {
  const old = revision();
  assert.deepEqual(old.board, { colorId: RESIDENT_MARKER_COLORS[0].id, label: null, pin: true });
  assert.deepEqual(residentMarker(old), { colorId: "cyan", label: "TB", pin: true });
});

test("the marker label is 1 to 4 characters and defaults from the name", () => {
  assert.equal(defaultResidentMarkerLabel("Triage Bot"), "TB");
  assert.equal(defaultResidentMarkerLabel("Triage"), "TRI");
  assert.equal(defaultResidentMarkerLabel("docs gardener weekly run extra"), "DGWR");
  assert.equal(defaultResidentMarkerLabel("   "), "RES");
  // Capped AFTER upper-casing, by grapheme: `ß` upper-cases to `SS`, and four such initials
  // would otherwise make an eight-character label.
  assert.equal(defaultResidentMarkerLabel("ßa ßb ßc ßd"), "SSSS");
  assert.equal(defaultResidentMarkerLabel("ßtraße"), "SSTR");
  assert.equal(defaultResidentMarkerLabel("e\u0301clair Bot"), "\u00c9B".normalize("NFD"));
  assert.equal(residentMarker(revision({ label: "ops" })).label, "ops");

  const body = { identity: { name: "Triage Bot" }, persona: { personaId: "p" } };
  assert.equal(ResidentProfileRevisionRequestSchema.safeParse({ ...body, board: { label: "ABCD" } }).success, true);
  assert.equal(ResidentProfileRevisionRequestSchema.safeParse({ ...body, board: { label: "ABCDE" } }).success, false);
  assert.equal(ResidentProfileRevisionRequestSchema.safeParse({ ...body, board: { label: "  " } }).success, false);
});

test("a color id this build does not know reads as the first palette color rather than failing the revision", () => {
  const newer = revision({ colorId: "chartreuse" });
  assert.equal(newer.board.colorId, "chartreuse", "the stored id is preserved for the build that wrote it");
  assert.equal(residentMarker(newer).colorId, "cyan");
  // A color is a palette id, never a raw value.
  assert.equal(ResidentProfileRevisionSchema.safeParse({ ...newer, board: { colorId: "#ff0000" } }).success, false);
});

test("the palette ids are append-only and each names a CSS token", async () => {
  // Persisted by id, so the first eight are fixed forever, in order.
  assert.deepEqual(
    RESIDENT_MARKER_COLORS.slice(0, 8).map((color) => color.id),
    ["cyan", "violet", "amber", "rose", "lime", "blue", "orange", "teal"],
  );
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  for (const color of RESIDENT_MARKER_COLORS) {
    assert.match(css, new RegExp(`--resident-${color.id}:\\s*#[0-9a-f]{6};`), `no token for ${color.id}`);
  }
});

// ---- the run summary and the join ----

test("only a live run has a wire summary", () => {
  const run = {
    id: "r1",
    profileId: "p1",
    profileRevision: 3,
    taskId: "t1",
    launchRequestId: "req",
    launchState: "launched" as const,
    launchError: null,
    loopState: "waiting" as const, iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null, pauseReason: null, wakeReason: null,
    workspaceDir: null,
    persona: { personaId: "x", name: "Fleet Triage", guidanceMarkdown: "long text" },
    runInstructions: "today",
    settings: revision(),
    control: RESIDENT_RUN_NO_CONTROL,
    createdAt: 5,
    endedAt: null,
  };
  assert.deepEqual(residentRunSummary(run), {
    id: "r1",
    profileId: "p1",
    profileRevision: 3,
    taskId: "t1",
    launchState: "launched",
    personaName: "Fleet Triage",
    compaction: { betweenIterations: true, nativeBackstop: false },
    loopState: "waiting" as const, iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null, pauseReason: null, wakeReason: null,
    settings: { identity: run.settings.identity, board: run.settings.board, authority: run.settings.authority, loop: run.settings.loop },
    createdAt: 5,
  });
  // Projected to the sections the browser draws: the instruction text, Persona id, execution
  // and workspace stay on the daemon.
  const wire = JSON.stringify(residentRunSummary({
    ...run,
    settings: { ...run.settings, instructions: { markdown: "SECRET-INSTRUCTION-TEXT" } },
  }));
  assert.doesNotMatch(wire, /SECRET-INSTRUCTION-TEXT|builtin:fleet-triage|defaultRepoRoot|"execution"/);
  assert.equal(residentRunSummary({ ...run, endedAt: 9 }), null);
  assert.equal(residentRunSummary({ ...run, launchState: "failed", endedAt: 9 }), null);
  assert.notEqual(residentRunSummary({ ...run, launchState: "pending" }), null);
});

test("a session joins its run through its task id; every other session is absent", () => {
  const resident = mkSession({ id: "s-res", task: mkTaskSummary({ id: "task-res", kind: "resident" }) });
  const plain = mkSession({ id: "s-plain", task: mkTaskSummary({ id: "task-plain" }) });
  const bare = mkSession({ id: "s-bare", task: null });
  const marks = residentMarksBySession(
    [resident, plain, bare],
    [summary({ taskId: "task-res" })],
    [profile()],
  );
  assert.deepEqual([...marks.keys()], ["s-res"]);
  assert.equal(marks.get("s-res")!.name, "Triage Bot");
  assert.equal(marks.get("s-res")!.changedTo, null);
  assert.equal(residentMarksBySession([resident], [], [profile()]).size, 0);
});

test("a profile's marker is a chip mark, with no run fields to fill in", () => {
  const mark = residentProfileMark(profile(revision({ colorId: "amber", label: "REL" }, "Release Watch"), { revision: 3 }));
  assert.deepEqual(mark, { name: "Release Watch", colorId: "amber", label: "REL", pin: true, revision: 3 });
  assert.equal(residentChipTitle(mark), "Resident Release Watch (revision 3), pinned to the top of its column.");
  // A running session's sentence adds what only a run can know.
  const [session] = residentMarksBySession(
    [mkSession({ id: "s", task: mkTaskSummary({ id: "t" }) })],
    [summary({ taskId: "t" })],
    [profile(revision(), { revision: 2 })],
  ).values();
  assert.equal(
    residentMarkTitle(session!),
    "Resident Triage Bot (revision 1), pinned to the top of its column. Its profile has changed since launch (now revision 2).",
  );
});

// ---- the pinned partition ----

const IDLE: Partial<Session> = { state: "idle", activity: null };

function s(name: string, over: Partial<Session> = {}): Session {
  return mkSession({ id: `s-${name}`, name, pid: 1, ...over });
}

function ids(sessions: readonly Session[]): string[] {
  return sessions.map((session) => session.id);
}

test("pinned residents sort first within each column, and every other session keeps its order", () => {
  const fleet = [s("alpha"), s("bravo"), s("zulu"), s("charlie", IDLE), s("yankee", IDLE)];
  const before = orderSessions(fleet);
  const after = orderSessions(fleet, new Set(), false, undefined, undefined, new Set(["s-zulu", "s-yankee"]));
  const column = (order: typeof before, tone: string) => ids(order.groups.find((g) => g.tone === tone)!.sessions);

  assert.deepEqual(column(before, "working"), ["s-alpha", "s-bravo", "s-zulu"]);
  assert.deepEqual(column(after, "working"), ["s-zulu", "s-alpha", "s-bravo"]);
  assert.deepEqual(column(after, "idle"), ["s-yankee", "s-charlie"]);
  // The tone rule still holds: a pin never moves a session into another column.
  assert.deepEqual(
    after.groups.map((g) => g.sessions.length),
    before.groups.map((g) => g.sessions.length),
  );
  // Idempotent, so App, the board and the console rail cannot disagree.
  const twice = orderSessions(after.sessions, new Set(), false, undefined, undefined, new Set(["s-zulu", "s-yankee"]));
  assert.deepEqual(ids(twice.sessions), ids(after.sessions));
  // An empty pin set is the order before pinning existed, byte for byte.
  assert.deepEqual(ids(orderSessions(fleet, new Set(), false, undefined, undefined, new Set()).sessions), ids(before.sessions));
});

test("pinned sits ahead of free and held, and the held boundary still lands where the held sessions start", () => {
  const fleet = [s("alpha", IDLE), s("bravo", IDLE), s("zulu", IDLE)];
  const order = orderSessions(fleet, new Set(["s-alpha"]), false, undefined, undefined, new Set(["s-zulu"]));
  const idle = order.groups.find((g) => g.tone === "idle")!;
  assert.deepEqual(ids(idle.sessions), ["s-zulu", "s-bravo", "s-alpha"]);
  assert.equal(idle.heldFrom, 2);
  const rows = fleetRows(idle);
  assert.deepEqual(rows.map((row) => (row.kind === "section" ? `${row.section}:${row.count}` : row.kind)), [
    "free:2",
    "session",
    "session",
    "held:1",
    "session",
  ]);
  // A pinned session is never also held: pin wins.
  const both = orderSessions(fleet, new Set(["s-zulu"]), false, undefined, undefined, new Set(["s-zulu"]));
  const idleBoth = both.groups.find((g) => g.tone === "idle")!;
  assert.deepEqual(ids(idleBoth.sessions), ["s-zulu", "s-alpha", "s-bravo"]);
  assert.equal(idleBoth.heldFrom, null);
});

test("with repository grouping on, a pinned resident still leads its column", () => {
  const fleet = [
    s("alpha", { repoRoot: "/repo/a" }),
    s("bravo", { repoRoot: "/repo/a" }),
    s("zulu", { repoRoot: "/repo/z" }),
  ];
  const order = orderSessions(fleet, new Set(), true, undefined, undefined, new Set(["s-zulu"]));
  const working = order.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(ids(working.sessions), ["s-zulu", "s-alpha", "s-bravo"]);
  assert.deepEqual(working.repos.map((span) => [span.repoRoot, span.startIndex, span.length]), [
    ["/repo/z", 0, 1],
    ["/repo/a", 1, 2],
  ]);
});

test("the pin set comes from the run's pinned revision", () => {
  const pinned = mkSession({ id: "s-pinned", task: mkTaskSummary({ id: "t-pinned" }) });
  const loose = mkSession({ id: "s-loose", task: mkTaskSummary({ id: "t-loose" }) });
  const marks = residentMarksBySession(
    [pinned, loose],
    [summary({ taskId: "t-pinned" }), summary({ taskId: "t-loose", settings: revision({ pin: false }) })],
    [],
  );
  assert.deepEqual([...pinnedResidentSessions(marks)], ["s-pinned"]);
  assert.deepEqual([...pinnedResidentSessions(undefined)], []);
});

// ---- the registries ----

test("the resident marker is a card Display item that ships visible", () => {
  const item = DISPLAY_ITEMS.find((entry) => entry.id === "residentMarker");
  assert.ok(item, "residentMarker is in no registry entry");
  assert.equal(item.group, "card");
  assert.equal(UI_CONFIG_DEFAULTS.hiddenDisplayItems.includes("residentMarker"), false);
});

test("resident run frames are not Line inputs: they never schedule a Line recompute", () => {
  const registry = new Registry();
  let recomputes = 0;
  (registry as unknown as { scheduleLineRecompute(): void }).scheduleLineRecompute = () => {
    recomputes += 1;
  };
  registry.upsertResidentRun(summary({ taskId: "t1" }));
  registry.removeResidentRun("run-t1");
  assert.equal(recomputes, 0);
  // The control: a frame that IS a Line input does schedule one, so the spy is wired.
  registry.upsertSchedule({
    id: "sch",
    name: "x",
    enabled: true,
    archivedAt: null,
  } as unknown as Parameters<typeof registry.upsertSchedule>[0]);
  assert.ok(recomputes > 0, "the spy never saw a recompute, so it proves nothing");
});

// ---- rendering ----

test("the Console band names the resident from its pinned revision and reports a changed profile", () => {
  const [mark] = residentMarksBySession(
    [mkSession({ id: "s", task: mkTaskSummary({ id: "t" }) })],
    [summary({ taskId: "t", settings: revision({ colorId: "violet", label: "OPS" }) })],
    [profile(revision(), { revision: 4 })],
  ).values();
  const html = renderToStaticMarkup(createElement(ResidentBand, { mark: mark!, onOpenProfile: () => {} }));
  assert.match(html, /class="resident-band"/);
  assert.match(html, /--resident:var\(--resident-violet\)/);
  assert.match(html, /aria-label="Resident Triage Bot"/);
  assert.match(html, />OPS</);
  assert.match(html, /Fleet Triage · revision 1 · pinned/);
  assert.match(html, /Profile changed since launch \(now revision 4\)/);
  assert.match(html, />Profile</);
});

test("the Residents button names its live count and opens nothing until pressed", () => {
  const html = renderToStaticMarkup(createElement(ResidentsDock, {
    runs: [summary({ taskId: "t1" }), summary({ taskId: "t2" })],
    profiles: [profile()],
    sessions: [],
    onOpenSession: () => {},
    onOpenLaunch: () => {},
    onManage: () => {},
  }));
  assert.match(html, /aria-label="Residents - 2 live"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /class="residents-count">2</);
  assert.doesNotMatch(html, /role="dialog"/);
});
