// Which voice states title cards by spoken names, and which call sign a session's card prints.
// The Board, the Console rail and the Residents drawer read both through App, so these pin the
// rule each surface follows: Always-on while it listens, and Push-to-talk between holds and
// during one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionCallSign } from "../src/shared/display-name.ts";
import { VOICE_MODES, voiceCardsShowSpokenNames, voiceMode, type VoiceModeInputs } from "../src/shared/voice.ts";
import { residentSessionMark } from "../src/web/residents/marker.ts";
import type { ResidentRunSummary } from "../src/shared/residents.ts";

const SESSION = "6f0c8a1e-6a4f-4d55-9c39-3f7f0d5b2a10";
const base: VoiceModeInputs = {
  enabled: true, reasons: [], muted: false, callActive: false, autoMuteDuringCalls: true, pushToTalk: false,
};
/** The state the daemon publishes: a shortcut session exactly when Push-to-talk is the mode. */
const state = (inputs: Partial<VoiceModeInputs>) => ({
  mode: voiceMode({ ...base, ...inputs }),
  ...(inputs.listeningMode === "push-to-talk" && { pushToTalkSession: SESSION }),
});

test("cards show spoken names while Always-on listens and in Push-to-talk between holds and during one", () => {
  assert.equal(voiceCardsShowSpokenNames(state({ listeningMode: "always-on" })), true, "Always-on listening");
  assert.equal(voiceCardsShowSpokenNames(state({ listeningMode: "push-to-talk" })), true, "Push-to-talk waiting for the hotkey");
  assert.equal(voiceCardsShowSpokenNames(state({ listeningMode: "push-to-talk", pushToTalk: true })), true, "Push-to-talk held");
  assert.equal(voiceCardsShowSpokenNames(state({ listeningMode: "push-to-talk", muted: true })), true,
    "Always-on's saved mute does not apply to Push-to-talk");
});

test("muted, auto-muted, unavailable and off keep the ordinary names", () => {
  assert.equal(voiceCardsShowSpokenNames(state({ listeningMode: "always-on", muted: true })), false, "muted");
  assert.equal(voiceCardsShowSpokenNames(state({ listeningMode: "always-on", callActive: true })), false, "auto-muted for a call");
  const callHold = state({ listeningMode: "always-on", callActive: true, pushToTalk: true });
  assert.equal(callHold.mode, "push-to-talk", "a hold during an Always-on call reads push-to-talk");
  assert.equal(voiceCardsShowSpokenNames(callHold), false, "but carries no shortcut session, so Always-on keeps its call behavior");
  assert.equal(voiceCardsShowSpokenNames(state({ listeningMode: "push-to-talk", reasons: ["shortcut"] })), false, "unavailable");
  assert.equal(voiceCardsShowSpokenNames(state({ enabled: false })), false, "off");
  assert.equal(voiceCardsShowSpokenNames(null), false, "no voice state yet");
});

test("every voice mode has a decided answer", () => {
  const shown = VOICE_MODES.filter((mode) => voiceCardsShowSpokenNames({ mode, pushToTalkSession: SESSION }));
  assert.deepEqual(shown, ["listening", "push-to-talk", "waiting-for-key"]);
});

test("a session's card call sign is its task's, trimmed, and never a resident's", () => {
  assert.equal(sessionCallSign({ task: { kind: "ship", callSign: "Atlas" } }), "Atlas");
  assert.equal(sessionCallSign({ task: { kind: "chat", callSign: "  Atlas  " } }), "Atlas");
  assert.equal(sessionCallSign({ task: { kind: "ship", callSign: "   " } }), null, "a blank one names nothing");
  assert.equal(sessionCallSign({ task: { kind: "ship" } }), null, "none set");
  assert.equal(sessionCallSign({ task: null }), null, "no task");
  assert.equal(sessionCallSign({}), null, "an ad hoc session");
  assert.equal(sessionCallSign({ task: { kind: "resident", callSign: "Will" } }), null, "a resident answers to its profile's names");
});

test("a resident mark carries its quoted reference name exactly when cards show spoken names", () => {
  const run = {
    id: "run-1", taskId: "t-1", profileId: "p-1", profileRevision: 1, personaName: null,
    settings: {
      identity: { name: "Drawer watcher", referenceName: "Marlowe" },
      board: { colorId: "teal" },
      authority: { controlOtherSessions: false },
    },
  } as unknown as ResidentRunSummary;
  for (const inputs of [{ listeningMode: "always-on" as const }, { listeningMode: "push-to-talk" as const },
    { listeningMode: "push-to-talk" as const, pushToTalk: true }]) {
    const mark = residentSessionMark(run, null, voiceCardsShowSpokenNames(state(inputs)));
    assert.equal(mark.listeningTitle, '"Marlowe"', JSON.stringify(inputs));
  }
  const muted = residentSessionMark(run, null, voiceCardsShowSpokenNames(state({ listeningMode: "always-on", muted: true })));
  assert.equal(muted.listeningTitle, undefined, "muted Always-on keeps the profile name");
});
