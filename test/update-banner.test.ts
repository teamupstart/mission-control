import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { updatePrepareProgress, type UpdateSnapshot } from "../src/shared/update.ts";
import { UPDATE_COPY } from "../src/shared/update-copy.ts";
import { UpdateBanner } from "../src/web/components/UpdateBanner.tsx";

test("an available update renders its version, release summary, and actions", () => {
  const snapshot: UpdateSnapshot = {
    phase: "available",
    currentVersion: "0.1.0",
    newVersion: "0.2.0",
    releaseTag: "v0.2.0",
    releaseName: "Mission Control 0.2.0",
    releaseNotes: "Faster launches and clearer update status.",
    publishedAt: "2026-08-19T12:00:00.000Z",
    checkedAt: Date.parse("2026-08-19T12:00:00.000Z"),
    lastOutcome: null,
  };
  const html = renderToStaticMarkup(createElement(UpdateBanner, {
    snapshot,
    onApply: () => {},
    onInstall: () => {},
    onCancel: () => {},
    onDefer: () => {},
    onCheck: () => {},
    onDismiss: () => {},
  }));

  assert.match(
    html,
    /(?=.*role="status")(?=.*0\.2\.0)(?=.*Faster launches and clearer update status\.)(?=.*<button[^>]*>Update Now<\/button>)(?=.*<button[^>]*>Later<\/button>)/s,
    html,
  );
});

test("the banner covers transient, outcome, empty, and truncated states", () => {
  const render = (snapshot: UpdateSnapshot): string => renderToStaticMarkup(createElement(UpdateBanner, {
    snapshot,
    onApply: () => {},
    onInstall: () => {},
    onCancel: () => {},
    onDefer: () => {},
    onCheck: () => {},
    onDismiss: () => {},
  }));
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const controls = (html: string): string[] => Array.from(
    html.matchAll(/<button[^>]*>(.*?)<\/button>/gs),
    ([, label]) => text(label ?? ""),
  );

  const applying = render({
    phase: "applying",
    currentVersion: "0.1.0",
    newVersion: "0.2.0",
    stage: "starting",
    lastOutcome: null,
  });
  const manualError = render({
    phase: "error",
    currentVersion: "0.1.0",
    message: "Could not check for updates. Try again.",
    manual: true,
    retryable: true,
    lastOutcome: null,
  });
  // Reachable only since a background check may surface a standing, user-actionable failure.
  const backgroundAuthError = render({
    phase: "error",
    currentVersion: "0.1.0",
    message: "GitHub CLI is not authenticated. Run `gh auth login`, then check again.",
    manual: false,
    retryable: true,
    lastOutcome: null,
  });
  const unretryableError = render({
    phase: "error",
    currentVersion: "0.1.0",
    message: "Could not check for updates.",
    manual: true,
    retryable: false,
    lastOutcome: null,
  });
  const previousFailure = render({
    phase: "idle",
    currentVersion: "0.1.0",
    lastCheckedAt: null,
    lastOutcome: {
      result: "failure",
      targetVersion: "0.2.0",
      recordedAt: "2026-08-19T13:30:00.000Z",
      message: "The update did not complete. Your previous version is still installed.",
    },
  });
  const previousSuccess = render({
    phase: "idle",
    currentVersion: "0.2.0",
    lastCheckedAt: null,
    lastOutcome: {
      result: "success",
      targetVersion: "0.2.0",
      recordedAt: "2026-08-19T13:30:00.000Z",
    },
  });
  const idle = render({
    phase: "idle",
    currentVersion: "0.2.0",
    lastCheckedAt: null,
    lastOutcome: null,
  });
  const distinctiveSuffix = "DISTINCTIVE_SUFFIX_MUST_NOT_REACH_THE_RENDERER";
  const longNotes = render({
    phase: "available",
    currentVersion: "0.1.0",
    newVersion: "0.2.0",
    releaseTag: "v0.2.0",
    releaseName: "Mission Control 0.2.0",
    releaseNotes: `VISIBLE_RELEASE_SUMMARY ${"x".repeat(5_000)} ${distinctiveSuffix}`,
    publishedAt: "2026-08-19T12:00:00.000Z",
    checkedAt: Date.parse("2026-08-19T12:00:00.000Z"),
    lastOutcome: null,
  });

  assert.deepEqual([
    text(applying).includes(UPDATE_COPY.applying.title("0.2.0")),
    text(applying).includes(UPDATE_COPY.applying.detail),
    text(applying).includes("administrator permission"),
    text(applying).includes("/Applications"),
    controls(applying).length === 0,
    text(manualError).includes("Could not check for updates. Try again."),
    controls(manualError).join(",") === "Retry,Dismiss",
    text(backgroundAuthError).includes("gh auth login"),
    // The state we chose to interrupt someone with is the one that most needs a way forward.
    controls(backgroundAuthError).join(",") === "Retry,Dismiss",
    controls(unretryableError).join(",") === "Dismiss",
    text(previousFailure).includes("The update did not complete. Your previous version is still installed."),
    controls(previousFailure).join(",") === "Retry,Dismiss",
    text(previousSuccess).includes("Mission Control updated successfully to 0.2.0."),
    controls(previousSuccess).join(",") === "Dismiss",
    idle === "",
    text(longNotes).includes("VISIBLE_RELEASE_SUMMARY"),
    !text(longNotes).includes(distinctiveSuffix),
  ], Array.from({ length: 17 }, () => true));
});


