import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateSnapshot } from "../src/shared/update.ts";
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
    text(applying).includes("Preparing to update Mission Control to 0.2.0."),
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
  ], Array.from({ length: 16 }, () => true));
});
