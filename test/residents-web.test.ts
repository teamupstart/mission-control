import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { withOverlayHost } from "./helpers/overlay-host.ts";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";
import { dispatchOpeningProblem, resolveDispatchOpening } from "../src/web/lib/dispatch-mode.ts";
import { blankResidentDraft, residentDraftProblem } from "../src/web/residents/ResidentProfileEditor.tsx";
import { freshResidentDispatchDraft, selectResidentProfile } from "../src/web/residents/dispatch-draft.ts";
import { parseMissionRoute, missionRouteHash } from "../src/web/workflows/useWorkflowRoute.ts";
import { RESIDENT_PROFILE_SECTION_IDS, ResidentProfileRevisionSchema, type ResidentProfile } from "../src/shared/residents.ts";

function profile(id: string, repo: string | null): ResidentProfile {
  return {
    id,
    name: `Profile ${id}`,
    revision: 1,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    settings: ResidentProfileRevisionSchema.parse({
      identity: { name: `Profile ${id}` },
      persona: { personaId: "builtin:code-risk-reviewer" },
      workspace: { defaultRepoRoot: repo },
    }),
  };
}

test("#/residents round-trips with and without a profile", () => {
  assert.deepEqual(parseMissionRoute("#/residents"), { page: "residents" });
  assert.deepEqual(parseMissionRoute("#/residents/p%201"), { page: "residents", profileId: "p 1" });
  assert.equal(missionRouteHash({ page: "residents", profileId: "p 1" }), "#/residents/p%201");
  assert.equal(missionRouteHash({ page: "residents" }), "#/residents");
});

test("a Resident request opens Resident mode, and is refused while the tour holds the form", () => {
  const opened = resolveDispatchOpening({ kind: "resident", profileId: "p1" }, { editTask: null, tourDemo: null });
  assert.deepEqual(opened, { opening: { kind: "resident", profileId: "p1" }, problem: null });
  assert.equal(dispatchOpeningProblem(opened.opening), null);
  const tour = { id: "tour", briefReady: false, repoRoot: null, dispatch: async () => ({ ok: true }) };
  const refused = resolveDispatchOpening({ kind: "resident", profileId: null }, { editTask: null, tourDemo: tour });
  assert.equal(refused.opening, null);
  assert.match(refused.problem ?? "", /Resident request while the See the work tour/);
});

test("choosing a profile pre-fills its repository unless the operator typed their own", () => {
  const a = profile("a", "/repos/a");
  const b = profile("b", "/repos/b");
  const none = profile("c", null);
  const first = selectResidentProfile(freshResidentDispatchDraft(), a, null);
  assert.equal(first.repoRoot, "/repos/a");
  assert.equal(selectResidentProfile(first, b, a).repoRoot, "/repos/b", "a previous default is replaced");
  const typed = { ...first, repoRoot: "/elsewhere" };
  assert.equal(selectResidentProfile(typed, b, a).repoRoot, "/elsewhere", "the operator's own choice is kept");
  assert.equal(selectResidentProfile(first, none, a).repoRoot, "", "a profile with no default clears the old one");
  assert.equal(selectResidentProfile(first, b, a).requestId, first.requestId);
});

test("a blank draft carries every registered section and is not yet saveable", () => {
  const draft = blankResidentDraft();
  assert.deepEqual(Object.keys(draft).sort(), [...RESIDENT_PROFILE_SECTION_IDS].sort());
  assert.match(residentDraftProblem(draft) ?? "", /name/);
  assert.equal(residentDraftProblem({ ...draft, identity: { name: "Bot", description: "" }, persona: { personaId: "p" } }), null);
});

test("the Dispatch layer renders Resident mode with the shared three-way toggle and the profile cards", () => {
  const html = renderToStaticMarkup(withOverlayHost(createElement(DispatchLayer, {
    opening: { kind: "resident", profileId: "a" },
    residentProfiles: [profile("a", "/repos/a"), profile("b", null)],
    onClose: () => {},
  })));
  assert.match(html, /aria-label="Launch mode"/);
  for (const label of ["Single agent", "Ensemble", "Resident"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Resident</);
  assert.match(html, /Profile a/);
  assert.match(html, /Profile b/);
  assert.match(html, /Launch resident/);
  assert.match(html, /value="\/repos\/a"/);
});
