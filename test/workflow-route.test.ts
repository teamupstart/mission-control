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

test("the ensembles tab parses and serializes, with an id and back to the list", () => {
  assert.deepEqual(parseMissionRoute("#/workflows/ensembles"), { page: "workflows", tab: "ensembles" });
  assert.deepEqual(parseMissionRoute("#/workflows/ensembles/run-7"), {
    page: "workflows",
    tab: "ensembles",
    ensembleId: "run-7",
  });
  // An undecodable id lands on the list, never a blank pane - the same rule a run id follows.
  assert.deepEqual(parseMissionRoute("#/workflows/ensembles/%E0%A4%A"), {
    page: "workflows",
    tab: "ensembles",
  });
  assert.equal(missionRouteHash({ page: "workflows", tab: "ensembles" }), "#/workflows/ensembles");
  assert.equal(
    missionRouteHash({ page: "workflows", tab: "ensembles", ensembleId: "run 7" }),
    "#/workflows/ensembles/run%207",
  );
  // A round-trip keeps the id (and its encoding) stable.
  assert.deepEqual(
    parseMissionRoute(missionRouteHash({ page: "workflows", tab: "ensembles", ensembleId: "run 7" })),
    { page: "workflows", tab: "ensembles", ensembleId: "run 7" },
  );
});

test("the Ensembles tab is registered once in the tab source of truth and stays inside Workflows", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url)),
    "utf8",
  );
  // One registry drives the tablist, arrow-nav, and labels - a hand-kept count elsewhere is what drifts.
  assert.match(page, /WORKFLOW_TABS = \[[\s\S]*?\["ensembles",/);
  assert.match(page, /tab === "ensembles"/);
  // Ensembles is a Workflows-page tab, not a new top-level page: the shell union is unchanged.
  const shell = readFileSync(
    fileURLToPath(new URL("../src/web/components/AppPageShell.tsx", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(shell, /"ensembles"/);
});

test("ensemble deep links wait for the live snapshot and preserve direct 404 reads", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/EnsembleRuns.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(page, /hasSnapshot/);
  assert.match(page, /observedRunIds/);
  // Selection enters the generation-guarded loader; the loader owns the actual
  // fetch so stale responses cannot replace the current deep link.
  assert.match(page, /load\(selected, true\)/);
  assert.match(page, /fetchEnsembleDetail\(runId\)/);
  assert.match(page, /This ensemble is no longer retained/);
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
