/**
 * What is at stake: the one switch in this app that can type into somebody's live agent
 * session used to live in a floating drawer on another page - no rail row, no scope badge,
 * no deep link, and invisible to settings search. Moving it into a category is only worth
 * anything if the controls came WITH it, so this pins that the panel actually draws Live
 * delivery, its allowlist, the retention fields and the health counters, each on the anchor
 * the search index points at.
 *
 * Two further claims are pinned here because a static render cannot reach them and getting
 * either wrong is silent. The pre-poll panel must say the daemon has not answered rather
 * than present "off, no repos" as fact - the Inspector panel's rule, and the same failure:
 * an operator reads a safe posture that may not be in force. And the retention gate has to
 * ask before SHORTENING a limit, because the next sweep acts on it and compaction is not
 * reversible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkflowSettingsPanel,
  readRetention,
  retentionShortens,
} from "../src/web/components/WorkflowSettingsPanel.tsx";
import {
  applyWorkflowPoll,
  pollIsLatest,
  pollRacedByWrite,
  type WorkflowSettingsState,
} from "../src/web/useWorkflowSettings.ts";
import type { WorkflowConfig } from "../src/shared/workflow.ts";
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowStatus } from "../src/shared/workflow.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

const STATUS: WorkflowStatus = {
  activeRuns: 2,
  queuedPersonaCalls: 1,
  runningPersonaCalls: 0,
  waitingDeliveries: 3,
  uncertainDeliveries: 1,
  inspectorGates: 0,
  lastRecoveryAt: null,
  lastRetentionAt: null,
  lastRetentionError: null,
  retainedRunCount: 42,
  lastRetentionCompacted: 0,
  lastRetentionDeleted: 0,
};

function state(over: Partial<WorkflowSettingsState> = {}): WorkflowSettingsState {
  return {
    config: null,
    status: null,
    update: async () => true,
    error: null,
    ...over,
  };
}

function render(over: Partial<WorkflowSettingsState> = {}): string {
  return renderToStaticMarkup(
    withOverlayHost(createElement(WorkflowSettingsPanel, { state: state(over) })),
  );
}

const ANSWERED = {
  config: { ...DEFAULT_WORKFLOW_CONFIG, repoAllowlist: ["/src/mission-control"] },
  status: STATUS,
};

test("every control the search index points at is on the panel", () => {
  const html = render(ANSWERED);
  for (const anchor of [
    "workflows/live-delivery",
    "workflows/allowlist",
    "workflows/retention",
    "workflows/health",
  ]) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), `panel is missing ${anchor}`);
  }
});

// The anchors have to survive the pre-poll render too: `settings-sidebar-render.test.ts`
// walks a statically rendered page, and a control that only appears once a fetch lands is
// one a deep link from search cannot scroll to on arrival.
test("the anchors are drawn before the daemon has answered", () => {
  const html = render();
  for (const anchor of [
    "workflows/live-delivery",
    "workflows/allowlist",
    "workflows/retention",
    "workflows/health",
  ]) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), `pre-poll panel is missing ${anchor}`);
  }
});

test("the Live delivery switch is a toggle row, off and disabled before the first read", () => {
  const html = render();
  const row = /<label class="alert-row wf-settings-live"[^>]*data-anchor="workflows\/live-delivery"[^>]*>(.*?)<\/label>/s
    .exec(html);
  assert.ok(row, "Live delivery should be an app toggle row, not a bare checkbox");
  assert.match(row[1]!, /type="checkbox"/);
  assert.doesNotMatch(row[1]!, /checked/, "pre-poll must not draw Live as enabled");
  assert.match(row[1]!, /disabled/, "pre-poll must not accept a click it cannot honour");
  assert.match(html, /Enable Live workflow delivery/);
});

test("with no answer from the daemon the panel says so rather than showing defaults as fact", () => {
  const html = render();
  assert.match(html, /wf-settings-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /No repositories yet - Live delivery has nowhere to send/,
    "an unanswered panel must not assert an empty allowlist",
  );
  assert.match(
    html,
    /Workflow health is unavailable/,
    "an unanswered panel must not draw health counters it does not have",
  );
});

test("an answered panel lists the allowlist and the health counters", () => {
  const html = render(ANSWERED);
  assert.doesNotMatch(html, /wf-settings-unknown/);
  assert.match(html, /<code>\/src\/mission-control<\/code>/);
  assert.match(html, /Remove<\/button>/);
  // The counters come from the status payload, not from a placeholder.
  assert.match(html, /Retained runs<\/dt><dd>42<\/dd>/);
  assert.match(html, /Waiting deliveries<\/dt><dd>3<\/dd>/);
  assert.match(html, /Uncertain deliveries<\/dt><dd>1<\/dd>/);
});

test("an empty allowlist says Live delivery has nowhere to send", () => {
  const html = render({ config: DEFAULT_WORKFLOW_CONFIG, status: STATUS });
  assert.match(html, /No repositories yet - Live delivery has nowhere to send/);
});

// The consent sentence is part of the feature, not decoration: it is what an operator reads
// before allowing a paste into a session they may be watching.
test("Live enabled flies the sentence saying what it does", () => {
  const off = render(ANSWERED);
  assert.doesNotMatch(off, /wf-settings-live-warn/, "an off switch must not fly the warning");
  const on = render({
    config: { ...ANSWERED.config, liveEnabled: true },
    status: STATUS,
  });
  assert.match(on, /wf-settings-live-warn/);
  // The apostrophe arrives HTML-escaped, so the phrase is matched around it.
  assert.match(on, /A repair packet is typed into the agent.{0,8}s own composer/);
});

// The retention boxes are typed text, so the read has to refuse a half-entered number
// rather than PUT a NaN. The ranges restated in the panel are the daemon's own.
test("retention refuses values outside the ranges the daemon enforces", () => {
  const ok = readRetention({
    rawEvidenceDays: "30",
    completedRunDays: "180",
    maxCompletedRuns: "1000",
  });
  assert.deepEqual(ok, {
    ok: true,
    value: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
  });
  for (const bad of [
    { rawEvidenceDays: "0", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "366", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "30", completedRunDays: "29", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "30", completedRunDays: "180", maxCompletedRuns: "99" },
    { rawEvidenceDays: "30.5", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "thirty", completedRunDays: "180", maxCompletedRuns: "1000" },
  ]) {
    const read = readRetention(bad);
    assert.equal(read.ok, false, `${JSON.stringify(bad)} should be refused`);
    // A sentence naming the field and its range, not a bare "invalid".
    if (!read.ok) assert.match(read.error, /between \d+ and [\d,]+/);
  }
});

// Only a SHORTENING needs the confirm: the next sweep can then compact or delete history
// today's limits would have kept, and neither is reversible. Lengthening one, or leaving
// them alone, must save without a dialog - a confirm on every Apply is one nobody reads.
test("only a shortened limit asks first", () => {
  const current = DEFAULT_WORKFLOW_CONFIG.retention;
  assert.equal(retentionShortens(current, current), false);
  assert.equal(
    retentionShortens({ ...current, rawEvidenceDays: current.rawEvidenceDays + 1 }, current),
    false,
  );
  for (const key of ["rawEvidenceDays", "completedRunDays", "maxCompletedRuns"] as const) {
    assert.equal(
      retentionShortens({ ...current, [key]: current[key] - 1 }, current),
      true,
      `a shorter ${key} should ask`,
    );
  }
});

test("a write refused by the daemon is reported, not swallowed", () => {
  const html = render({ ...ANSWERED, error: "Workflow manager unavailable" });
  assert.match(html, /class="settings-error" role="alert">Workflow manager unavailable/);
});

// A failed read is UNKNOWN, and unknown replaces the last good reading rather than
// deferring to it. This is the defect the Inspector caught on round 1 of #258: the poll
// applied each read only `if (next)`, so once the daemon stopped answering the panel went
// on presenting the queue depths, the last sweep and the Live-delivery switch as its
// current answer - indefinitely, and with every "the daemon has not said" affordance
// (the unknown banner, the disabled controls, the unavailable-health line) keyed on a null
// that could no longer arrive.
//
// Driven through the pure rule rather than the hook: the hook's decision lives in an
// effect, and this runner has no DOM to run one in.
const CONFIG: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: true };
const SAVED: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: false };

test("a poll that could not read is unknown, not the last thing that was true", () => {
  // Both reads failed while a good reading was on screen: both go unknown.
  assert.deepEqual(
    applyWorkflowPoll({ config: null, status: null }, false, CONFIG),
    { config: null, status: null },
  );
  // One read failed and the other did not - they are independent, so a healthy status does
  // not vouch for a config nobody could read, or the other way round.
  assert.deepEqual(
    applyWorkflowPoll({ config: CONFIG, status: null }, false, CONFIG),
    { config: CONFIG, status: null },
  );
  assert.deepEqual(
    applyWorkflowPoll({ config: null, status: STATUS }, false, CONFIG),
    { config: null, status: STATUS },
  );
  // And an ordinary successful poll still lands both.
  assert.deepEqual(
    applyWorkflowPoll({ config: CONFIG, status: STATUS }, false, null),
    { config: CONFIG, status: STATUS },
  );
});

// The one exception, and the reason the rule takes the race as an argument: a PUT that
// landed after this poll's GET left holds the newer truth. Without this, a poll that raced
// a save would repaint the pre-write config - and a poll whose read FAILED would null out a
// config the operator had just successfully saved, which is the same lie in the other
// direction.
test("a config read that lost a race with a write is dropped, failed or not", () => {
  assert.equal(applyWorkflowPoll({ config: CONFIG, status: STATUS }, true, SAVED).config, SAVED);
  assert.equal(applyWorkflowPoll({ config: null, status: STATUS }, true, SAVED).config, SAVED);
  // Status is never raced - nothing in this panel writes it - so it lands either way.
  assert.equal(applyWorkflowPoll({ config: null, status: STATUS }, true, SAVED).status, STATUS);
});

// The race the Inspector caught on round 2 of #258, and the reason the write clock counts
// in-flight writes rather than bumping one generation number.
//
// The window that matters opens at the CLICK, not when the daemon answers. A poll issued
// just after a save started reads the pre-write config, finds a generation counter exactly
// where it left it, and applies that read over the operator's optimistic value - so Live
// delivery snapped back to off for the length of the write and flipped on again when the
// PUT landed. Measured at ~7 seconds in a browser against a deliberately slowed write:
// `11000000000000000000000000000001111111111111111111` sampled every 250ms.
const IDLE = { completed: 3, inFlight: 0 };

test("a poll is raced by a write that merely OVERLAPS it, not only one that finished", () => {
  // Nothing happening on either side: the poll's reads are trusted.
  assert.equal(pollRacedByWrite(IDLE, IDLE), false);

  // A write was already in flight when the reads went out - the defect's exact shape, and
  // the one a generation counter cannot see, because nothing has completed yet.
  assert.equal(
    pollRacedByWrite({ completed: 3, inFlight: 1 }, { completed: 3, inFlight: 1 }),
    true,
  );
  // A write started while the reads were out and is still going.
  assert.equal(pollRacedByWrite(IDLE, { completed: 3, inFlight: 1 }), true);
  // A write began AND finished entirely inside the poll's window: `inFlight` is zero at
  // both readings, so only `completed` shows it.
  assert.equal(pollRacedByWrite(IDLE, { completed: 4, inFlight: 0 }), true);
  // The in-flight write from the first case, now landed.
  assert.equal(
    pollRacedByWrite({ completed: 3, inFlight: 1 }, { completed: 4, inFlight: 0 }),
    true,
  );
});

// A poll that starts after everything has settled is trusted again - the guard must not
// latch. If it did, the panel would quietly stop updating after the first save, which is
// the same "showing something that is no longer true" failure in a slower form.
test("the race guard clears once writes have settled", () => {
  assert.equal(pollRacedByWrite({ completed: 4, inFlight: 0 }, { completed: 4, inFlight: 0 }), false);
});

// The reorder the Inspector caught on round 3 of #258. The interval starts a tick whether
// or not the previous one's requests are still out, so two polls can be in flight and need
// not land in the order they left - and an older one landing last repaints what IT read.
//
// Not merely a display problem, which is why it was the major of the three: every save on
// this panel spreads the config it is holding, so an operator acting inside that window
// writes the obsolete blob back. Measured against a held response: the switch came on,
// went off for nearly three seconds, then came on again
// (`000000000001111100000001111111111111111111111111111111111111` at 400ms).
test("a poll that has been overtaken is dropped, however late it lands", () => {
  // Polls landing in order: each is the newest when it arrives.
  assert.equal(pollIsLatest(1, 0), true);
  assert.equal(pollIsLatest(2, 1), true);
  // Poll 3 landed first and was applied; polls 1 and 2 arriving afterwards are stale.
  assert.equal(pollIsLatest(2, 3), false);
  assert.equal(pollIsLatest(1, 3), false);
  // A poll cannot apply twice - the same id is no longer newer than itself.
  assert.equal(pollIsLatest(3, 3), false);
});
