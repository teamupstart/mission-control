import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppPageShell } from "../src/web/components/AppPageShell.tsx";
import type { MissionRoute } from "../src/web/workflows/useWorkflowRoute.ts";
import {
  RUN_RECORD_PANES,
  missionRouteHash,
  parseMissionRoute,
  pipelineRunHash,
  pipelineRunRoute,
} from "../src/web/workflows/useWorkflowRoute.ts";
import { pipelineRepoKey } from "../src/shared/pipeline.ts";
import { DEFAULT_SETTINGS_CATEGORY } from "../src/web/lib/settings-registry.ts";

/**
 * One observed repository's key, as a pipeline deep link carries it.
 *
 * Built through the shared helper rather than written out, so this test cannot come to
 * disagree with the daemon about what identifies a repository - the separator inside it is a
 * unit separator, which is unreadable here and exact there.
 */
const REPO_KEY = pipelineRepoKey("ai-conductor", "/repo/demo");
const REPO_KEY_HASH = encodeURIComponent(REPO_KEY);

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

test("the Runs page's two surfaces are one page with two addresses", () => {
  // The Pipelines tab is a KIND on the runs route rather than a page of its own, because
  // both surfaces answer "what is executing" and a second top-level destination would make
  // an operator remember which of two pages a piece of work landed on.
  assert.deepEqual(parseMissionRoute("#/runs/pipeline"), { page: "runs", kind: "pipelines" });
  assert.deepEqual(parseMissionRoute("#/runs/pipeline/"), { page: "runs", kind: "pipelines" });
  assert.deepEqual(parseMissionRoute(`#/runs/pipeline/${REPO_KEY_HASH}/add-widgets`), {
    page: "runs",
    kind: "pipelines",
    pipelineRun: { repoKey: REPO_KEY, slug: "add-widgets" },
  });

  // Both spellings round-trip, which is what the router's own canonicalization requires: it
  // rewrites the address bar to `missionRouteHash(parseMissionRoute(hash))` on arrival, so a
  // deep link that did not survive that pass would be silently rewritten to another page.
  for (const hash of ["#/runs/pipeline", `#/runs/pipeline/${REPO_KEY_HASH}/add-widgets`]) {
    assert.equal(missionRouteHash(parseMissionRoute(hash)), hash);
  }

  // The repository half carries the PROVIDER with the path, so two engines observing one
  // checkout do not share a link - and it is one path segment, so an absolute path with
  // spaces and slashes in it survives.
  assert.equal(
    missionRouteHash(
      pipelineRunRoute({ provider: "ai-conductor", repoRoot: "/repo/demo", slug: "add-widgets" }),
    ),
    `#/runs/pipeline/${REPO_KEY_HASH}/add-widgets`,
  );
  assert.equal(
    pipelineRunHash({ provider: "ai-conductor", repoRoot: "/repo/demo", slug: "add-widgets" }),
    `#/runs/pipeline/${REPO_KEY_HASH}/add-widgets`,
  );

  // `pipeline` is claimed ahead of the bare `/runs/:id` rule. Nothing is lost: workflow run
  // ids are UUIDs, so this hash never named one.
  assert.deepEqual(parseMissionRoute("#/runs/2f1c9b4e"), { page: "runs", runId: "2f1c9b4e" });

  // Half an address is no address, and a deeper path names nothing - both land on the tab
  // rather than on a blank reader, which is the rule every unusable id in this router takes.
  assert.deepEqual(parseMissionRoute("#/runs/pipeline/%E0%A4%A/slug"), {
    page: "runs",
    kind: "pipelines",
  });
  // A deeper path is not a runs hash at all, and takes the fleet exactly as `#/runs/a/b`
  // already does - the fallback is the page's, not this surface's.
  assert.deepEqual(parseMissionRoute("#/runs/pipeline/a/b/c"), { page: "fleet" });

  // Workflow run filters do not follow an operator onto a surface that has none. A pipelines
  // link carrying `?status=running` would print a parameter no control on that page clears.
  assert.deepEqual(parseMissionRoute("#/runs/pipeline?status=running"), {
    page: "runs",
    kind: "pipelines",
  });
  assert.equal(
    missionRouteHash({ page: "runs", kind: "pipelines", filters: { status: "running" } }),
    "#/runs/pipeline",
  );

  // And the legacy prefix reaches it, because the two spellings of the runs page are one
  // rule rather than a parse and a copy of it.
  assert.deepEqual(parseMissionRoute("#/workflows/runs/pipeline"), {
    page: "runs",
    kind: "pipelines",
  });
});

