import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppPageShell } from "../src/web/components/AppPageShell.tsx";
import type { MissionRoute } from "../src/web/workflows/useWorkflowRoute.ts";
import { missionRouteHash, parseMissionRoute } from "../src/web/workflows/useWorkflowRoute.ts";

// What is at stake: the execution surfaces must coexist with the fleet without a router or a
// second app mount. These hashes are durable links, so unknown values must fall safely to Fleet
// and every retired spelling must keep resolving.

test("execution hashes parse and serialize without aliases drifting", () => {
  assert.deepEqual(parseMissionRoute("#/fleet"), { page: "fleet" });
  assert.deepEqual(parseMissionRoute("#/runs/"), { page: "runs" });
  assert.deepEqual(parseMissionRoute("#/unknown"), { page: "fleet" });
  assert.equal(missionRouteHash({ page: "fleet" }), "#/fleet");
  assert.equal(missionRouteHash({ page: "runs" }), "#/runs");
});

test("the ensembles page parses and serializes, with an id and back to the list", () => {
  assert.deepEqual(parseMissionRoute("#/ensembles"), { page: "ensembles" });
  assert.deepEqual(parseMissionRoute("#/ensembles/run-7"), {
    page: "ensembles",
    ensembleId: "run-7",
  });
  // An undecodable id lands on the list, never a blank pane - the same rule a run id follows.
  assert.deepEqual(parseMissionRoute("#/ensembles/%E0%A4%A"), { page: "ensembles" });
  assert.equal(missionRouteHash({ page: "ensembles" }), "#/ensembles");
  assert.equal(
    missionRouteHash({ page: "ensembles", ensembleId: "run 7" }),
    "#/ensembles/run%207",
  );
  // A round-trip keeps the id (and its encoding) stable.
  assert.deepEqual(
    parseMissionRoute(missionRouteHash({ page: "ensembles", ensembleId: "run 7" })),
    { page: "ensembles", ensembleId: "run 7" },
  );
});

