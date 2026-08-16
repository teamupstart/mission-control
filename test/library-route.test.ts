import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIBRARY_SHELVES,
  LIBRARY_SURFACES,
  missionRouteHash,
  pageShortcutRoute,
  parseMissionRoute,
} from "../src/web/workflows/useWorkflowRoute.ts";
import { LIBRARY_SHELF_COPY } from "../src/web/library/library-model.ts";
import { WORKFLOW_CHECK_SLOTS } from "../src/shared/workflow.ts";

// What is at stake: `#/library` is the app's second home and its hashes are links people
// keep. Every spelling below is published in the README, so a change here is a change to a
// contract - and the three legacy authoring hashes must keep landing somewhere useful
// forever, because they were the only way to reach these surfaces for the app's whole life
// before this.

test("library hashes round-trip, shelf and asset alike", () => {
  assert.deepEqual(parseMissionRoute("#/library"), { page: "library" });
  assert.equal(missionRouteHash({ page: "library" }), "#/library");

  for (const shelf of LIBRARY_SURFACES) {
    assert.deepEqual(parseMissionRoute(`#/library/${shelf}`), { page: "library", shelf });
    assert.equal(missionRouteHash({ page: "library", shelf }), `#/library/${shelf}`);

    // Commands is the one surface whose ids are a CLOSED set - the four built-in slots - so
    // an arbitrary asset id names nothing there and `new` drafts nothing. Both are covered
    // by their own case below; every other surface takes any id an operator's row can have.
    if (shelf === "commands") continue;

    const withAsset = { page: "library", shelf, assetId: "asset 7" } as const;
    assert.equal(missionRouteHash(withAsset), `#/library/${shelf}/asset%207`);
    assert.deepEqual(parseMissionRoute(missionRouteHash(withAsset)), withAsset);

    const creating = { page: "library", shelf, creating: true } as const;
    assert.equal(missionRouteHash(creating), `#/library/${shelf}/new`);
    assert.deepEqual(parseMissionRoute(missionRouteHash(creating)), creating);
  }
});

// The Commands shelf routes to four built-in slots and to nothing else. Every claim here is
// about a link somebody can paste or hand-build: a slot that no longer exists, a `/new` typed
// out of habit from the other shelves, and a route object assembled in code.
test("a Command route names a slot or nothing, and never a blank draft", () => {
  for (const slot of WORKFLOW_CHECK_SLOTS) {
    const route = { page: "library", shelf: "commands", assetId: slot } as const;
    assert.equal(missionRouteHash(route), `#/library/commands/${slot}`);
    assert.deepEqual(parseMissionRoute(missionRouteHash(route)), route);
  }
  // An id that is not a slot names no Command that could ever exist, so it opens the surface
  // on its own default rather than being carried into the address bar as a link to nowhere.
  assert.deepEqual(parseMissionRoute("#/library/commands/deploy"), {
    page: "library",
    shelf: "commands",
  });
  assert.deepEqual(parseMissionRoute("#/library/commands/%E0%A4%A"), {
    page: "library",
    shelf: "commands",
  });
  // `new` is not "open a blank one" here: there is no fifth slot to author.
  assert.deepEqual(parseMissionRoute("#/library/commands/new"), {
    page: "library",
    shelf: "commands",
  });
  // And the serializer refuses to write either spelling, so a hand-built route cannot
  // produce a hash that parses back into something else.
  assert.equal(
    missionRouteHash({ page: "library", shelf: "commands", creating: true }),
    "#/library/commands",
  );
  assert.equal(
    missionRouteHash({ page: "library", shelf: "commands", assetId: "deploy" }),
    "#/library/commands",
  );
});

test("a built-in id survives its colon, and an undecodable one opens the shelf anyway", () => {
  const builtin = { page: "library", shelf: "actions", assetId: "builtin:pull-request" } as const;
  assert.equal(missionRouteHash(builtin), "#/library/actions/builtin%3Apull-request");
  assert.deepEqual(parseMissionRoute(missionRouteHash(builtin)), builtin);
  // The rule every id in this router follows: an unreadable one names nothing, so it lands
  // on the surface rather than on a blank pane, for a link anyone can paste.
  assert.deepEqual(parseMissionRoute("#/library/personas/%E0%A4%A"), {
    page: "library",
    shelf: "personas",
  });
});

test("Foreman's fixed local id round-trips as the canonical System profile route", () => {
  const route = { page: "library", shelf: "personas", assetId: "foreman" } as const;
  assert.equal(missionRouteHash(route), "#/library/personas/foreman");
  assert.deepEqual(parseMissionRoute("#/library/personas/foreman"), route);
  assert.equal(missionRouteHash(parseMissionRoute("#/library/personas/foreman")),
    "#/library/personas/foreman");
});