test("the Ship log parses and serializes, and never falls through to the ensembles tail", () => {
  assert.deepEqual(parseMissionRoute("#/shipped"), { page: "shipped" });
  assert.deepEqual(parseMissionRoute("#/shipped/"), { page: "shipped" });
  // The regression this exists for: `missionRouteHash` ends in an UNGUARDED ensembles
  // return, so a page member with no branch of its own type-checks and then silently
  // serializes to `#/ensembles`. Every `navigate({page:"shipped"})` would land on the
  // wrong page - including the drawer escalation the next phase hangs off this route -
  // with no error anywhere to say so.
  assert.equal(missionRouteHash({ page: "shipped" }), "#/shipped");
  assert.notEqual(missionRouteHash({ page: "shipped" }), "#/ensembles");
  assert.deepEqual(parseMissionRoute(missionRouteHash({ page: "shipped" })), { page: "shipped" });
  // Stateless by design: the range and repository filter are what you are looking at, not
  // where you are, so no query survives into the route and the hash never grows one.
  assert.deepEqual(parseMissionRoute("#/shipped?range=30&repo=o%2Fr"), { page: "shipped" });
  // Matched on the path, so the retired prefix does not mint a second address for it - it
  // takes the Library, where every unrecognized `#/workflows/*` spelling goes.
  assert.deepEqual(parseMissionRoute("#/workflows/shipped"), { page: "library" });
});

// A well-formed archive key, in the portable `<producerId>~<archiveId>` shape the manifest,
// the routes and SQLite all agree on. Both halves must be lowercase UUIDs or the router is
// required to drop the key.
const SCOUT_KEY = "7aa704fd-d2ab-48b3-a726-0c2643ed91d2~9f5db6c8-79f5-4f9e-84aa-8b5dc15362f8";

test("the Scouts list and one archive both round-trip, filters included", () => {
  assert.deepEqual(parseMissionRoute("#/scouts"), { page: "scouts" });
  assert.deepEqual(parseMissionRoute("#/scouts/"), { page: "scouts" });
  assert.equal(missionRouteHash({ page: "scouts" }), "#/scouts");
  // Same trap the Ship log case above guards: `missionRouteHash` ends in an unguarded
  // ensembles return, so a page with no branch of its own silently serializes to
  // `#/ensembles` and every navigation to it lands on the wrong page.
  assert.notEqual(missionRouteHash({ page: "scouts" }), "#/ensembles");

  const selected: MissionRoute = { page: "scouts", archiveKey: SCOUT_KEY };
  assert.deepEqual(parseMissionRoute(`#/scouts/${SCOUT_KEY}`), selected);
  // `~` is RFC 3986 unreserved, so `encodeURIComponent` leaves it alone and the key stays
  // readable in the address bar. A key that round-tripped through an escape would still
  // work, but nobody could recognize their own archive in a pasted link.
  assert.equal(missionRouteHash(selected), `#/scouts/${SCOUT_KEY}`);
  assert.deepEqual(parseMissionRoute(missionRouteHash(selected)), selected);

  const filtered: MissionRoute = {
    page: "scouts",
    archiveKey: SCOUT_KEY,
    filters: {
      q: "permission grant",
      producer: "7aa704fd-d2ab-48b3-a726-0c2643ed91d2",
      repo: "mission-control",
      agent: "codex",
      status: "partial",
      from: 1_760_000_000_000,
      to: 1_770_000_000_000,
    },
  };
  const hash = missionRouteHash(filtered);
  assert.deepEqual(parseMissionRoute(hash), filtered);
  // Fixed emission order, so one search always produces one string and two links to the
  // same result set compare equal.
  assert.equal(hash, `#/scouts/${SCOUT_KEY}?${[
    "q=permission+grant",
    "producer=7aa704fd-d2ab-48b3-a726-0c2643ed91d2",
    "repo=mission-control",
    "agent=codex",
    "status=partial",
    "from=1760000000000",
    "to=1770000000000",
  ].join("&")}`);
  // A filtered LIST, with no archive selected, is a legal and linkable state.
  assert.deepEqual(parseMissionRoute("#/scouts?q=flake"), {
    page: "scouts",
    filters: { q: "flake" },
  });
});

