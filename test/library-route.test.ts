import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIBRARY_SHELVES,
  LIBRARY_SURFACES,
  missionRouteHash,
  pageToggleRoute,
  parseMissionRoute,
} from "../src/web/workflows/useWorkflowRoute.ts";
import { LIBRARY_SHELF_COPY } from "../src/web/library/library-model.ts";

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

    const withAsset = { page: "library", shelf, assetId: "asset 7" } as const;
    assert.equal(missionRouteHash(withAsset), `#/library/${shelf}/asset%207`);
    assert.deepEqual(parseMissionRoute(missionRouteHash(withAsset)), withAsset);

    const creating = { page: "library", shelf, creating: true } as const;
    assert.equal(missionRouteHash(creating), `#/library/${shelf}/new`);
    assert.deepEqual(parseMissionRoute(missionRouteHash(creating)), creating);
  }
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

test("the page toggle swings between the two homes, and stands down everywhere else", () => {
  const guards = { active: true, typing: false, renaming: false, overlayOpen: false };
  assert.deepEqual(pageToggleRoute({ ...guards, page: "fleet" }), { page: "library" });
  assert.deepEqual(pageToggleRoute({ ...guards, page: "library" }), { page: "fleet" });
  // Settings is reached and left by the gear; Runs and Ensembles are watched, not authored,
  // and are reached from the Line. None of the three is a home the chord swings to, so it
  // does nothing rather than guessing.
  assert.equal(pageToggleRoute({ ...guards, page: "settings" }), null);
  assert.equal(pageToggleRoute({ ...guards, page: "runs" }), null);
  assert.equal(pageToggleRoute({ ...guards, page: "ensembles" }), null);
  // The four stand-downs, which are what let `w` type, rename and dismiss.
  assert.equal(pageToggleRoute({ ...guards, active: false, page: "fleet" }), null);
  assert.equal(pageToggleRoute({ ...guards, typing: true, page: "fleet" }), null);
  assert.equal(pageToggleRoute({ ...guards, renaming: true, page: "fleet" }), null);
  assert.equal(pageToggleRoute({ ...guards, overlayOpen: true, page: "fleet" }), null);
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
