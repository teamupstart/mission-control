import assert from "node:assert/strict";
import test from "node:test";
import {
  bulkPauseTargets,
  countFrozenFor,
  countPausedFor,
  isFrozen,
  pauseAge,
  pauseFlagLabel,
  type SessionPause,
} from "../src/shared/pause.ts";
import type { Session } from "../src/shared/types.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import { fleetPauseView } from "../src/web/lib/fleet-pause.ts";
import { withControl } from "../src/web/lib/pause-controls.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InProgressRow } from "../src/web/components/InProgressRow.tsx";

// What is at stake: these are the words and counts every pause control prints, decided once.
// A paused session that reads "working", a count that includes the priority session, or a
// card flag that hides why it is paused would each tell the operator the wrong thing.

const NOW = 10_000_000;

function pause(reason: SessionPause["reason"], phase: SessionPause["phase"] = "frozen", since = NOW - 14 * 60_000): SessionPause {
  return { reason, phase, since, interrupted: null, stopped: phase === "frozen" };
}

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    state: "working",
    stateConfirmed: true,
    pendingReviews: 0,
    pause: null,
    ...extra,
  } as Session;
}

test("a pause's age is compact, and a fresh one does not tick seconds", () => {
  assert.equal(pauseAge(NOW - 5_000, NOW), "<1m");
  assert.equal(pauseAge(NOW - 14 * 60_000, NOW), "14m");
  assert.equal(pauseAge(NOW - 3 * 3_600_000, NOW), "3h");
  assert.equal(pauseAge(NOW - 2 * 86_400_000, NOW), "2d");
});

test("the card flag says why a session is paused", () => {
  assert.equal(pauseFlagLabel(pause("operator"), NOW), "Paused · 14m");
  assert.equal(pauseFlagLabel(pause("fleet"), NOW), "Fleet paused");
  assert.equal(pauseFlagLabel(pause("priority"), NOW), "Paused for priority");
  assert.equal(pauseFlagLabel(pause("operator", "pending"), NOW), "Pausing after this turn");
});

test("a bulk pause takes every live, unpaused session but the one excepted", () => {
  const list = [
    session("a"),
    session("b", { pause: pause("operator") }),
    session("c", { state: "exited" }),
    session("d", { state: "stopping" }),
    session("p"),
  ];
  assert.deepEqual(bulkPauseTargets(list, "p").map((s) => s.id), ["a"]);
  assert.equal(countPausedFor(list, "operator"), 1);
});

test("a paused session reads paused but keeps its column", () => {
  const working = session("a", { pause: pause("operator") });
  assert.deepEqual(stateDisplay(working), { label: "paused", tone: "working" });
  const idle = session("b", { state: "idle", pause: pause("fleet", "pending") });
  assert.deepEqual(stateDisplay(idle), { label: "pausing", tone: "idle" });
  assert.equal(stateDisplay(session("c", { state: "exited", pause: pause("fleet") })).label, "exited");
});

test("the fleet fold counts what each control prints", () => {
  const view = fleetPauseView(
    [
      session("p"),
      session("x", { pause: pause("priority") }),
      session("y", { pause: pause("operator") }),
      session("z"),
      session("gone", { state: "exited", pause: pause("fleet") }),
    ],
    { fleet: null, priority: { sessionId: "p", since: NOW } },
  );
  assert.equal(view.live, 4);
  assert.equal(view.paused, 2);
  assert.equal(view.pausedForPriority, 1);
  assert.equal(view.pausedForFleet, 0, "an exited session is not counted");
  assert.equal(view.pausable, 2);
  assert.equal(view.priorityName, "p");
});

test("a control list toggles one id without duplicating or dropping others", () => {
  assert.deepEqual(withControl(["chip"], "corner", true), ["chip", "corner"]);
  assert.deepEqual(withControl(["chip", "corner"], "chip", true), ["corner", "chip"]);
  assert.deepEqual(withControl(["chip", "corner"], "chip", false), ["corner"]);
  assert.deepEqual(withControl([], "menu", false), []);
});

test("a frozen turn's in-progress row stands still and says it is paused", () => {
  const frozen = renderToStaticMarkup(createElement(InProgressRow, {
    agentLabel: "Claude",
    activity: "Running npm test",
    terminal: false,
    startedAt: NOW - 90_000,
    frozenAt: NOW - 30_000,
  }));
  assert.match(frozen, /turn-progress is-frozen/);
  assert.match(frozen, /Paused at .* · was Running npm test/);
  assert.doesNotMatch(frozen, /⟳/);
  const running = renderToStaticMarkup(createElement(InProgressRow, {
    agentLabel: "Claude",
    activity: "Running npm test",
    terminal: false,
    startedAt: null,
  }));
  assert.doesNotMatch(running, /is-frozen/);
  assert.match(running, /⟳/);
});

test("the Pause all banner calls only frozen sessions frozen, and says when some are still running", async () => {
  const { FleetPauseBanner } = await import("../src/web/components/FleetPauseControl.tsx");
  const { FleetPauseContext } = await import("../src/web/lib/fleet-pause.ts");
  const state = { fleet: { since: NOW, resumeAt: null, holdDispatch: true }, priority: null };
  const render = (sessions: Session[]) =>
    renderToStaticMarkup(
      createElement(FleetPauseContext.Provider, { value: fleetPauseView(sessions, state) }, createElement(FleetPauseBanner)),
    );

  const partial = render([
    session("frozen", { pause: pause("fleet") }),
    session("refused", { pause: pause("fleet", "pending") }),
  ]);
  assert.match(partial, /aria-label="Paused, but not everything is frozen"/);
  assert.match(partial, /1 session frozen, 1 session held but not frozen, and automatic launches are held/);
  assert.doesNotMatch(partial, /Everything is paused/);
  assert.match(partial, /is-partial/);

  const whole = render([session("a", { pause: pause("fleet") }), session("b", { pause: pause("fleet") })]);
  assert.match(whole, /aria-label="Everything is paused"/);
  assert.match(whole, /2 sessions frozen, and automatic launches are held/);
  assert.doesNotMatch(whole, /still running/);
});

test("the fleet fold separates frozen from held", () => {
  const view = fleetPauseView(
    [
      session("f1", { pause: pause("fleet") }),
      session("f2", { pause: pause("fleet", "pending") }),
      session("p1", { pause: pause("priority", "pending") }),
    ],
    { fleet: null, priority: null },
  );
  assert.equal(view.pausedForFleet, 2);
  assert.equal(view.frozenForFleet, 1);
  assert.equal(view.pausedForPriority, 1);
  assert.equal(view.frozenForPriority, 0);
});

test("a pause that settled with nothing stopped is a hold, never counted or shown as frozen", () => {
  // A Pi driver runs inside the daemon: its pause settles with no process stopped.
  const held = session("pi", { pause: { reason: "fleet", phase: "frozen", since: NOW, interrupted: null, stopped: false } });
  const frozen = session("claude", { pause: pause("fleet") });
  assert.equal(isFrozen(held), false);
  assert.equal(isFrozen(frozen), true);
  assert.equal(countFrozenFor([held, frozen], "fleet"), 1);
});
