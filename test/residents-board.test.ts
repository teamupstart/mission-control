import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ResidentProfile, ResidentRunSummary } from "../src/shared/residents.ts";
import type { ReviewItem, Session, SessionGoalSummary } from "../src/shared/types.ts";
import { mkSession, mkTask, mkTaskSummary } from "./helpers/session-fixture.ts";

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
  residentReplacementsBySession,
} = await import("../src/web/residents/marker.ts");
const { DISPLAY_ITEMS } = await import("../src/web/lib/board-card.ts");
const { UI_CONFIG_DEFAULTS } = await import("../src/shared/protocol.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ResidentBand, ResidentReplacedBand, residentReplacementSentence } = await import("../src/web/residents/ResidentBand.tsx");
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

test("a replaced session keeps its Complete offer through every state of its replacement", () => {
  const old = mkSession({ id: "s-old", name: "Agent Wrangler", task: mkTaskSummary({ id: "task-old", kind: "resident", status: "running" }) });
  const oldTask = mkTask({ id: "task-old", kind: "resident", status: "running", residentRestart: { replacementTaskId: "task-new", revision: 2 } });
  const newTask = mkTask({ id: "task-new", kind: "resident", status: "running" });
  const run = summary({ taskId: "task-new", profileRevision: 2 });
  const fresh = mkSession({ id: "s-new", task: mkTaskSummary({ id: "task-new", kind: "resident", status: "running" }) });
  const band = (replacement: ReturnType<typeof residentReplacementsBySession> extends ReadonlyMap<string, infer R> ? R : never) =>
    renderToStaticMarkup(createElement(ResidentReplacedBand, { replacement, onOpenSession: () => {}, onComplete: () => {} }));

  // Starting: the replacement run is reserved but its session has not appeared yet.
  const starting = residentReplacementsBySession([old], [oldTask, newTask], [run]).get("s-old")!;
  assert.deepEqual({ state: starting.state, sessionId: starting.sessionId, revision: starting.revision }, { state: "starting", sessionId: null, revision: 2 });
  assert.equal(residentReplacementSentence(starting), "Restarting on revision 2 in a new session. This session no longer wakes.");
  assert.match(band(starting), /<button[^>]*disabled=""[^>]*>Open new session<\/button>/);
  assert.match(band(starting), /<button[^>]*>Complete &amp; close<\/button>/);

  // Live: the session appears, and Open new session becomes usable and names it.
  const live = residentReplacementsBySession([old, fresh], [oldTask, newTask], [run]).get("s-old")!;
  assert.deepEqual({ state: live.state, sessionId: live.sessionId }, { state: "live", sessionId: "s-new" });
  assert.doesNotMatch(band(live), /disabled/);
  assert.equal(residentReplacementsBySession([old, fresh], [oldTask, newTask], [run]).has("s-new"), false);

  // Stopped: the replacement was reserved but its run has ended. The offer to complete stays.
  const stopped = residentReplacementsBySession([old, fresh], [oldTask, { ...newTask, status: "done" }], []).get("s-old")!;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.name, "Agent Wrangler", "with no live run the band names the session itself");
  assert.equal(residentReplacementSentence(stopped), "Restarted on revision 2, but that session is no longer running. This session no longer wakes.");
  assert.doesNotMatch(band(stopped), /Open new session/);
  assert.match(band(stopped), /Complete &amp; close/);

  // Not started: Restart ended the run, but its launch failed before reserving a replacement.
  // No new session ever existed, so the band must not say one stopped.
  const notStarted = residentReplacementsBySession([old], [{ ...oldTask, residentRestart: { replacementTaskId: null, revision: null } }], []).get("s-old")!;
  assert.deepEqual({ state: notStarted.state, sessionId: notStarted.sessionId }, { state: "not-started", sessionId: null });
  assert.equal(residentReplacementSentence(notStarted), "Restart ended this run, but the new session did not start. This session no longer wakes.");
  assert.doesNotMatch(band(notStarted), /Open new session|no longer running/);
  assert.match(band(notStarted), /Complete &amp; close/);

  // Gone once the replaced task is completed.
  const doneOld = { ...old, task: mkTaskSummary({ id: "task-old", kind: "resident", status: "done" }) };
  assert.equal(residentReplacementsBySession([doneOld], [{ ...oldTask, status: "done" }], [run]).size, 0);
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

test("in Drawer placement the Residents button keeps its name and opens the drawer, never the dock", () => {
  const html = renderToStaticMarkup(createElement(ResidentsDock, {
    runs: [summary({ taskId: "t1" })],
    profiles: [profile()],
    sessions: [],
    // Even asked to start open, the dock's popover is not drawn behind a drawer.
    defaultOpen: true,
    onToggleDrawer: () => {},
    drawerOpen: true,
    onOpenSession: () => {},
    onOpenLaunch: () => {},
    onManage: () => {},
  }));
  assert.match(html, /class="ghost-btn residents-btn on"/);
  assert.match(html, /aria-label="Residents - 1 live"/);
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /role="dialog"/);
});

// ---- the Residents drawer: ⌥-number boundary and the empty state ----

const { ResidentDrawerCardBody, ResidentsDrawer, ResidentsEdgeTab, residentDrawerEntries } = await import("../src/web/residents/ResidentsDrawer.tsx");
const { residentShortcutIndex } = await import("../src/web/lib/keybindings.ts");
const { useResidentLaunches } = await import("../src/web/residents/useResidentLaunches.ts");

/** Ten live residents, oldest launch first, each with its own session. */
function tenResidents(): { runs: ResidentRunSummary[]; sessions: Session[] } {
  const runs: ResidentRunSummary[] = [];
  const sessions: Session[] = [];
  for (let n = 1; n <= 10; n += 1) {
    runs.push(summary({ taskId: `t${n}`, createdAt: n }));
    sessions.push(mkSession({ id: `s${n}`, task: mkTaskSummary({ id: `t${n}`, kind: "resident" }) }));
  }
  return { runs, sessions };
}

/** The drawer, pinned so it renders without an overlay host, with a stub launcher. */
function drawerMarkup(runs: ResidentRunSummary[], sessions: Session[]): string {
  const launcher: ReturnType<typeof useResidentLaunches> = { launches: {}, launch: async () => {} };
  return renderToStaticMarkup(createElement(ResidentsDrawer, {
    entries: residentDrawerEntries(runs, [profile()], sessions),
    profiles: [profile()],
    pinned: true,
    selectedId: null,
    onSelect: () => {},
    onOpen: () => {},
    onClose: () => {},
    onPinnedChange: () => {},
    launcher,
    onOpenLaunch: () => {},
    onManage: () => {},
    reviews: [],
    renderReview: () => null,
  }));
}

test("resident nine is ⌥9 and resident ten has no shortcut, in the order ⌥N opens", () => {
  const { runs, sessions } = tenResidents();
  const entries = residentDrawerEntries(runs, [profile()], sessions);
  assert.deepEqual(entries.map((entry) => entry.shortcut), [1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
  // ⌥9 is index 8, which is the ninth resident - the one printing ⌥9 - and no key reaches the tenth.
  const key = (code: string) => residentShortcutIndex({ code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false });
  assert.equal(entries[key("Digit9")!]!.session!.id, "s9");
  assert.equal(entries[key("Digit1")!]!.session!.id, "s1");
  assert.equal(key("Digit0"), null);

  // The drawer prints nine keycaps, ⌥1 … ⌥9, and nothing on the tenth card.
  const html = drawerMarkup(runs, sessions);
  const keycaps = [...html.matchAll(/class="residents-drawer-key"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(keycaps, ["⌥1", "⌥2", "⌥3", "⌥4", "⌥5", "⌥6", "⌥7", "⌥8", "⌥9"]);
  assert.equal((html.match(/data-resident-card=/g) ?? []).length, 10);
  assert.doesNotMatch(html, /⌥10/);
});

test("with no resident running, the drawer says so and the edge tab carries no number", () => {
  const html = drawerMarkup([], []);
  assert.match(html, /No residents are running\. Launch one from a profile below\./);
  assert.match(html, /Residents <span class="residents-drawer-count">· 0 live<\/span>/);
  assert.doesNotMatch(html, /data-resident-card=/);
  // The footer still offers the profiles.
  assert.match(html, /aria-label="Launch Triage Bot"/);

  const empty = renderToStaticMarkup(createElement(ResidentsEdgeTab, { live: 0, needsYou: false, onOpen: () => {} }));
  assert.match(empty, /aria-label="Open the Residents drawer - 0 live"/);
  assert.doesNotMatch(empty, /residents-edge-count/);
  assert.doesNotMatch(empty, /needs-you/);
  const one = renderToStaticMarkup(createElement(ResidentsEdgeTab, { live: 1, needsYou: true, onOpen: () => {} }));
  assert.match(one, /class="residents-edge-count"[^>]*>1</);
  assert.match(one, /class="residents-edge-tab needs-you"/);
});

// ---- the selected card's body: the ask, the latest message, and the reply box ----

/** A resident's open `request_input` question with two options. */
function residentAsk(sessionId: string): ReviewItem {
  return {
    id: "rv-1", sessionId, kind: "input", status: "pending",
    title: "Ship the nightly migration?", body: "Ship the nightly migration?",
    decisions: [{ id: "q", question: "Ship the nightly migration?", options: [
      { id: "yes", label: "Ship it" }, { id: "no", label: "Hold it" },
    ], allowOther: false }],
    response: null, createdAt: 1, resolvedAt: null,
  } as ReviewItem;
}

/** The body as the drawer draws it, with the injected review renderer stubbed to a marker. */
function cardBodyMarkup(session: Session, reviews: ReviewItem[] = []): string {
  return renderToStaticMarkup(createElement(ResidentDrawerCardBody, {
    session,
    name: "Triage Bot",
    reviews,
    renderReview: (review: ReviewItem) => createElement("section", { className: "stub-review-card" }, review.title),
    children: createElement("div", { className: "residents-drawer-actions" }, "actions"),
  }));
}

test("with a pending ask, the selected card draws it through the injected ReviewCard and keeps the reply box", () => {
  const session = mkSession({ id: "s1", activity: "checking the nightly job" });
  const html = cardBodyMarkup(session, [residentAsk("s1")]);
  assert.match(html, /aria-label="Triage Bot is asking"/);
  assert.match(html, /<section class="stub-review-card">Ship the nightly migration\?<\/section>/);
  // The ask replaces the latest-message line rather than stacking under it.
  assert.doesNotMatch(html, /residents-drawer-latest/);
  assert.doesNotMatch(html, /checking the nightly job/);
  assert.match(html, /<textarea[^>]*aria-label="Reply to Triage Bot"/);
  // The card's own actions stay, after the new content.
  assert.ok(html.indexOf("Reply to Triage Bot") < html.indexOf("residents-drawer-actions"));
});

test("a menu the resident is parked on is drawn as the Conversation draws it, its rows as buttons", () => {
  const session = mkSession({
    id: "s1",
    paneDialog: { prompt: "Run npm test?", options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }], highlighted: 1 },
  });
  const html = cardBodyMarkup(session);
  assert.match(html, /aria-label="Triage Bot is asking"/);
  assert.match(html, /Run npm test\?/);
  assert.match(html, /<button[^>]*>(?:(?!<\/button>).)*Yes/);
  assert.doesNotMatch(html, /residents-drawer-latest/);
});

test("with nothing asked, the selected card shows the latest message and a reply box", () => {
  const html = cardBodyMarkup(mkSession({ id: "s1", activity: "checking the nightly job" }));
  assert.match(html, /<p class="residents-drawer-latest" aria-label="Latest from Triage Bot">checking the nightly job<\/p>/);
  assert.doesNotMatch(html, /is asking/);
  assert.match(html, /<textarea[^>]*aria-label="Reply to Triage Bot"[^>]*placeholder="Reply to Triage Bot…"/);
  // The send chord is printed on the button; the keycap stays out of its accessible name.
  assert.match(html, />Send <kbd class="residents-drawer-reply-key" aria-hidden="true">⌘⏎<\/kbd><\/button>/);
});

test("a resident that cannot be messaged gets no reply box, and its actions remain", () => {
  // A terminal session with no pane: `canMessage` says no, as it does to the Conversation's box.
  const html = cardBodyMarkup(mkSession({ id: "s1", terminals: [], activity: "checking the nightly job" }));
  assert.doesNotMatch(html, /Reply to Triage Bot/);
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /checking the nightly job/);
  assert.match(html, /residents-drawer-actions/);
});

test("with no activity line, the latest message falls back to the session's goal", () => {
  const html = cardBodyMarkup(mkSession({ id: "s1", activity: null, goal: { text: "keep the nightly job green", source: null, updatedAt: 1 } }));
  assert.match(html, /<p class="residents-drawer-latest" aria-label="Latest from Triage Bot">keep the nightly job green<\/p>/);
});

test("the activity line wins over the goal when both are present", () => {
  const html = cardBodyMarkup(mkSession({ id: "s1", activity: "checking the nightly job", goal: { text: "keep the nightly job green", source: null, updatedAt: 1 } }));
  assert.match(html, /aria-label="Latest from Triage Bot">checking the nightly job<\/p>/);
  assert.doesNotMatch(html, /keep the nightly job green/);
});

test("with neither an activity line nor a goal, the card draws no empty latest-message line", () => {
  for (const goal of [null, { text: null, source: null, updatedAt: 1 } satisfies SessionGoalSummary]) {
    const html = cardBodyMarkup(mkSession({ id: "s1", activity: null, goal }));
    assert.doesNotMatch(html, /residents-drawer-latest/);
    assert.doesNotMatch(html, /Latest from/);
    // The reply box and the actions are still drawn.
    assert.match(html, /aria-label="Reply to Triage Bot"/);
    assert.match(html, /residents-drawer-actions/);
  }
});
