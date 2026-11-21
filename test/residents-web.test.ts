import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { withOverlayHost } from "./helpers/overlay-host.ts";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";
import { dispatchOpeningProblem, resolveDispatchOpening } from "../src/web/lib/dispatch-mode.ts";
import { blankResidentDraft, residentDraftProblem } from "../src/web/residents/ResidentProfileEditor.tsx";
import { residentProfileFact } from "../src/web/residents/ResidentsPage.tsx";
import {
  chooseResidentAttachedRepos,
  chooseResidentRepo,
  freshResidentDispatchDraft,
  residentAttemptMatches,
  residentDispatchAttachedRepos,
  residentDispatchRepo,
  residentRetryWithoutProfile,
  retryResidentAttempt,
  selectResidentProfile,
  separateResidentLaunch,
} from "../src/web/residents/dispatch-draft.ts";
import { AttachedRepoChips } from "../src/web/components/AttachedRepoChips.tsx";
import { MAX_TASK_EXTRA_REPOS } from "../src/shared/task.ts";
import { parseMissionRoute, missionRouteHash } from "../src/web/workflows/useWorkflowRoute.ts";
import {
  RESIDENT_PROFILE_SECTION_IDS,
  ResidentProfileRevisionSchema,
  residentLaunchSummary,
  residentMcpSummary,
  type ResidentProfile,
} from "../src/shared/residents.ts";

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
  const moved = { ...a, revision: 2, settings: { ...a.settings, workspace: { defaultRepoRoot: "/repos/a-moved", additionalRepoRoots: [] } } };
  assert.equal(residentDispatchRepo(first, moved), "/repos/a-moved");
  // Switching profile follows the next profile's default, and one with none leaves it empty.
  assert.equal(residentDispatchRepo(selectResidentProfile(first, b), b), "/repos/b");
  assert.equal(residentDispatchRepo(selectResidentProfile(first, none), none), "");
  // A typed repository is the operator's and survives both a profile switch and a default edit.
  const typed = chooseResidentRepo(first, "/elsewhere", a);
  assert.equal(residentDispatchRepo(selectResidentProfile(typed, b), b), "/elsewhere");
  assert.equal(residentDispatchRepo(typed, moved), "/elsewhere");
  // Explicitly choosing no repository survives the next profile selection.
  assert.equal(residentDispatchRepo(selectResidentProfile(chooseResidentRepo(first, "", a), b), b), "");
  assert.equal(selectResidentProfile(first, b).requestId, first.requestId);
});

test("a blank draft carries every registered section and is not yet saveable", () => {
  const draft = blankResidentDraft();
  assert.deepEqual(Object.keys(draft).sort(), [...RESIDENT_PROFILE_SECTION_IDS].sort());
  assert.match(residentDraftProblem(draft) ?? "", /name/);
  assert.equal(residentDraftProblem({ ...draft, identity: { name: "Bot", description: "" }, persona: { personaId: "p" } }), null);
});

test("a draft without a Persona saves once its profile instructions give the role", () => {
  const draft = { ...blankResidentDraft(), identity: { name: "Bot", description: "" } };
  assert.equal(residentDraftProblem(draft), "choose a Persona or write profile instructions");
  assert.equal(residentDraftProblem({ ...draft, instructions: { markdown: "Watch the fleet." } }), null);
});

test("a profile without a Persona says so in the rail and the launch summary, not that one is missing", () => {
  const none = profile("solo", null);
  none.settings = { ...none.settings, persona: { personaId: "" } };
  assert.match(residentProfileFact(none, []), /^no Persona · /);
  assert.match(residentLaunchSummary(none.settings, null, "Claude Code"), /^no persona · /);
  const missing = profile("gone", null);
  assert.match(residentProfileFact(missing, []), /^missing Persona · /);
  assert.match(residentLaunchSummary(missing.settings, null, "Claude Code"), /^persona missing · /);
});

