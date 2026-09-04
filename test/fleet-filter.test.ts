import assert from "node:assert/strict";
import test from "node:test";

import { matchesSessionFilter } from "../src/web/lib/fleet-filter.ts";
import { mkSession } from "./helpers/session-fixture.ts";

test("a session matches the visible pull-request label", () => {
  const session = mkSession({
    prUrl: "https://github.com/acme/mission-control/pull/864",
    prNumber: 864,
    prState: "open",
  });

  assert.equal(matchesSessionFilter(session, "864"), true);
  assert.equal(matchesSessionFilter(session, "#864"), true);
  assert.equal(matchesSessionFilter(session, "pr #864"), true);
  assert.equal(matchesSessionFilter(session, "865"), false);
});

test("a PR number without a visible pull-request card does not match", () => {
  const session = mkSession({ prUrl: null, prNumber: 864, prState: null });

  assert.equal(matchesSessionFilter(session, "864"), false);
});

test("title, displayed status, and agent remain searchable", () => {
  const session = mkSession({ name: "Console filters", state: "idle", agent: "codex" });

  assert.equal(matchesSessionFilter(session, "console"), true);
  assert.equal(matchesSessionFilter(session, "idle"), true);
  assert.equal(matchesSessionFilter(session, "codex"), true);
});
