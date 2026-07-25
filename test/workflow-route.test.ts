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

// The dirty-draft gate stopped being a browser dialog in the migration's final phase, which
// changed its shape: a native confirm answers synchronously, so both branches could decide
// in place, and the overlay-hosted one cannot. The route has to be HELD somewhere until the
// answer arrives, and the two halves that make that safe are what this pins.
//
// Held route, not held decision: `navigate` reports that it did not move, and the address
// bar is restored BEFORE the question on the back/forward path - the browser has already
// moved by the time that listener runs, and a dialog over the old page above a URL naming
// the new one is two answers to "where am I" while the one that matters is undecided.
test("the dirty-draft gate holds a route through the overlay, not a browser dialog", () => {
  const router = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/useWorkflowRoute.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(router, /window\.confirm\s*\(/);
  for (const member of ["pendingRoute", "confirmPending", "cancelPending"]) {
    assert.match(router, new RegExp(`${member}`), `the router must expose ${member}`);
  }
  // The URL is put back on the back/forward path before the route is held, so a cancel
  // needs no second correction and a confirm has one place to read the destination from.
  const onHash = router.slice(router.indexOf("const onHash"), router.indexOf("addEventListener"));
  const restore = onHash.indexOf("history.replaceState");
  const hold = onHash.indexOf("setPendingRoute");
  assert.ok(restore > -1 && hold > restore, "restore the URL, then hold the route");

  // App raises the dialog, and does it OUTSIDE the page slots: back/forward can fire the
  // gate while the Workflows page is already unmounting, and a dialog rendered inside that
  // page would unmount with it - the question would vanish and the navigation would be
  // stuck holding a route nobody can answer for.
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  const dialog = app.indexOf("{pendingRoute && (");
  assert.ok(dialog > -1, "App must render the gate's dialog");
  assert.ok(dialog > app.indexOf("<AppPageShell"), "the dialog sits after the page shell");
  assert.ok(dialog < app.indexOf("</OverlayHost>"), "the dialog must be inside the overlay host");
  assert.match(app.slice(dialog), /<WorkflowConfirmModal[\s\S]*?onConfirm: confirmPending/);
  assert.match(app.slice(dialog), /onClose=\{cancelPending\}/);
});

// The header's drawer became a link into the settings rail. Grepped rather than rendered
// because what is at stake is the WIRING: a button that opens nothing looks identical to
// one that works until you click it, and the category it names has to be the registered one.
test("the Workflows page links to its settings category rather than hosting a drawer", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.match(
    app,
    /onOpenWorkflowSettings=\{\(\) =>[\s\S]*?navigate\(\{ page: "settings", category: "workflows" \}\)[\s\S]*?\}/,
  );
  const page = readFileSync(
    fileURLToPath(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(page, /onClick=\{onOpenWorkflowSettings\}/);
  assert.doesNotMatch(page, /WorkflowConfigPanel/, "the drawer is gone, not merely hidden");
});
