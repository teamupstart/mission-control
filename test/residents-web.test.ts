import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { withOverlayHost } from "./helpers/overlay-host.ts";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";
import { dispatchOpeningProblem, resolveDispatchOpening } from "../src/web/lib/dispatch-mode.ts";
import { blankResidentDraft, residentDraftProblem } from "../src/web/residents/ResidentProfileEditor.tsx";
import {
  chooseResidentRepo,
  freshResidentDispatchDraft,
  residentAttemptMatches,
  residentDispatchRepo,
  residentRetryWithoutProfile,
  retryResidentAttempt,
  selectResidentProfile,
} from "../src/web/residents/dispatch-draft.ts";
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

test("#/residents round-trips with and without a profile, and on a new draft", () => {
  assert.deepEqual(parseMissionRoute("#/residents"), { page: "residents" });
  assert.deepEqual(parseMissionRoute("#/residents/new"), { page: "residents", creating: true });
  assert.equal(missionRouteHash({ page: "residents", creating: true }), "#/residents/new");
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

test("a profile-sourced repository follows the profile's current default; an operator's choice is kept", () => {
  const a = profile("a", "/repos/a");
  const b = profile("b", "/repos/b");
  const none = profile("c", null);
  const first = selectResidentProfile(freshResidentDispatchDraft(), a);
  assert.equal(residentDispatchRepo(first, a), "/repos/a");
  // The default changed after the form was prefilled: the launch reads the new one.
  const moved = { ...a, revision: 2, settings: { ...a.settings, workspace: { defaultRepoRoot: "/repos/a-moved" } } };
  assert.equal(residentDispatchRepo(first, moved), "/repos/a-moved");
  // Switching profile follows the next profile's default, and one with none leaves it empty.
  assert.equal(residentDispatchRepo(selectResidentProfile(first, b), b), "/repos/b");
  assert.equal(residentDispatchRepo(selectResidentProfile(first, none), none), "");
  // A typed repository is the operator's and survives both a profile switch and a default edit.
  const typed = chooseResidentRepo(first, "/elsewhere");
  assert.equal(residentDispatchRepo(selectResidentProfile(typed, b), b), "/elsewhere");
  assert.equal(residentDispatchRepo(typed, moved), "/elsewhere");
  // Clearing it hands the repository back to the profile on the next selection.
  assert.equal(residentDispatchRepo(selectResidentProfile(chooseResidentRepo(first, ""), b), b), "/repos/b");
  assert.equal(selectResidentProfile(first, b).requestId, first.requestId);
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
  assert.match(html, /role="dialog"[^>]*aria-modal="true"|aria-modal="true"[^>]*role="dialog"/);
  for (const label of ["Single agent", "Ensemble", "Resident"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Resident</);
  assert.match(html, /Profile a/);
  assert.match(html, /Profile b/);
  assert.match(html, /Launch resident/);
  assert.match(html, /value="\/repos\/a"/);
});

test("an uncertain attempt matches only the exact input it sent, and retrying restores that input and id", () => {
  const a = profile("a", "/repos/a");
  const b = profile("b", "/repos/b");
  const draft = { ...selectResidentProfile(freshResidentDispatchDraft(), a), instructions: "Today" };
  const attempt = { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", instructions: "Today" };
  assert.equal(residentAttemptMatches(attempt, draft, a), true);
  assert.equal(residentAttemptMatches(attempt, { ...draft, instructions: " Today " }, a), true, "whitespace alone is not a change");
  assert.equal(residentAttemptMatches(attempt, selectResidentProfile(draft, b), b), false, "another profile");
  assert.equal(residentAttemptMatches(attempt, chooseResidentRepo(draft, "/elsewhere"), a), false, "another repository");
  assert.equal(residentAttemptMatches(attempt, { ...draft, instructions: "Tomorrow" }, a), false, "other instructions");
  const changed = { ...selectResidentProfile(draft, b), requestId: "other", instructions: "Tomorrow" };
  const retried = retryResidentAttempt(changed, attempt);
  assert.equal(retried.requestId, attempt.requestId);
  assert.equal(residentAttemptMatches(attempt, retried, a), true);
  // The exact repository that was sent, even if the profile's default has moved since.
  const moved = { ...a, settings: { ...a.settings, workspace: { defaultRepoRoot: "/repos/a-moved" } } };
  assert.equal(residentDispatchRepo(retried, moved), "/repos/a");
});

test("while a draft's own launch is outstanding, its profile-sourced repository stays as sent", () => {
  const a = profile("a", "/repos/a");
  const draft = selectResidentProfile(freshResidentDispatchDraft(), a);
  const outstanding = {
    ...draft,
    uncertain: { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", instructions: "" },
  };
  const moved = { ...a, settings: { ...a.settings, workspace: { defaultRepoRoot: "/repos/a-moved" } } };
  assert.equal(residentDispatchRepo(outstanding, moved), "/repos/a", "frozen while outstanding");
  assert.equal(residentAttemptMatches(outstanding.uncertain, outstanding, moved), true, "so the replay is exact");
  // Once settled (no outstanding launch), the default is followed again.
  assert.equal(residentDispatchRepo({ ...outstanding, uncertain: null }, moved), "/repos/a-moved");
  // A different profile is not frozen by another profile's launch.
  const b = profile("b", "/repos/b");
  assert.equal(residentDispatchRepo(selectResidentProfile(outstanding, b), b), "/repos/b");
});

test("an outstanding launch whose profile was archived stays retryable exactly, and nothing else does", () => {
  const a = profile("a", "/repos/a");
  const draft = { ...selectResidentProfile(freshResidentDispatchDraft(), a), instructions: "Today" };
  const attempt = { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", instructions: "Today" };
  const outstanding = { ...draft, uncertain: attempt };
  // Archived: the live catalog no longer has the profile, so the form resolves none.
  assert.deepEqual(residentRetryWithoutProfile(outstanding, null), attempt);
  // The repository it reads is still the one that was sent.
  assert.equal(residentDispatchRepo(outstanding, null), "/repos/a");
  // Still live: the ordinary launch path applies.
  assert.equal(residentRetryWithoutProfile(outstanding, a), null);
  // Nothing outstanding, or a form that no longer says exactly that launch, cannot send without a profile.
  assert.equal(residentRetryWithoutProfile(draft, null), null);
  assert.equal(residentRetryWithoutProfile({ ...outstanding, instructions: "Tomorrow" }, null), null);
  assert.equal(residentRetryWithoutProfile(chooseResidentRepo(outstanding, "/elsewhere"), null), null);
  assert.equal(residentRetryWithoutProfile({ ...outstanding, requestId: "new" }, null), null);
  assert.equal(residentRetryWithoutProfile({ ...outstanding, profileId: null }, null), null);
});
