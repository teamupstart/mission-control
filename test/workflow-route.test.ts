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

test("global overlays stay mounted on every page, and only one page body renders", () => {
  for (const page of ["fleet", "workflows", "settings"] as const) {
    const html = renderToStaticMarkup(createElement(AppPageShell, {
      page,
      fleet: createElement("main", null, "fleet body"),
      workflows: createElement("main", null, "workflows body"),
      settings: createElement("main", null, "settings body"),
      overlays: createElement("aside", null, "global overlays"),
    }));
    assert.match(html, new RegExp(`${page} body`));
    // Exactly one, which is what keeps the settings page's five polling hooks (and the
    // workflows page's fetches) from mounting while you are on the fleet.
    for (const other of ["fleet", "workflows", "settings"].filter((p) => p !== page)) {
      assert.doesNotMatch(html, new RegExp(`${other} body`), `${other} rendered under ${page}`);
    }
    assert.match(html, /global overlays/);
  }

  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  const shell = app.slice(app.indexOf("<AppPageShell"), app.indexOf("</OverlayHost>"));
  const overlays = shell.slice(shell.indexOf("overlays={"));
  for (const component of ["DispatchLayer", "ReportPanel"]) {
    assert.match(overlays, new RegExp(`<${component}`));
  }
});

test("Settings and Workflows share config-aware LLM state", () => {
  const workflowPage = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(workflowPage, /providers=\{llm\.status\?\.runners \?\? \[\]\}/);
  assert.match(workflowPage, /defaults=\{llm\.personaDefaults\}/);

  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.match(app, /const llm = useLlm\(\)/);
  assert.match(app, /<WorkflowPage[\s\S]*?llm=\{llm\}/);
  assert.match(app, /<SettingsPage[\s\S]*?llm=\{llm\}/);

  const hook = readFileSync(fileURLToPath(new URL("../src/web/useLlm.ts", import.meta.url)), "utf8");
  assert.equal(hook.match(/fetchPersonaDefaults\(\)/g)?.length, 2);
});

test("the Inspector gate action deep-links into the routed settings page", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.match(
    app,
    /onOpenInspectorSettings=\{\(\) =>[\s\S]*?navigate\(\{ page: "settings", category: "inspector" \}\)[\s\S]*?\}/,
  );
  assert.doesNotMatch(app, /setSettingsCategory|setSettingsOpen/);
});