test("a shelf with no surface, and an unknown one, land on the shelves index", () => {
  // Ensembles shelves launchers and Missions links out, so neither has a page to deep-link
  // into. A hash that names one is a link someone will write by hand from the shelf list.
  assert.deepEqual(parseMissionRoute("#/library/ensembles"), { page: "library" });
  assert.deepEqual(parseMissionRoute("#/library/missions"), { page: "library" });
  assert.deepEqual(parseMissionRoute("#/library/nonsense"), { page: "library" });
  assert.deepEqual(parseMissionRoute("#/library/personas/id/extra"), { page: "fleet" });
});

test("the three legacy authoring hashes redirect into the Library, permanently", () => {
  assert.deepEqual(parseMissionRoute("#/workflows"), { page: "library" });
  assert.deepEqual(parseMissionRoute("#/workflows/personas"), {
    page: "library",
    shelf: "personas",
  });
  assert.deepEqual(parseMissionRoute("#/workflows/actions"), { page: "library", shelf: "actions" });
  // Trailing slashes take the same path, because a copied link often carries one.
  assert.deepEqual(parseMissionRoute("#/workflows/personas/"), {
    page: "library",
    shelf: "personas",
  });
  // The redirect is one-way: nothing serializes back to a legacy hash, which is what stops
  // the old spelling being reintroduced by a link the app itself writes.
  for (const hash of ["#/library", "#/library/personas", "#/library/actions"]) {
    assert.equal(missionRouteHash(parseMissionRoute(hash)), hash);
  }
});

// The execution routes left the Workflows page too, one phase after the authoring ones. What
// this case is here to hold is that the LIBRARY parse did not swallow them on the way: the
// three authoring redirects match `/workflows` and `/workflows/<shelf>`, and a run id is
// shaped exactly like a shelf name. The full redirect table lives in `workflow-route.test.ts`.
test("the execution routes are top-level, and the Library parse does not claim them", () => {
  assert.deepEqual(parseMissionRoute("#/runs"), { page: "runs" });
  assert.deepEqual(parseMissionRoute("#/runs/r1"), { page: "runs", runId: "r1" });
  assert.deepEqual(parseMissionRoute("#/ensembles/e1"), { page: "ensembles", ensembleId: "e1" });
  assert.deepEqual(parseMissionRoute("#/runs?status=running"), {
    page: "runs",
    filters: { status: "running" },
  });
  // The legacy spellings land on those same routes rather than on the Library's shelves
  // index, which is where an over-eager `/workflows/*` authoring redirect would put them.
  assert.deepEqual(parseMissionRoute("#/workflows/runs/r1"), { page: "runs", runId: "r1" });
  assert.deepEqual(parseMissionRoute("#/workflows/ensembles/e1"), {
    page: "ensembles",
    ensembleId: "e1",
  });
});

test("the three page shortcuts are direct destinations with shared stand-downs", () => {
  const clear = { typing: false, renaming: false, overlayOpen: false };
  assert.deepEqual(pageShortcutRoute({ ...clear, target: "fleet" }), { page: "fleet" });
  assert.deepEqual(pageShortcutRoute({ ...clear, target: "library" }), { page: "library" });
  assert.deepEqual(pageShortcutRoute({ ...clear, target: "runs" }), { page: "runs" });

  // No target means no page chord matched. The other three stand-downs let the same bare
  // letters type, rename and dismiss an overlay instead of navigating behind it.
  assert.equal(pageShortcutRoute({ ...clear, target: null }), null);
  assert.equal(pageShortcutRoute({ ...clear, target: "fleet", typing: true }), null);
  assert.equal(pageShortcutRoute({ ...clear, target: "library", renaming: true }), null);
  assert.equal(pageShortcutRoute({ ...clear, target: "runs", overlayOpen: true }), null);
});

test("every shelf has copy, and every routable shelf is a shelf", () => {
  assert.deepEqual(LIBRARY_SHELF_COPY.map((shelf) => shelf.id), [...LIBRARY_SHELVES]);
  for (const surface of LIBRARY_SURFACES) {
    assert.ok(
      (LIBRARY_SHELVES as readonly string[]).includes(surface),
      `${surface} is routable but is not a shelf`,
    );
  }
  for (const shelf of LIBRARY_SHELF_COPY) {
    // The heading is the QUESTION. A shelf that answered with its own noun would be the
    // silence this page was built to end.
    assert.match(shelf.question, /\?$/, `${shelf.id} must be headed by a question`);
    assert.notEqual(shelf.question, shelf.eyebrow);
    assert.ok(shelf.why.length > 40, `${shelf.id} must say what the thing is for`);
  }
});
