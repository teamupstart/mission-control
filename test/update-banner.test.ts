import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateSnapshot } from "../src/shared/update.ts";

interface UpdateBannerProps {
  snapshot: UpdateSnapshot;
  onApply(): void;
  onDefer(): void;
  onCheck(): void;
  onDismiss(): void;
}

test("an available update renders its version, release summary, and actions", async () => {
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
  const componentPath: string = "../src/web/components/UpdateBanner.tsx";
  const UpdateBanner = await import(componentPath)
    .then((module) => module.UpdateBanner as ComponentType<UpdateBannerProps>)
    .catch((): ComponentType<UpdateBannerProps> => () => null);

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