test("a build in progress renders a real, valued progress bar and a way out", () => {
  const html = renderToStaticMarkup(createElement(UpdateBanner, {
    snapshot: {
      phase: "preparing",
      currentVersion: "0.1.0",
      newVersion: "0.2.0",
      releaseTag: "v0.2.0",
      stage: "dependencies",
      cancelling: false,
      lastOutcome: null,
    },
    onApply: () => {},
    onInstall: () => {},
    onCancel: () => {},
    onDefer: () => {},
    onCheck: () => {},
    onDismiss: () => {},
  }));

  const { percent, step, steps } = updatePrepareProgress("dependencies");
  // The exact markup shape is the point of this layer: a progressbar with a real value, not a
  // spinner, and a fill whose width is that same value.
  assert.match(html, new RegExp(`role="progressbar"[^>]*aria-valuenow="${percent}"`));
  assert.match(html, new RegExp(`width:${percent}%`));
  assert.match(html, /aria-valuemin="0"[^>]*aria-valuemax="100"/);
  assert.match(html, new RegExp(`aria-valuetext="Installing dependencies, step ${step} of ${steps}"`));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.ok(text.includes(UPDATE_COPY.preparing.title("0.2.0")), text);
  assert.match(text, /Installing dependencies · step 6 of 8/);
  // The exact sentence the native dialog shows for this phase, from the one owner both read.
  assert.ok(text.includes(UPDATE_COPY.preparing.detail), text);
  assert.match(html, /<button[^>]*>Cancel<\/button>/);
});

test("a prepared update offers the restart that installs it", () => {
  const html = renderToStaticMarkup(createElement(UpdateBanner, {
    snapshot: {
      phase: "ready",
      currentVersion: "0.1.0",
      newVersion: "0.2.0",
      releaseTag: "v0.2.0",
      stagedAt: Date.parse("2026-08-19T12:04:00.000Z"),
      lastOutcome: null,
    },
    onApply: () => {},
    onInstall: () => {},
    onCancel: () => {},
    onDefer: () => {},
    onCheck: () => {},
    onDismiss: () => {},
  }));

  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.ok(text.includes(UPDATE_COPY.ready.title("0.2.0")), text);
  assert.ok(text.includes(UPDATE_COPY.ready.detail), text);
  assert.match(text, /takes a few seconds/);
  assert.match(text, /administrator permission/);
  assert.match(html, /<button[^>]*>Restart and Install<\/button>/);
  assert.match(html, /<button[^>]*>Later<\/button>/);
  // No progress bar here: there is nothing left to wait for.
  assert.doesNotMatch(html, /role="progressbar"/);
});


test("the phase copy has one owner, and says something for every phase that shows it", () => {
  // Two surfaces show these three phases - this banner and the native dialog in
  // src/main/index.ts - so the strings live in src/shared/update-copy.ts and both read them.
  // This asserts the copy itself is usable; test/update-desktop-contract.test.ts asserts that
  // neither surface hard-codes its own version of it.
  for (const phase of ["preparing", "ready", "applying"] as const) {
    const copy = UPDATE_COPY[phase];
    assert.match(copy.title("1.2.3"), /Mission Control/);
    assert.ok(copy.title("1.2.3").includes("1.2.3"), phase);
    assert.ok(copy.detail.length > 20, phase);
    assert.ok(copy.detail.endsWith("."), phase);
  }
  // The two phases that close the app both say so, because that is the thing a person was
  // never told before.
  assert.match(UPDATE_COPY.ready.detail, /close/);
  assert.match(UPDATE_COPY.applying.detail, /close/);
  // And the phase that does NOT close it says that instead.
  assert.match(UPDATE_COPY.preparing.detail, /keeps running/);
});


test("a cancelled build says it is stopping, and offers no Cancel to press again", () => {
  const html = renderToStaticMarkup(createElement(UpdateBanner, {
    snapshot: {
      phase: "preparing",
      currentVersion: "0.1.0",
      newVersion: "0.2.0",
      releaseTag: "v0.2.0",
      stage: "build",
      cancelling: true,
      lastOutcome: null,
    },
    onApply: () => {},
    onInstall: () => {},
    onCancel: () => {},
    onDefer: () => {},
    onCheck: () => {},
    onDismiss: () => {},
  }));

  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.ok(text.includes(UPDATE_COPY.cancelling.title("0.2.0")), text);
  assert.ok(text.includes(UPDATE_COPY.cancelling.detail), text);
  // No bar, because the value would keep claiming progress, and no Cancel, because it has
  // already been pressed and the build is on its way out.
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /<button/);
});