test("a Scouts link nobody can honour degrades to the filtered list, never to a blank reader", () => {
  // Not a key at all, only one half of one, a bad UUID, and an undecodable escape. Each
  // names no archive, so each keeps the search it arrived with and drops only the selection
  // - the same rule a dead run id takes, and the reason is the same: these are links people
  // paste, and the useful answer is the list they can search from.
  for (const bad of ["not-a-key", "7aa704fd-d2ab-48b3-a726-0c2643ed91d2", "zz~yy", "%E0%A4%A"]) {
    assert.deepEqual(parseMissionRoute(`#/scouts/${bad}?q=resume`), {
      page: "scouts",
      filters: { q: "resume" },
    });
  }
  // A deeper path is not an archive either.
  assert.deepEqual(parseMissionRoute(`#/scouts/${SCOUT_KEY}/report`), { page: "scouts" });
  // A malformed key on a HAND-BUILT route must not serialize either, or the address bar
  // would carry a key that parses back to nothing and the codec would stop round-tripping.
  assert.equal(missionRouteHash({ page: "scouts", archiveKey: "not-a-key" }), "#/scouts");

  // An unknown status is dropped rather than carried: the daemon would refuse it, and a
  // filter chip naming a state this build does not have is a control nothing can clear.
  assert.deepEqual(parseMissionRoute("#/scouts?status=archived"), { page: "scouts" });
  assert.deepEqual(parseMissionRoute("#/scouts?status=unreadable"), {
    page: "scouts",
    filters: { status: "unreadable" },
  });
  // Date bounds must survive as numbers or not at all - the route may not hand the API a
  // value it validates as a nonnegative integer and would answer with a 400.
  for (const bad of ["yesterday", "-1", "1.5", "9007199254740993"]) {
    assert.deepEqual(parseMissionRoute(`#/scouts?from=${bad}`), { page: "scouts" });
  }
  assert.deepEqual(parseMissionRoute("#/scouts?from=0"), { page: "scouts", filters: { from: 0 } });
  // A cursor is a continuation of the current window, not a destination, so it must not
  // survive into the route - pasting page three of a search would otherwise open on a
  // window with no first page above it.
  assert.deepEqual(parseMissionRoute("#/scouts?cursor=123.abc&limit=50"), { page: "scouts" });
});

// Every `#/workflows/*` spelling that ever shipped, and where it now lands.
//
// This is the whole redirect contract in one table, and it is a table because the failure it
// guards against is per-spelling: a redirect written as a branch per route is a redirect that
/**
 * The run record's pane is an ADDRESS, because three of the four panes are invisible until
 * clicked.
 *
 * A link that does not carry which pane is showing is a link to a different page than the one
 * being shared, and the round scrubber makes it worse: changing rounds must not silently change
 * which surface a reader is looking at. What this pins is the round trip and the two refusals -
 * a name this build does not know takes the default rather than reaching the address bar, and a
 * pane with no run to hold it is not an address at all.
 */
test("the run record pane round-trips in the hash, and an unknown one takes the default", () => {
  assert.deepEqual(parseMissionRoute("#/runs/r1?pane=deliveries"), {
    page: "runs",
    runId: "r1",
    pane: "deliveries",
  });
  assert.equal(
    missionRouteHash({ page: "runs", runId: "r1", pane: "deliveries" }),
    "#/runs/r1?pane=deliveries",
  );
  // Every offered pane, so adding one to the tuple without teaching the route about it fails
  // here rather than in a link somebody kept.
  for (const pane of RUN_RECORD_PANES) {
    const route: MissionRoute = { page: "runs", runId: "r1", pane };
    assert.deepEqual(parseMissionRoute(missionRouteHash(route)), route, `${pane} did not survive`);
  }
  // With the filters, because a filtered rail is how most readers reach a run and the first tab
  // click must not take them off the list they came from.
  assert.deepEqual(parseMissionRoute("#/runs/r1?pane=intent&status=running"), {
    page: "runs",
    runId: "r1",
    pane: "intent",
    filters: { status: "running" },
  });
  assert.equal(
    missionRouteHash({
      page: "runs",
      runId: "r1",
      pane: "intent",
      filters: { status: "running" },
    }),
    "#/runs/r1?pane=intent&status=running",
  );
  // A name this build does not offer is DROPPED, not carried: the container would otherwise
  // select a tab that is not in its own bar and draw nothing.
  assert.deepEqual(parseMissionRoute("#/runs/r1?pane=completion"), { page: "runs", runId: "r1" });
  assert.deepEqual(parseMissionRoute("#/runs/r1?pane="), { page: "runs", runId: "r1" });
  // And a pane with no run to name is not an address. The rail has no record to open a pane of.
  assert.deepEqual(parseMissionRoute("#/runs?pane=intent"), { page: "runs" });
  assert.equal(missionRouteHash({ page: "runs", pane: "intent" }), "#/runs");
  // Through the legacy prefix too, which is one rule rather than a parallel copy of the parse.
  assert.deepEqual(parseMissionRoute("#/workflows/runs/r1?pane=deliveries"), {
    page: "runs",
    runId: "r1",
    pane: "deliveries",
  });
});

