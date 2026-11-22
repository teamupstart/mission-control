// Headless mode phase 5: the start-up banner builder (spec 7.21, acceptance F17).
import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TYPES } from "../src/shared/types.ts";
import {
  BANNER_MAX_COLUMNS,
  HARNESS_BANNER_MARKS,
  MISSION_CONTROL_MARK,
  dispatchBanner,
  dispatchBannerPlain,
} from "../src/shared/home-dispatch-banner.ts";
import { AGENT_IDENTITY } from "../src/shared/agent.ts";

const base = { counts: { running: 2, waiting: 1 }, menuOffered: false, versionMismatch: false } as const;

test("the banner is three lines, each at most 72 columns, for every harness", () => {
  for (const harness of AGENT_TYPES) {
    for (const counts of [{ running: 0, waiting: 0 }, { running: 3, waiting: 12 }, { running: 99999, waiting: 99999 }]) {
      for (const menuOffered of [true, false]) {
        for (const versionMismatch of [true, false]) {
          const lines = dispatchBannerPlain({ harness, counts, menuOffered, versionMismatch });
          assert.equal(lines.length, 3);
          for (const line of lines) assert.ok(line.length <= BANNER_MAX_COLUMNS, `${line.length}: ${line}`);
        }
      }
    }
  }
});

test("the display name and mark come from the harness registry, not a branch", () => {
  assert.deepEqual(Object.keys(HARNESS_BANNER_MARKS).sort(), [...AGENT_TYPES].sort());
  for (const harness of AGENT_TYPES) {
    const [first] = dispatchBanner({ ...base, harness });
    assert.ok(first!.text.includes(AGENT_IDENTITY[harness].label), harness);
    const mark = first!.spans.find((span) => span.role === "harness-mark");
    assert.equal(first!.text.slice(mark!.start, mark!.end), HARNESS_BANNER_MARKS[harness]);
    assert.equal(mark!.color, AGENT_IDENTITY[harness].accent);
    assert.equal([...HARNESS_BANNER_MARKS[harness]].length, 1, "a single-width mark keeps the layout still");
  }
  assert.equal([...MISSION_CONTROL_MARK].length, 1);
});

test("line 3 says the counts, then the hint", () => {
  const third = (over: object) => dispatchBannerPlain({ harness: "claude", ...base, ...over })[2];
  assert.equal(third({ menuOffered: false }), "2 running | 1 waiting on you | /mission-dispatch opens the menu");
  assert.equal(third({ menuOffered: true }), "2 running | 1 waiting on you | I will ask how you want to start");
});

test("both counts zero read nothing running, with the same hints", () => {
  const zero = { running: 0, waiting: 0 };
  assert.equal(dispatchBannerPlain({ harness: "claude", ...base, counts: zero })[2], "nothing running | /mission-dispatch opens the menu");
  assert.equal(
    dispatchBannerPlain({ harness: "codex", ...base, counts: zero, menuOffered: true })[2],
    "nothing running | I will ask how you want to start",
  );
  const waitingOnly = dispatchBannerPlain({ harness: "pi", ...base, counts: { running: 0, waiting: 4 } })[2];
  assert.match(waitingOnly!, /^0 running \| 4 waiting on you/);
});

test("a version mismatch replaces the whole line", () => {
  for (const menuOffered of [true, false]) {
    assert.equal(
      dispatchBannerPlain({ harness: "claude", ...base, menuOffered, versionMismatch: true })[2],
      "mod and daemon versions differ | run mctl doctor",
    );
  }
});

test("the counts are marked as spans, and spans point at the text they name", () => {
  const [first, , third] = dispatchBanner({ harness: "claude", ...base });
  assert.equal(first!.text.slice(first!.spans[0]!.start, first!.spans[0]!.end), MISSION_CONTROL_MARK);
  const running = third!.spans.find((span) => span.role === "running")!;
  const waiting = third!.spans.find((span) => span.role === "waiting")!;
  assert.equal(third!.text.slice(running.start, running.end), "2");
  assert.equal(third!.text.slice(waiting.start, waiting.end), "1");
  assert.deepEqual(dispatchBanner({ harness: "claude", ...base, counts: { running: 0, waiting: 0 } })[2]!.spans, []);
});

test("no line carries an escape code", () => {
  for (const line of dispatchBannerPlain({ harness: "claude", ...base })) assert.ok(!line.includes("\u001b"));
});

test("counts show as typed up to 999 and as 999+ beyond", () => {
  const third = (running: number, waiting: number) =>
    dispatchBannerPlain({ harness: "claude", ...base, counts: { running, waiting } })[2];
  assert.equal(third(999, 999), "999 running | 999 waiting on you | /mission-dispatch opens the menu");
  assert.equal(third(1000, 1000), "999+ running | 999+ waiting on you | /mission-dispatch opens the menu");
  assert.equal(third(0, 0), "nothing running | /mission-dispatch opens the menu");
});
