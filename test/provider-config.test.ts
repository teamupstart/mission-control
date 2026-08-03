import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-provider-config-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb, setAppConfig } = await import("../src/server/db.ts");
const { getForemanConfig, setForemanConfig } = await import("../src/server/foreman/config.ts");
const { getInspectorConfig, inspectorModel, setInspectorConfig } = await import(
  "../src/server/inspector/config.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => openDb().exec("DELETE FROM app_config"));

/**
 * The two defaults the automatic repair loop needs, and the upgrade case that makes flipping
 * them safe.
 *
 * `enabled` gates `bindingModeBlock`, so a `foreman_complete` binding could not exist at all on
 * a fresh install while it shipped `false`; `wrapupTriggers` decided WHICH sessions ever reach a
 * wrap-up moment, and `["drain"]` alone silently excluded every session without a work queue.
 * Both are `.default()`s over an `app_config` blob, which is what makes the flip safe: a default
 * is consulted only when the key is ABSENT, so it reaches the operator who never opened the
 * panel and not the one who answered.
 *
 * What is deliberately NOT flipped is asserted alongside, because "Foreman is on by default"
 * reads far more alarming than it is: `mode` still ships `dry-run` and the allowlist still ships
 * empty, so Foreman on a fresh install drafts and types nothing anywhere.
 */
test("Foreman ships enabled with both wrap-up triggers, and still authorises nothing", () => {
  const fresh = getForemanConfig();
  assert.equal(fresh.enabled, true);
  assert.deepEqual(fresh.wrapupTriggers, ["drain", "prompted"]);
  assert.equal(fresh.skipScoutWrapup, true);
  assert.equal(fresh.skipReviewArtifactWrapup, true);
  assert.equal(fresh.mode, "dry-run", "enabled must not imply may-act");
  assert.deepEqual(fresh.repoAllowlist, [], "enabled must not imply an authorised repository");
  assert.equal(fresh.wrapup, "ask", "a wrap-up moment must still ask rather than type");
  assert.equal(fresh.trackReviewFeedback, true);
  assert.equal(fresh.trackCiFailures, true);
});

test("an operator who explicitly turned Foreman off keeps it off across the flip", () => {
  // The persisted blob an operator produces by switching Foreman off in Settings. `enabled` is
  // present, so the new default is never consulted for them.
  setAppConfig("foreman", { enabled: false, wrapupTriggers: [] });
  const answered = getForemanConfig();
  assert.equal(answered.enabled, false);
  assert.deepEqual(
    answered.wrapupTriggers,
    [],
    "an empty trigger list is an answer, not an absence, and must not be repopulated",
  );

  // A blob written before either field existed still upgrades onto the new defaults, which is
  // the case the flip is FOR.
  setAppConfig("foreman", { mode: "dry-run" });
  const upgraded = getForemanConfig();
  assert.equal(upgraded.enabled, true);
  assert.deepEqual(upgraded.wrapupTriggers, ["drain", "prompted"]);
  assert.equal(upgraded.skipScoutWrapup, true);
  assert.equal(upgraded.skipReviewArtifactWrapup, true);
});

test("Foreman persists the two completion safeguards independently", () => {
  const scoutOff = setForemanConfig({ skipScoutWrapup: false });
  assert.equal(scoutOff.skipScoutWrapup, false);
  assert.equal(scoutOff.skipReviewArtifactWrapup, true);

  const bothOff = setForemanConfig({ skipReviewArtifactWrapup: false });
  assert.equal(bothOff.skipScoutWrapup, false);
  assert.equal(bothOff.skipReviewArtifactWrapup, false);
});

test("Foreman persists review-comment and CI follow-through independently", () => {
  const ciOff = setForemanConfig({ trackCiFailures: false });
  assert.equal(ciOff.trackReviewFeedback, true);
  assert.equal(ciOff.trackCiFailures, false);

  const bothOff = setForemanConfig({ trackReviewFeedback: false });
  assert.equal(bothOff.trackReviewFeedback, false);
  assert.equal(bothOff.trackCiFailures, false);
});

test("Foreman preserves the old combined PR follow-through answer when adding CI", () => {
  setAppConfig("foreman", { trackReviewFeedback: false });
  const optedOut = getForemanConfig();
  assert.equal(optedOut.trackReviewFeedback, false);
  assert.equal(optedOut.trackCiFailures, false);

  setAppConfig("foreman", { trackReviewFeedback: true });
  assert.equal(getForemanConfig().trackCiFailures, true);

  // Once the split setting exists, it is an independent operator answer and must win.
  setAppConfig("foreman", { trackReviewFeedback: false, trackCiFailures: true });
  const split = getForemanConfig();
  assert.equal(split.trackReviewFeedback, false);
  assert.equal(split.trackCiFailures, true);
});

test("Foreman upgrades removed automatic-review modes to Ask", () => {
  setAppConfig("foreman", { wrapup: "retired-review-option" });
  assert.equal(getForemanConfig().wrapup, "ask");

  setAppConfig("foreman", { wrapup: "workflow" });
  assert.equal(getForemanConfig().wrapup, "ask");
});

test("Foreman persists Codex independently from the app-wide background provider", () => {
  setForemanConfig({ runner: "codex", reviewModel: "gpt-5.6-terra" });
  const cfg = getForemanConfig();
  assert.equal(cfg.runner, "codex");
  assert.equal(cfg.reviewModel, "gpt-5.6-terra");
});

test("Foreman merges backlog launch defaults per harness", () => {
  setForemanConfig({ backlogDefaultModel: { codex: "gpt-5.6-terra" } });
  const cfg = setForemanConfig({ backlogDefaultModel: { claude: "claude-sonnet-5" } });
  assert.deepEqual(cfg.backlogDefaultModel, {
    claude: "claude-sonnet-5",
    codex: "gpt-5.6-terra",
    pi: null,
  });
});

test("Inspector persists Codex and resolves its Codex default after restart-style reread", () => {
  setInspectorConfig({ runner: "codex", model: "" });
  const cfg = getInspectorConfig();
  assert.equal(cfg.runner, "codex");
  assert.equal(cfg.model, "");
  assert.equal(inspectorModel(cfg).id, "gpt-5.6-sol");
});