// gets one of them wrong, and the symptom is a bookmark or a desktop notification quietly
// landing on the fleet. The RUN rows also carry a query, because the legacy prefix is stripped
// before matching precisely so the run filters cannot be dropped on the way through - what
// exactly a query is worth on each route is the case below this one.
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

// What "the query survives the redirect" is actually worth, stated exactly.
//
// The three run filters survive, because they are FIELDS on the runs route. Nothing else
// does, on any route - and the point of the second half here is that this is a property of
// the router rather than of redirecting: the canonical spelling drops an unknown parameter
// just as the legacy one does. A reader who saw only the legacy case would reasonably file a
// bug against the redirect.
test("a legacy redirect carries the run filters, and no route carries anything else", () => {
  // Every filter, through the longest legacy spelling, with the run id kept beside them.
  assert.deepEqual(
    parseMissionRoute("#/workflows/runs/r1?status=running&workflowId=w1&session=s1"),
    { page: "runs", runId: "r1", filters: { status: "running", workflowId: "w1", session: "s1" } },
  );
  assert.equal(
    missionRouteHash(parseMissionRoute("#/workflows/runs?status=completed")),
    "#/runs?status=completed",
  );
  // An unknown parameter is dropped - and identically on the route it redirects TO, which is
  // what makes it the router's rule and not the redirect's.
  for (const [legacy, canonical] of [
    ["#/workflows/ensembles?source=notification", "#/ensembles?source=notification"],
    ["#/workflows/runs?source=notification", "#/runs?source=notification"],
  ]) {
    assert.deepEqual(
      parseMissionRoute(legacy!),
      parseMissionRoute(canonical!),
      `${legacy} and ${canonical} must parse alike`,
    );
    assert.doesNotMatch(missionRouteHash(parseMissionRoute(canonical!)), /source=/);
  }
  // A status this build cannot name is not a filter either, so it cannot reach the run list
  // query as one.
  assert.deepEqual(parseMissionRoute("#/workflows/runs?status=not-a-status"), { page: "runs" });
});

test("the Workflows page is gone, not merely unreachable", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.doesNotMatch(app, /WorkflowPage/, "App must not mount the retired page");
  assert.ok(
    !existsSync(fileURLToPath(new URL("../src/web/workflows/WorkflowPage.tsx", import.meta.url))),
    "the retired page's module must be deleted, not left orphaned",
  );
  // Runs and Ensembles are top-level pages now - the inverse of what this asserted while
  // they were tabs. Read off the ROUTE rather than off the shell, because the shell no
  // longer spells any page out: it is keyed on `MissionRoute["page"]`, so the union below
  // is the one place a page exists and the shell cannot disagree with it. The round trips
  // above are the behavioural half of the same claim.
  for (const page of ["runs", "ensembles", "shipped", "fleet", "library", "settings"] as const) {
    const route: MissionRoute = page === "settings"
      ? { page, category: DEFAULT_SETTINGS_CATEGORY }
      : { page };
    assert.equal(parseMissionRoute(missionRouteHash(route)).page, page);
  }
  const shell = readFileSync(
    fileURLToPath(new URL("../src/web/components/AppPageShell.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(shell, /Record<MissionRoute\["page"\], ReactNode>/);
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
  // A `Record` over the route's own page names rather than a hand-written list, and that is
  // the point of the shape: a page added to `MissionRoute` and forgotten leaves this object
  // missing a key, which does not compile. The list it replaced type-checked while silently
  // covering one page fewer than the app had - the same drift `AppPageShell` itself was
  // rebuilt to make impossible.
  const bodies: Record<MissionRoute["page"], string> = {
    fleet: "fleet body",
    library: "library body",
    runs: "runs body",
    ensembles: "ensembles body",
    shipped: "shipped body",
    scouts: "scouts body",
    settings: "settings body",
  };
  const pages = Object.keys(bodies) as MissionRoute["page"][];
  for (const page of pages) {
    const html = renderToStaticMarkup(createElement(AppPageShell, {
      page,
      fleet: createElement("main", null, bodies.fleet),
      library: createElement("main", null, bodies.library),
      runs: createElement("main", null, bodies.runs),
      ensembles: createElement("main", null, bodies.ensembles),
      shipped: createElement("main", null, bodies.shipped),
      scouts: createElement("main", null, bodies.scouts),
      settings: createElement("main", null, bodies.settings),
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