test("the launch summary says plainly when a resident's MCP set is not pinned, naming only what Mission Control adds", () => {
  const custom = { source: "custom" as const, id: "11111111-1111-4111-8111-111111111111" };
  const global = { source: "global" as const, agent: "claude" as const, name: "github" };
  const mcp = (over: Record<string, unknown>) => ResidentProfileRevisionSchema.parse({
    identity: { name: "S" }, persona: { personaId: "p" }, mcp: over,
  }).mcp;
  // Pinned, as before.
  assert.equal(residentMcpSummary(mcp({})), "MCP: defaults");
  assert.equal(residentMcpSummary(mcp({ selected: [global, custom] }), ["github", "linear"]), "MCP: defaults + github, linear");
  assert.equal(residentMcpSummary(mcp({ inheritDefaults: false, selected: [custom] }), ["linear"]), "MCP: only linear");
  // All native sources: global servers load natively, so only the custom ones are named.
  assert.equal(residentMcpSummary(mcp({ nativeSources: "all" })), "MCP: all native sources (not pinned)");
  assert.equal(residentMcpSummary(mcp({ nativeSources: "all", inheritDefaults: false, selected: [global] }), ["github"]), "MCP: all native sources (not pinned)");
  assert.equal(
    residentMcpSummary(mcp({ nativeSources: "all", selected: [global, custom] }), ["github", "linear"]),
    "MCP: all native sources (not pinned) + linear",
  );
  assert.equal(residentMcpSummary(mcp({ nativeSources: "all", selected: [global, custom] })), "MCP: all native sources (not pinned) + 1 custom");
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
  const attempt = { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", additionalRepoRoots: [], instructions: "Today" };
  assert.equal(residentAttemptMatches(attempt, draft, a), true);
  assert.equal(residentAttemptMatches(attempt, { ...draft, instructions: " Today " }, a), true, "whitespace alone is not a change");
  assert.equal(residentAttemptMatches(attempt, selectResidentProfile(draft, b), b), false, "another profile");
  assert.equal(residentAttemptMatches(attempt, chooseResidentRepo(draft, "/elsewhere", a), a), false, "another repository");
  assert.equal(residentAttemptMatches(attempt, { ...draft, instructions: "Tomorrow" }, a), false, "other instructions");
  const changed = { ...selectResidentProfile(draft, b), requestId: "other", instructions: "Tomorrow" };
  const retried = retryResidentAttempt(changed, attempt);
  assert.equal(retried.requestId, attempt.requestId);
  assert.equal(residentAttemptMatches(attempt, retried, a), true);
  // The exact repository that was sent, even if the profile's default has moved since.
  const moved = { ...a, settings: { ...a.settings, workspace: { defaultRepoRoot: "/repos/a-moved", additionalRepoRoots: [] } } };
  assert.equal(residentDispatchRepo(retried, moved), "/repos/a");
});

test("while a draft's own launch is outstanding, its profile-sourced repository stays as sent", () => {
  const a = profile("a", "/repos/a");
  const draft = selectResidentProfile(freshResidentDispatchDraft(), a);
  const outstanding = {
    ...draft,
    uncertain: { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", additionalRepoRoots: [], instructions: "" },
  };
  const moved = { ...a, settings: { ...a.settings, workspace: { defaultRepoRoot: "/repos/a-moved", additionalRepoRoots: [] } } };
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
  const attempt = { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", additionalRepoRoots: [], instructions: "Today" };
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
  assert.equal(residentRetryWithoutProfile(chooseResidentRepo(outstanding, "/elsewhere", a), null), null);
  assert.equal(residentRetryWithoutProfile({ ...outstanding, requestId: "new" }, null), null);
  assert.equal(residentRetryWithoutProfile({ ...outstanding, profileId: null }, null), null);
});

function withAttached(base: ResidentProfile, attached: string[]): ResidentProfile {
  return { ...base, settings: { ...base.settings, workspace: { ...base.settings.workspace, additionalRepoRoots: attached } } };
}

test("attached repositories follow the profile's default with its primary, and become the operator's with either", () => {
  const a = withAttached(profile("a", "/repos/a"), ["/repos/shared"]);
  const draft = selectResidentProfile(freshResidentDispatchDraft(), a);
  assert.deepEqual(residentDispatchAttachedRepos(draft, a), ["/repos/shared"]);
  // An edited default is followed while the set is still the profile's.
  assert.deepEqual(residentDispatchAttachedRepos(draft, withAttached(a, ["/repos/other"])), ["/repos/other"]);
  // Taking over the primary keeps the attachments it was shown with; the profile no longer moves them.
  const typed = chooseResidentRepo(draft, "/elsewhere", a);
  assert.deepEqual(residentDispatchAttachedRepos(typed, withAttached(a, ["/repos/other"])), ["/repos/shared"]);
  assert.equal(residentDispatchRepo(typed, a), "/elsewhere");
  // Attaching or detaching takes over the primary too, so a default edit cannot move it underneath.
  const detached = chooseResidentAttachedRepos(draft, [], a);
  assert.deepEqual(residentDispatchAttachedRepos(detached, a), []);
  assert.equal(residentDispatchRepo(detached, profile("a", "/repos/moved")), "/repos/a");
  // No repository detaches every attachment: they need a primary.
  assert.deepEqual(residentDispatchAttachedRepos(chooseResidentRepo(draft, "", a), a), []);
});

test("an uncertain attempt's attached repositories are part of what makes a retry exact", () => {
  const a = withAttached(profile("a", "/repos/a"), ["/repos/shared"]);
  const draft = selectResidentProfile(freshResidentDispatchDraft(), a);
  const attempt = { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", additionalRepoRoots: ["/repos/shared"], instructions: "" };
  assert.equal(residentAttemptMatches(attempt, draft, a), true);
  assert.equal(residentAttemptMatches(attempt, chooseResidentAttachedRepos(draft, [], a), a), false, "detached");
  assert.equal(residentAttemptMatches(attempt, chooseResidentAttachedRepos(draft, ["/repos/shared", "/repos/x"], a), a), false, "one more");
  // While outstanding, the set stays as sent even if the profile's default moves.
  const outstanding = { ...draft, uncertain: attempt };
  assert.deepEqual(residentDispatchAttachedRepos(outstanding, withAttached(a, [])), ["/repos/shared"]);
  // Retrying restores exactly the set that was sent.
  const retried = retryResidentAttempt(chooseResidentAttachedRepos(draft, [], a), attempt);
  assert.deepEqual(residentDispatchAttachedRepos(retried, a), ["/repos/shared"]);
});

test("Dispatch > Resident shows the profile's attached repositories with Detach and Add another repo, and none without a primary", () => {
  const html = renderToStaticMarkup(withOverlayHost(createElement(DispatchLayer, {
    opening: { kind: "resident", profileId: "a" },
    residentProfiles: [withAttached(profile("a", "/repos/a"), ["/repos/shared"])],
    onClose: () => {},
  })));
  assert.match(html, /aria-label="Detach repo: \/repos\/shared"/);
  assert.match(html, /aria-label="Add another repo"/);
  assert.match(html, /Each repo the resident changes gets its own pull request/);
  const none = renderToStaticMarkup(withOverlayHost(createElement(DispatchLayer, {
    opening: { kind: "resident", profileId: "b" },
    residentProfiles: [profile("b", null)],
    onClose: () => {},
  })));
  assert.doesNotMatch(none, /Add another repo/, "a repository-free resident has nothing to attach beside");
});

test("Launch as a new resident keeps the repository set the form displayed, not the profile's edited default", () => {
  const a = withAttached(profile("a", "/repos/a"), ["/repos/b"]);
  const draft = selectResidentProfile(freshResidentDispatchDraft(), a);
  const attempt = { requestId: draft.requestId, profileId: "a", profileName: "Profile a", repoRoot: "/repos/a", additionalRepoRoots: ["/repos/b"], instructions: "" };
  // The answer was lost, then the profile's default moved and the operator changed the instructions.
  const edited = withAttached(profile("a", "/repos/a-moved"), ["/repos/c"]);
  const outstanding = { ...draft, uncertain: attempt, instructions: "Something else" };
  assert.equal(residentDispatchRepo(outstanding, edited), "/repos/a", "the form shows the set that was sent");
  assert.deepEqual(residentDispatchAttachedRepos(outstanding, edited), ["/repos/b"]);
  const next = separateResidentLaunch(outstanding, edited);
  assert.equal(next.uncertain, null);
  assert.notEqual(next.requestId, draft.requestId, "a separate resident is a new launch");
  assert.equal(residentDispatchRepo(next, edited), "/repos/a", "and it launches what was displayed");
  assert.deepEqual(residentDispatchAttachedRepos(next, edited), ["/repos/b"]);
  assert.equal(next.instructions, "Something else");
});

test("the attachment control stops offering attachments at the shared cap and keeps Detach", () => {
  const render = (count: number) => renderToStaticMarkup(withOverlayHost(createElement(AttachedRepoChips, {
    primary: "/repos/a",
    attached: Array.from({ length: count }, (_, index) => `/repos/extra-${index}`),
    repos: [],
    onChange: () => {},
  })));
  const add = (html: string) => /<button[^>]*aria-label="Add another repo"[^>]*>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(add(render(MAX_TASK_EXTRA_REPOS - 1)), /disabled/, "below the cap, another can be attached");
  const full = render(MAX_TASK_EXTRA_REPOS);
  assert.match(add(full), /disabled/, "at the cap, Add another repo is disabled");
  const detach = /<button[^>]*aria-label="Detach repo: \/repos\/extra-0"[^>]*>/.exec(full)?.[0] ?? "";
  assert.ok(detach, "every attachment still renders");
  assert.doesNotMatch(detach, /disabled/, "and can still be detached");
});