// Every `#/workflows/*` spelling that ever shipped, and where it now lands.
//
// This is the whole redirect contract in one table, and it is a table because the failure it
// guards against is per-spelling: a redirect written as a branch per route is a redirect that
// gets one of them wrong, and the symptom is a bookmark or a desktop notification quietly
// landing on the fleet. The run and ensemble rows also check that the QUERY survives - the
// legacy prefix is stripped before matching precisely so filters cannot be dropped on the way
// through.
test("every legacy #/workflows spelling redirects to its new home, permanently", () => {
  const redirects: [legacy: string, landed: MissionRoute][] = [
    // Authoring, which moved to the Library one phase earlier.
    ["#/workflows", { page: "library" }],
    ["#/workflows/personas", { page: "library", shelf: "personas" }],
    ["#/workflows/actions", { page: "library", shelf: "actions" }],
    // Execution, which moves here.
    ["#/workflows/runs", { page: "runs" }],
    ["#/workflows/runs/", { page: "runs" }],
    ["#/workflows/runs/r1", { page: "runs", runId: "r1" }],
    ["#/workflows/runs/run%207", { page: "runs", runId: "run 7" }],
    ["#/workflows/runs?status=completed", { page: "runs", filters: { status: "completed" } }],
    [
      "#/workflows/runs/r1?status=running",
      { page: "runs", runId: "r1", filters: { status: "running" } },
    ],
    ["#/workflows/ensembles", { page: "ensembles" }],
    ["#/workflows/ensembles/", { page: "ensembles" }],
    ["#/workflows/ensembles/run-7", { page: "ensembles", ensembleId: "run-7" }],
    // An undecodable id under the legacy prefix takes the new page's own fallback.
    ["#/workflows/runs/%E0%A4%A", { page: "runs" }],
    ["#/workflows/ensembles/%E0%A4%A", { page: "ensembles" }],
    // And ANYTHING else the prefix has ever been spelled with. Five spellings shipped and all
    // five are above; these are the misspelled, mistyped and half-remembered rest, which used
    // to fall through to the fleet - the one destination that tells its holder nothing about
    // where the page they wanted went. They take the front door `#/workflows` bare takes.
    ["#/workflows/session-actions", { page: "library" }],
    ["#/workflows/workflows", { page: "library" }],
    ["#/workflows/builder", { page: "library" }],
    ["#/workflows/runs/one/two", { page: "library" }],
    ["#/workflows/", { page: "library" }],
    ["#/workflows/%E0%A4%A", { page: "library" }],
  ];
  for (const [legacy, landed] of redirects) {
    assert.deepEqual(parseMissionRoute(legacy), landed, `${legacy} did not redirect`);
    // Never the fleet. The fleet IS a legitimate parse - it is what an unknown hash outside
    // this prefix takes - which is exactly why a redirect landing there is indistinguishable
    // from no redirect at all, and why it is asserted against here rather than assumed.
    assert.notDeepEqual(parseMissionRoute(legacy), { page: "fleet" }, `${legacy} fell through`);
    // PERMANENT means the address bar stops saying the old thing: the route a legacy hash
    // parses to must serialize to a hash that is no longer legacy, or the next copy of that
    // link keeps the retired spelling alive forever.
    const canonical = missionRouteHash(landed);
    assert.doesNotMatch(canonical, /^#\/workflows/, `${legacy} canonicalized to ${canonical}`);
    // And the canonical spelling is a fixed point: parsing it again does not move.
    assert.deepEqual(parseMissionRoute(canonical), landed, `${canonical} is not stable`);
  }
});

// The invariant behind the table above, stated once so a sixth spelling nobody predicted is
// covered by construction rather than by remembering to add a row.
//
// "Redirects permanently" has two halves and this checks both for every suffix: the hash
// resolves to a real destination inside the two homes that inherited the page, and the
// canonical spelling of that destination no longer carries the retired prefix. An unknown
// hash OUTSIDE this prefix still lands on the fleet, which is the behaviour that makes the
// first half worth asserting - falling through is silent and looks identical to working.
test("no #/workflows hash falls through to the fleet, whatever follows the prefix", () => {
  const suffixes = [
    "", "/", "/personas", "/actions", "/session-actions", "/runs", "/ensembles",
    "/runs/r1", "/ensembles/e1", "/runs/r1/extra", "/builder", "/WORKFLOWS", "/a b",
    "/%E0%A4%A", "/runs?status=completed", "/../fleet", "/personas/p1/deep",
  ];
  for (const suffix of suffixes) {
    const hash = `#/workflows${suffix}`;
    const route = parseMissionRoute(hash);
    assert.notEqual(route.page, "fleet", `${hash} fell through to the fleet`);
    assert.ok(
      ["library", "runs", "ensembles"].includes(route.page),
      `${hash} landed on ${route.page}, which did not inherit the Workflows page`,
    );
    assert.doesNotMatch(
      missionRouteHash(route),
      /^#\/workflows/,
      `${hash} canonicalized back to a legacy spelling`,
    );
  }
  // The control: the fall-through still exists for hashes this prefix has no claim on, so
  // the assertions above are about the redirect and not about a parser that never returns
  // the fleet.
  assert.deepEqual(parseMissionRoute("#/unknown"), { page: "fleet" });
  assert.deepEqual(parseMissionRoute("#/workflowsx"), { page: "fleet" });
});

test("the Workflows page is gone, not merely unreachable", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.doesNotMatch(app, /WorkflowPage/, "App must not mount the retired page");
  assert.ok(
    !existsSync(fileURLToPath(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url))),
    "the retired page's module must be deleted, not left orphaned",
  );
  // Runs and Ensembles are top-level pages now, so the shell union must name both - the
  // inverse of what this asserted while they were tabs.
  const shell = readFileSync(
    fileURLToPath(new URL("../src/web/components/AppPageShell.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(shell, /"ensembles"/);
  assert.match(shell, /"runs"/);
  assert.doesNotMatch(shell, /"workflows"/);
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
  const pages = ["fleet", "library", "runs", "ensembles", "settings"] as const;
  for (const page of pages) {
    const html = renderToStaticMarkup(createElement(AppPageShell, {
      page,
      fleet: createElement("main", null, "fleet body"),
      library: createElement("main", null, "library body"),
      runs: createElement("main", null, "runs body"),
      ensembles: createElement("main", null, "ensembles body"),
      settings: createElement("main", null, "settings body"),
      overlays: createElement("aside", null, "global overlays"),
    }));
    assert.match(html, new RegExp(`${page} body`));
    // Exactly one, which is what keeps the settings page's five polling hooks (and the runs
    // rail's fetches, and the ensembles detail loader) from mounting while you are on the
    // fleet. Two slots rather than one execution slot is what makes the ensembles half of
    // that true while you are reading a run.
    for (const other of pages.filter((p) => p !== page)) {
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

test("Settings and the Library share config-aware LLM state", () => {
  // The Persona editor moved to the Library with its surface, so the provider list and the
  // defaults it offers are threaded from the same one hook Settings reads. Two reads would
  // be two answers to "which providers does this daemon have", and the Persona editor's copy
  // is the one an operator would author against.
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.match(app, /const llm = useLlm\(\)/);
  assert.match(app, /<PersonaLibrary[\s\S]*?providers=\{llm\.status\?\.runners \?\? \[\]\}/);
  assert.match(app, /<PersonaLibrary[\s\S]*?defaults=\{llm\.personaDefaults\}/);
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
// The subsystem's switches were a drawer on the Workflows page's header, then a link from it.
// The page is gone and the link survived it: an operator still looks for retention, delivery
// and health where the runs are, and Settings is still the one place they live.
test("the runs page links to its settings category rather than hosting a drawer", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  const runsSlot = app.slice(app.indexOf("runs={("), app.indexOf("ensembles={("));
  assert.ok(runsSlot.length > 0, "App must render a runs page slot");
  assert.match(runsSlot, /Workflow settings/);
  assert.match(runsSlot, /navigate\(\{ page: "settings", category: "workflows" \}\)/);
  assert.doesNotMatch(app, /WorkflowConfigPanel/, "the drawer is gone, not merely hidden");
});
