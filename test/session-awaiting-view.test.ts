import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeatureFlagsConfig } from "../src/shared/feature-flags.ts";
import type { SessionAwaiting } from "../src/shared/types.ts";
import { FeatureFlagsContext } from "../src/web/useFeatureFlag.ts";
import { readAwaiting, awaitingDuration } from "../src/web/lib/awaiting.ts";
import { AwaitingRailMark, AwaitingTileTrack, SessionAwaitingBand } from "../src/web/components/SessionAwaiting.tsx";
import { BoardView } from "../src/web/components/layouts/BoardView.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { ResidentSessionMark } from "../src/web/residents/marker.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// The dashboard's deadline track for a session awaiting a background process: one reading of
// the wait (`readAwaiting`) behind the card, the rail mark and the Conversation band, and every
// surface drawn only while the `session-awaiting` preview is on.

const MIN = 60_000;

function wait(over: Partial<SessionAwaiting> = {}): SessionAwaiting {
  const now = Date.now();
  return {
    id: "aw-view", what: "CI checks on PR #1612", wakeSource: "command", expectedBy: now + 9 * MIN + 30_000,
    referenceUrl: "https://github.com/teamupstart/mission-control/pull/1612/checks",
    details: "Started `gh pr checks 1612 --watch`.", startedAt: now - 12 * MIN, updatedAt: now - 12 * MIN,
    ...over,
  };
}

function render(el: React.ReactElement, enabled: boolean): string {
  const flags: FeatureFlagsConfig = { enableAll: false, overrides: { "session-awaiting": enabled } };
  return renderToStaticMarkup(createElement(FeatureFlagsContext.Provider, { value: flags }, el));
}

test("the reading counts time left up and time elapsed down, and fills toward the deadline", () => {
  const a = wait({ startedAt: 0, expectedBy: 20 * MIN });
  const early = readAwaiting(a, 5 * MIN);
  assert.equal(early.overdue, false);
  assert.equal(early.progress, 0.25);
  assert.equal(early.remaining, "15m left");
  assert.equal(readAwaiting(a, 20 * MIN - 10_000).remaining, "1m left", "under a minute left must not read 0m");
  const late = readAwaiting(a, 28 * MIN + 40_000);
  assert.equal(late.overdue, true);
  assert.equal(late.progress, 1);
  assert.equal(late.remaining, "8m late");
  assert.ok(late.overrun > 0 && late.overrun <= 0.5);
  assert.equal(awaitingDuration(65 * MIN), "1h 05m");
  assert.equal(readAwaiting({ ...a, wakeSource: "other" }, 0).wakePhrase, "wakes on its own");
});

