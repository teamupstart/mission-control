// F17: the start-up banner is one pure builder shared by every harness.
import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TYPES } from "../src/shared/types.ts";
import {
  BANNER_COMMAND_HINT,
  BANNER_MAX_COLUMNS,
  BANNER_MENU_HINT,
  BANNER_VERSION_MISMATCH,
  bannerWidth,
  dispatchBanner,
} from "../src/shared/home-dispatch-banner.ts";
import { AGENT_IDENTITY } from "../src/shared/agent.ts";

const base = { counts: { running: 2, waiting: 1 }, menuOffered: true, versionMismatch: false };

test("F17 banner: three lines, at most 72 columns, in both versions, for every harness", () => {
  for (const harness of AGENT_TYPES) {
    for (const color of [true, false]) {
      for (const counts of [{ running: 0, waiting: 0 }, { running: 2, waiting: 1 }, { running: 999, waiting: 999 }]) {
        for (const menuOffered of [true, false]) {
          const lines = dispatchBanner({ ...base, harness, counts, menuOffered, color });
          assert.equal(lines.length, 3);
          for (const line of lines) assert.ok(bannerWidth(line) <= BANNER_MAX_COLUMNS, harness + ": " + line);
        }
      }
    }
  }
});

test("F17 banner: the plain version is ASCII with no escape character", () => {
  for (const harness of AGENT_TYPES) {
    const text = dispatchBanner({ ...base, harness, color: false }).join("\n");
    assert.ok([...text].every((ch) => ch === "\n" || (ch >= " " && ch <= "~")), text);
    assert.ok(!text.includes("\u001b"));
  }
});

test("F17 banner: colour uses SGR codes only and every line ends with a reset", () => {
  for (const harness of AGENT_TYPES) {
    for (const line of dispatchBanner({ ...base, harness, color: true })) {
      assert.ok(line.endsWith("\u001b[0m"), line);
      const escapes = line.match(/\u001b\[[^m]*[A-Za-z]/g) ?? [];
      assert.ok(escapes.every((e) => e.endsWith("m")), "only SGR (m) sequences: " + escapes.join(" "));
    }
  }
});

test("F17 banner: line 2 is the tagline from the agent registry, so each harness names itself", () => {
  for (const harness of AGENT_TYPES) {
    const [, tagline] = dispatchBanner({ ...base, harness, color: false });
    assert.equal(tagline, "| " + AGENT_IDENTITY[harness].label + " x Mission Control");
  }
  assert.ok(dispatchBanner({ ...base, harness: "claude", color: false })[1]!.includes("Claude Code x Mission Control"));
});

test("F17 banner: line 3 shows the counts and the hint for the menu or the command", () => {
  const line3 = (over: Partial<Parameters<typeof dispatchBanner>[0]>) =>
    dispatchBanner({ ...base, harness: "claude", color: false, ...over })[2];
  assert.equal(line3({}), "| 2 running | 1 waiting on you | " + BANNER_MENU_HINT);
  assert.equal(line3({ menuOffered: false }), "| 2 running | 1 waiting on you | " + BANNER_COMMAND_HINT);
  assert.equal(BANNER_COMMAND_HINT, "/mission-dispatch opens the menu");
});

test("F17 banner: nothing running when both counts are zero", () => {
  const line = dispatchBanner({ ...base, harness: "pi", color: false, counts: { running: 0, waiting: 0 } })[2];
  assert.equal(line, "| nothing running | " + BANNER_MENU_HINT);
});

test("F17 banner: a version mismatch replaces the whole of line 3", () => {
  for (const color of [true, false]) {
    const line = dispatchBanner({ ...base, harness: "codex", color, versionMismatch: true })[2];
    assert.ok(line.includes(BANNER_VERSION_MISMATCH));
    assert.ok(!line.includes("running"));
  }
  assert.equal(BANNER_VERSION_MISMATCH, "hook and daemon versions differ | run mctl doctor");
});
