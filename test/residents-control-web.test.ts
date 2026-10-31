import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ResidentProfileRevisionSchema, residentLaunchSummary, type ResidentRunSummary } from "../src/shared/residents.ts";
import { ResidentBand } from "../src/web/residents/ResidentBand.tsx";
import { ResidentsDock } from "../src/web/residents/ResidentsDock.tsx";
import { RESIDENT_EDITOR_SECTIONS } from "../src/web/residents/editor-sections.tsx";
import { residentLaunchControlReport, residentRunControlOutcome } from "../src/web/residents/launch.ts";
import { residentSessionMark } from "../src/web/residents/marker.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

// What the browser says about a resident's session control: the profile's off-by-default
// Authority section, the launch summary, the run's answer, and the band and dock row's live
// "control granted" / "control not granted" with the existing session control menu.

function revision(controlOtherSessions?: boolean) {
  return ResidentProfileRevisionSchema.parse({
    identity: { name: "Triage Bot" },
    persona: { personaId: "builtin:fleet-triage" },
    ...(controlOtherSessions === undefined ? {} : { authority: { controlOtherSessions } }),
  });
}

function run(controlOtherSessions: boolean): ResidentRunSummary {
  const settings = revision(controlOtherSessions);
  return {
    id: "run-1",
    profileId: "profile-1",
    profileRevision: 1,
    taskId: "task-1",
    launchState: "launched",
    personaName: "Fleet Triage",
    compaction: { betweenIterations: true, nativeBackstop: false },
    loopState: "waiting", iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null, pauseReason: null, wakeReason: null,
    settings: { identity: settings.identity, board: settings.board, authority: settings.authority, loop: settings.loop },
    createdAt: 1,
  };
}

function session(sessionControlEnabled: boolean) {
  return mkSession({ id: "sdk:res", state: "idle", sessionControlEnabled, task: mkTaskSummary({ id: "task-1", kind: "resident" }) });
}

test("Control other sessions is off by default, and a revision from before it reads as off", () => {
  assert.deepEqual(revision().authority, { controlOtherSessions: false });
  assert.match(residentLaunchSummary(revision(), "Fleet Triage", "Claude Code"), /control: off$/);
  assert.match(residentLaunchSummary(revision(true), "Fleet Triage", "Claude Code"), /control: on$/);
  const section = RESIDENT_EDITOR_SECTIONS.find((entry) => entry.id === "authority");
  assert.ok(section, "the editor has an Authority section");
  const html = renderToStaticMarkup(createElement(section.Body, {
    draft: revision(),
    update: () => {},
    personas: [],
    disabled: false,
  }));
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /Control other sessions/);
  assert.match(html, /Only your Launch click in the Mission Control desktop app grants it/);
  assert.match(html, /A launch from the browser, or from anywhere else, starts\s+without session control/);
});

test("a launched run says whether its grant applied, only when its pinned revision asks", () => {
  const base = {
    loopState: "waiting" as const, iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null, pauseReason: null, wakeReason: null,
    id: "r", profileId: "p", profileRevision: 1, taskId: "t", launchRequestId: "q", workspaceDir: null,
    launchState: "launched" as const,
    launchError: null, persona: { personaId: "x", name: "X", guidanceMarkdown: "" }, runInstructions: "",
    createdAt: 1, endedAt: null,
  };
  const none = { authorizedAt: null, conversationId: null, cwd: null, episodeId: null };
  assert.equal(residentRunControlOutcome({ ...base, settings: revision(false), control: none }), null);
  assert.equal(residentRunControlOutcome({ ...base, settings: revision(true), control: none }), "not-granted");
  // A consumed click is not a grant: only a recorded, applied grant reads as granted.
  assert.equal(residentRunControlOutcome({ ...base, settings: revision(true), control: { ...none, authorizedAt: 5 } }), "pending");
  assert.equal(residentRunControlOutcome({
    ...base,
    settings: revision(true),
    control: { authorizedAt: 5, conversationId: "native-1", cwd: "/worktrees/t", episodeId: "episode-1" },
  }), "granted");
});

test("a launch surface reports a pending grant always, and an ungranted run unless it said so before launch", () => {
  const base = {
    loopState: "waiting" as const, iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null, pauseReason: null, wakeReason: null,
    id: "r", profileId: "p", profileRevision: 1, taskId: "t", launchRequestId: "q", workspaceDir: null,
    launchState: "launched" as const, launchError: null, persona: { personaId: "x", name: "X", guidanceMarkdown: "" },
    runInstructions: "", createdAt: 1, endedAt: null,
  };
  const none = { authorizedAt: null, conversationId: null, cwd: null, episodeId: null };
  const pending = { ...base, settings: revision(true), control: { ...none, authorizedAt: 5 } };
  const ungranted = { ...base, settings: revision(true), control: none };
  const granted = {
    ...base,
    settings: revision(true),
    control: { authorizedAt: 5, conversationId: "native-1", cwd: "/worktrees/t", episodeId: "episode-1" },
  };
  for (const saidBeforeLaunch of [false, true]) {
    assert.equal(residentLaunchControlReport(pending, saidBeforeLaunch), "pending");
    assert.equal(residentLaunchControlReport(granted, saidBeforeLaunch), null);
    assert.equal(residentLaunchControlReport({ ...base, settings: revision(false), control: none }, saidBeforeLaunch), null);
  }
  assert.equal(residentLaunchControlReport(ungranted, false), "not-granted", "the desktop Dispatch and the dock report it");
  assert.equal(residentLaunchControlReport(ungranted, true), null, "the browser Dispatch already said so");
});

test("the band says control granted, or control not granted beside the existing menu", () => {
  const mark = residentSessionMark(run(true), null);
  const granted = renderToStaticMarkup(createElement(ResidentBand, { mark, session: session(true) }));
  assert.match(granted, />control granted</);
  assert.doesNotMatch(granted, /Session control: Off/);
  const notGranted = renderToStaticMarkup(createElement(ResidentBand, { mark, session: session(false) }));
  assert.match(notGranted, />control not granted</);
  assert.match(notGranted, /aria-label="Session control: Off"/, "the existing session control menu");
  // A profile that never asked says nothing, unless the operator granted control anyway.
  const off = residentSessionMark(run(false), null);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ResidentBand, { mark: off, session: session(false) })), /control (not )?granted/);
  assert.match(renderToStaticMarkup(createElement(ResidentBand, { mark: off, session: session(true) })), />control granted</);
});

test("the dock's live row carries the same status and menu", () => {
  const html = renderToStaticMarkup(createElement(ResidentsDock, {
    runs: [run(true)],
    profiles: [],
    sessions: [session(false)],
    defaultOpen: true,
    onOpenSession: () => {},
    onOpenLaunch: () => {},
    onManage: () => {},
  }));
  assert.match(html, /class="residents-pop-control"/);
  assert.match(html, />control not granted</);
  assert.match(html, /aria-label="Session control: Off"/);
});
