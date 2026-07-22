import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppPageShell } from "../src/web/components/AppPageShell.tsx";
import { missionRouteHash, parseMissionRoute } from "../src/web/workflows/useWorkflowRoute.ts";

// What is at stake: the Workflows surface must coexist with the fleet without a router or a
// second app mount. These hashes are durable links, so unknown values must fall safely to Fleet.

test("workflow hashes parse and serialize without aliases drifting", () => {
  assert.deepEqual(parseMissionRoute("#/fleet"), { page: "fleet" });
  assert.deepEqual(parseMissionRoute("#/workflows"), { page: "workflows", tab: "workflows" });
  assert.deepEqual(parseMissionRoute("#/workflows/personas"), { page: "workflows", tab: "personas" });
  assert.deepEqual(parseMissionRoute("#/workflows/runs/"), { page: "workflows", tab: "runs" });
  assert.deepEqual(parseMissionRoute("#/unknown"), { page: "fleet" });
  assert.equal(missionRouteHash({ page: "fleet" }), "#/fleet");
  assert.equal(missionRouteHash({ page: "workflows", tab: "personas" }), "#/workflows/personas");
});

test("global overlays stay mounted on Fleet and Workflows pages", () => {
  for (const page of ["fleet", "workflows"] as const) {
    const html = renderToStaticMarkup(createElement(AppPageShell, {
      page,
      fleet: createElement("main", null, "fleet body"),
      workflows: createElement("main", null, "workflow body"),
      overlays: createElement("aside", null, "global overlays"),
    }));
    assert.match(html, new RegExp(`${page === "fleet" ? "fleet" : "workflow"} body`));
    assert.match(html, /global overlays/);
  }

  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  const shell = app.slice(app.indexOf("<AppPageShell"), app.indexOf("</OverlayHost>"));
  const overlays = shell.slice(shell.indexOf("overlays={"));
  for (const component of ["DispatchLayer", "ReportPanel", "SettingsModal"]) {
    assert.match(overlays, new RegExp(`<${component}`));
  }
});

test("the provider catalog reloads when the event stream reconnects", () => {
  const workflowPage = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(workflowPage, /if \(!connected\) return;/);
  assert.match(workflowPage, /\}, \[connected\]\);/);

  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.match(app, /<WorkflowPage[\s\S]*?connected=\{connected\}/);
});