test("the card draws what, the due time and a deadline track, and nothing while the preview is off", () => {
  const session = mkSession({ state: "idle", awaiting: wait() });
  const on = render(createElement(AwaitingTileTrack, { session }), true);
  assert.match(on, /class="tile-awaiting"/);
  assert.match(on, /Awaiting <b>CI checks on PR #1612<\/b>/);
  assert.match(on, /due \d{1,2}:\d{2}/);
  assert.match(on, /role="progressbar"/);
  assert.match(on, /10m left|9m left/);
  assert.equal(render(createElement(AwaitingTileTrack, { session }), false), "");
  assert.equal(render(createElement(AwaitingTileTrack, { session: mkSession({ awaiting: null }) }), true), "");
});

test("an overdue wait reads Overdue in amber with how late it is, on the card and the rail", () => {
  const now = Date.now();
  const session = mkSession({ state: "idle", awaiting: wait({ startedAt: now - 40 * MIN, expectedBy: now - 8 * MIN - 5_000 }) });
  const card = render(createElement(AwaitingTileTrack, { session }), true);
  assert.match(card, /class="tile-awaiting is-late"/);
  assert.match(card, /Overdue <b>CI checks on PR #1612<\/b>/);
  assert.match(card, /8m late/);
  assert.match(card, /was due/);
  assert.match(card, /awaiting-track-over/);
  const rail = render(createElement(AwaitingRailMark, { session }), true);
  assert.match(rail, /class="rail-awaiting is-late"/);
  assert.match(rail, />overdue</);
});

test("the Conversation band names the wait, how it wakes, its link and a Clear, never as a blocker", () => {
  const session = mkSession({ state: "idle", awaiting: wait() });
  const band = render(createElement(SessionAwaitingBand, { session }), true);
  assert.match(band, /aria-label="Session awaiting"/);
  assert.match(band, />Awaiting</);
  assert.match(band, /CI checks on PR #1612/);
  assert.match(band, /wakes when its background command finishes/);
  // The wait's age, beside its deadline: declared twelve minutes ago.
  assert.match(band, />waiting 12m</);
  assert.match(band, /href="https:\/\/github.com\/teamupstart\/mission-control\/pull\/1612\/checks"/);
  assert.match(band, />Clear</);
  assert.match(band, />Details</);
  assert.doesNotMatch(band, /blocker-band|btn-danger/, "a wait must not borrow the blocker's red");
  assert.equal(render(createElement(SessionAwaitingBand, { session }), false), "");
});

test("the Board's Idle head counts a pinned resident inside a wait as awaiting, not free", () => {
  const idle = { state: "idle" as const, activity: null };
  const resident = mkSession({ id: "res-1", name: "Release Watch", pid: 11, ...idle, awaiting: wait({ id: "aw-res" }) });
  const waiting = mkSession({ id: "aw-1", name: "Awaiting CI", pid: 12, ...idle, awaiting: wait({ id: "aw-plain" }) });
  const free = mkSession({ id: "free-1", name: "Docs cleanup", pid: 13, ...idle });
  const mark = {
    name: "Release Watch", colorId: "amber", label: "REL", pin: true, revision: 1, runId: "run-1", taskId: "task-1",
    profileId: "profile-1", personaName: null, changedTo: null, controlOtherSessions: false,
  } as unknown as ResidentSessionMark;
  const props = {
    sessions: [resident, waiting, free], tasks: [], backlog: [], onEditTask: () => {}, backlogPlan: null, selectedId: null,
    consoleZone: "rail", onConsoleZoneChange: () => {}, onSelect: () => {}, onCursorTo: () => {}, onDeselect: () => {},
    detailId: null, onOpenReviews: () => {}, onRequeue: () => {}, onOpenFiles: () => {}, onOpenFile: () => false,
    onOpenFilePath: () => {}, fileTabRequest: null, conversationTabRequest: null, workflowsTabRequest: null,
    diffTabRequest: null, files: {} as SessionFilesController, onReset: () => {}, onComplete: () => {}, onKill: () => {},
    onKilled: () => {}, resetNonces: {}, registerEl: () => {}, registerActions: () => {}, registerLaunchers: () => {},
    registerFind: () => {}, registerDetailScroll: () => {}, registerReaderTab: () => {}, renamingId: null,
    onRenameStart: () => {}, onRenameClose: () => {}, foremanMode: "dry-run", foremanEnabled: false, foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(), pendingReviewIds: new Set<string>(), reviews: [],
    residentBySession: new Map([["res-1", mark]]),
  } as unknown as SessionViewProps;
  const html = render(createElement(BoardView, props), true);
  const idleColumn = html.slice(html.indexOf('class="board-col tone-idle'));
  // Both waiting sessions are counted; the pin only decides where the resident's card sits.
  assert.match(idleColumn, /class="board-col-n n-awaiting"[^>]*>2 awaiting</);
  // Nothing is held, and the head still says how many can take work rather than the total.
  const headHtml = idleColumn.slice(0, idleColumn.indexOf("</header>"));
  assert.match(headHtml, /class="board-col-n n-free"[^>]*>1 free</);
  assert.doesNotMatch(headHtml, /class="board-col-n">3</, "the head drew the column total beside the awaiting count");
  assert.doesNotMatch(headHtml, /n-held/);
  assert.ok(idleColumn.indexOf("Release Watch") < idleColumn.indexOf("awaiting background work"),
    "the pinned resident left its pinned place for the Awaiting section");
  assert.match(idleColumn, /fleet-section-awaiting[\s\S]*?fleet-section-n">1</, "the section rule counts only the cards under it");
});
