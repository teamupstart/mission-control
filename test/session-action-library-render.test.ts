import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import type {
  SessionAction,
  SessionActionCompletionCapability,
} from "../src/shared/workflow.ts";
import { CreateSessionActionSchema } from "../src/shared/protocol.ts";
import {
  filterSessionActions,
  SessionActionLibrary,
  sessionActionRevisionLine,
  sessionActionRowSummary,
} from "../src/web/workflows/SessionActionLibrary.tsx";
import {
  completionChoices,
  isSessionActionSaveShortcut,
  reconcileSessionActionSave,
  SessionActionEditor,
  SessionActionEditorStatus,
  sessionActionCreateBody,
  sessionActionDraftProblem,
  sessionActionPromptPath,
  sessionActionSeed,
  sessionActionUpdatePatch,
  type SessionActionDraftSeed,
} from "../src/web/workflows/SessionActionEditor.tsx";
import { WorkflowPage } from "../src/web/workflows/WorkflowPage.tsx";
import {
  missionRouteHash,
  parseMissionRoute,
} from "../src/web/workflows/useWorkflowRoute.ts";

/**
 * What is at stake: this is the first surface an operator uses to author something that TYPES
 * INTO their session. Two things carry the whole feature.
 *
 * The prompt is exact. It is stored, snapshotted at publish and delivered byte for byte, so
 * anything here that trimmed, normalized or re-wrapped it would deliver an instruction nobody
 * wrote - and the version would freeze the rewritten one.
 *
 * The completion selector is the daemon's answer, not the bundle's. Offering an adapter this
 * build cannot execute produces a workflow that authors cleanly and then refuses to publish.
 */

const CAPABILITIES: SessionActionCompletionCapability[] = [
  { kind: "session_turn", available: true, label: "Session turn finishes", unavailableReason: null },
  {
    kind: "pull_request",
    available: false,
    label: "Pull request is opened and verified",
    unavailableReason: "This build cannot verify a pull request yet.",
  },
];

const action = (patch: Partial<SessionAction> = {}): SessionAction => ({
  id: "act-1",
  name: "Tidy the workspace",
  normalizedName: "tidy the workspace",
  description: "Remove the scratch files",
  promptMarkdown: "# Tidy\n\nRemove the scratch files.\n",
  requiredSkillId: null,
  completion: { kind: "session_turn" },
  revision: 2,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1_700_000_000_000,
  builtin: false,
  ...patch,
});

const library = (
  sessionActions: SessionAction[],
  hasSnapshot = true,
): string =>
  renderToStaticMarkup(createElement(SessionActionLibrary, {
    sessionActions,
    hasSnapshot,
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
  }));

const editor = (
  target: SessionAction | null,
  seed?: SessionActionDraftSeed,
  capabilities: SessionActionCompletionCapability[] = CAPABILITIES,
): string =>
  renderToStaticMarkup(createElement(SessionActionEditor, {
    action: target,
    ...(seed ? { seed } : {}),
    capabilities,
    skills: [
      { id: "pull-request", name: "pull-request", description: "", category: "git", enforcement: "triggered" },
    ],
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
    onSaved: () => {},
    onDuplicate: () => {},
    onArchive: () => {},
  }));

test("the Actions tab is a real route, and the page renders a panel for it", () => {
  assert.deepEqual(parseMissionRoute("#/workflows/actions"), {
    page: "workflows",
    tab: "actions",
  });
  // The word an operator sees in the tab is the word in the URL, so a link copied out of the
  // address bar comes back to the same place.
  assert.equal(missionRouteHash({ page: "workflows", tab: "actions" }), "#/workflows/actions");

  const page = renderToStaticMarkup(createElement(WorkflowPage, {
    tab: "actions",
    personas: [],
    sessionActions: [action()],
    hasSnapshot: true,
    llm: { status: null, personaDefaults: null } as never,
    isOverlayOpen: () => false,
    onTab: () => {},
    onDirtyChange: () => {},
  }));
  assert.match(page, /id="workflow-panel-actions"/);
  assert.match(page, /aria-labelledby="workflow-tab-actions"/);
  assert.match(page, /Author the instructions a workflow stage sends to its bound session/);
  // Beside Personas, and never instead of it.
  assert.match(page, /id="workflow-tab-personas"/);
});

test("the list names what a row needs, what proves it, and whose it is", () => {
  const html = library([
    action(),
    action({ id: "b", name: "Pull Request", normalizedName: "pull request", builtin: true, requiredSkillId: "pull-request", completion: { kind: "pull_request" } }),
  ]);
  assert.match(html, /Tidy the workspace/);
  assert.match(html, /No required skill · Session turn finishes/);
  assert.match(html, /Skill · pull-request · Pull request is opened and verified/);
  assert.match(html, /Revision 2 · updated/);
  assert.match(html, /Built-in · ships with this build/);
  // Provenance both ways: a shipped row and an operator's own are told apart at a glance and
  // in words, so the read-only editor is not a surprise.
  assert.match(html, />Built-in</);
  assert.match(html, />Yours</);
  // 2 actions, one of them a built-in, both live.
  assert.match(html, /2 active/);
});

test("the row summary and the revision line answer for archived and built-in rows", () => {
  assert.equal(sessionActionRowSummary(action({ archivedAt: 5 })), "Archived");
  assert.equal(
    sessionActionRowSummary(action({ requiredSkillId: "pull-request" })),
    "Skill · pull-request · Session turn finishes",
  );
  assert.equal(
    sessionActionRevisionLine(action({ builtin: true })),
    "Built-in · ships with this build",
    "a shipped row carries a synthetic revision and no publish instant to print",
  );
  assert.match(sessionActionRevisionLine(action()), /^Revision 2 · updated /);
});

test("search and state filtering agree with what the empty states claim", () => {
  const rows = [action(), action({ id: "old", name: "Retired", normalizedName: "retired", archivedAt: 9 })];
  assert.deepEqual(filterSessionActions(rows, "active", "").map((a) => a.id), ["act-1"]);
  assert.deepEqual(filterSessionActions(rows, "archived", "").map((a) => a.id), ["old"]);
  // Name OR description, case-insensitively, the way the Persona library searches.
  assert.deepEqual(filterSessionActions(rows, "active", "SCRATCH").map((a) => a.id), ["act-1"]);
  assert.deepEqual(filterSessionActions(rows, "active", "nothing"), []);

  assert.match(library([]), /No session actions yet\. New authors the first one/);
  // Before the SSE snapshot lands, an empty catalog and an unread one look identical, and
  // "none yet" beside a New button invites authoring a duplicate of what is about to appear.
  assert.match(library([], false), /Loading session actions…/);
});

test("a live operator row shadows a same-named built-in in the list", () => {
  const html = library([
    action({ id: "builtin:pull-request", name: "Pull Request", normalizedName: "pull request", builtin: true }),
    action({ id: "mine", name: "Pull Request", normalizedName: "pull request" }),
  ]);
  // One row, and it is the operator's - the same rule the Persona library applies, so the two
  // libraries cannot disagree about what a name collision means.
  assert.equal([...html.matchAll(/wf-action-list-item/g)].length, 1);
  assert.doesNotMatch(html, />Built-in</);
});

test("the editor authors the five fields, and offers only the adapters the daemon reported", () => {
  const html = editor(action());
  assert.match(html, /Required skill/);
  assert.match(html, /Completes when/);
  assert.match(html, /Session turn finishes/);
  // The one this build cannot execute is not selectable and is not silently absent either -
  // it is simply not offered, because the current value is not it.
  assert.doesNotMatch(html, /<option[^>]*>Pull request is opened and verified<\/option>/);
  // The prompt editor states the exact ceiling a delivery packet can carry.
  assert.match(
    html,
    new RegExp(`${WORKFLOW_LIMITS.sessionActionPromptBytes.toLocaleString()} UTF-8 bytes`),
  );
  assert.match(html, /Revision 2/);
  assert.match(html, /Archive/);
  assert.match(html, /Duplicate/);
});

test("an action already naming an unavailable adapter keeps it, disabled, and says why", () => {
  const html = editor(action({ completion: { kind: "pull_request" } }));
  // Retained, or the next save would quietly rewrite the proof contract this action was
  // authored with.
  assert.match(
    html,
    /<option value="pull_request" disabled="" selected="">Pull request is opened and verified<\/option>/,
  );
  assert.match(html, /This build cannot verify a pull request yet\./);

  const choices = completionChoices(CAPABILITIES, "pull_request");
  assert.deepEqual(choices.map((choice) => choice.kind), ["pull_request", "session_turn"]);
  assert.equal(choices[0]!.disabled, true);
  assert.equal(choices[1]!.disabled, false);
  // The ordinary case offers exactly the available ones, in the daemon's order.
  assert.deepEqual(
    completionChoices(CAPABILITIES, "session_turn").map((choice) => choice.kind),
    ["session_turn"],
  );
});

test("a capability read still in flight accuses the action of nothing", () => {
  // Every editor opens before the capabilities request lands, so for one round trip the
  // retained arm fires for a completion that may be perfectly available. Loading is not a
  // refusal: the option is held so the select cannot repaint, and it says nothing.
  const loading = completionChoices([], "session_turn", true);
  assert.deepEqual(loading.map((choice) => choice.kind), ["session_turn"]);
  assert.equal(loading[0]!.note, null, "a pending read is not an accusation");
  // And it reads as itself rather than as the wire spelling. The shared table supplies the
  // WORDING; `available` still comes only from the daemon.
  assert.equal(loading[0]!.label, "Session turn finishes");
  assert.doesNotMatch(loading[0]!.label, /session_turn/);

  // Once the answer arrives and genuinely says no, the reason appears.
  assert.equal(
    completionChoices([], "session_turn", false)[0]!.note,
    "This build cannot prove this completion.",
  );
});

test("a built-in and an archived action are read-only, and say which and why", () => {
  const builtin = editor(action({ builtin: true }));
  assert.match(builtin, /Built-in session action/);
  assert.match(builtin, /Duplicate it to make a copy you own and can edit/);
  assert.doesNotMatch(builtin, /Archive<\/button>/);

  const archived = editor(action({ archivedAt: 9 }));
  assert.match(archived, /is read-only and is no longer offered to new stages/);
  assert.match(archived, /Every published version keeps the instruction it was published with/);
});

test("the conflict banner preserves the draft and offers both ways out", () => {
  const html = renderToStaticMarkup(createElement(SessionActionEditorStatus, {
    dirty: true,
    conflict: action({ revision: 7 }),
    archived: false,
    onReload: () => {},
    onDuplicate: () => {},
  }));
  // The load-bearing sentence: nothing the operator typed has been touched.
  assert.match(html, /Your instruction has not been changed/);
  assert.match(html, /r7/, "the operator is told which revision is now current");
  assert.match(html, /Reload latest/);
  assert.match(html, /Save as duplicate/);
  assert.match(html, /role="alert"/);
});

test("a save in flight merges with edits typed after it left", () => {
  const saved = action({ revision: 3, name: "Saved name", promptMarkdown: "# Saved\n" });
  const submitted = sessionActionSeed(action({ name: "Saved name", promptMarkdown: "# Saved\n" }));
  const current: SessionActionDraftSeed = { ...submitted, description: "typed while saving" };

  const same = reconcileSessionActionSave(saved, submitted, current, 4, 4);
  assert.equal(same.dirty, false, "no edits since the request left: the server's row wins whole");

  const merged = reconcileSessionActionSave(saved, submitted, current, 4, 5);
  assert.equal(merged.draft.description, "typed while saving", "the newer edit survives");
  assert.equal(merged.draft.name, "Saved name", "everything untouched adopts the acknowledged row");
  assert.equal(merged.dirty, true);
});

test("the update patch is sparse and carries the revision it expects", () => {
  const original = action({ revision: 4 });
  const draft: SessionActionDraftSeed = {
    ...sessionActionSeed(original),
    promptMarkdown: "# Tidy\r\n\r\nWith CRLF and a trailing space \n",
    completionKind: "pull_request",
  };
  const patch = sessionActionUpdatePatch(original, draft, 4);
  assert.deepEqual(Object.keys(patch).sort(), ["completion", "expectedRevision", "promptMarkdown"]);
  assert.deepEqual(patch.completion, { kind: "pull_request" });
  // EXACT. The editor keeps the operator's own line endings and trailing whitespace, because
  // this string is typed into a conversation verbatim.
  assert.equal(patch.promptMarkdown, "# Tidy\r\n\r\nWith CRLF and a trailing space \n");

  // A save that changed nothing is one key, which is how the editor knows not to send it: the
  // route refuses an update with no editable fields, and that would surface as an error.
  assert.deepEqual(Object.keys(sessionActionUpdatePatch(original, sessionActionSeed(original), 4)), [
    "expectedRevision",
  ]);
});

test("the create body survives the schema that will receive it, prompt byte for byte", () => {
  const prompt = "\n# Leading blank line\r\n\r\nAnd a trailing space \n";
  const body = sessionActionCreateBody({
    name: "  Tidy  ",
    description: "",
    promptMarkdown: prompt,
    requiredSkillId: "pull-request",
    completionKind: "session_turn",
  });
  const parsed = CreateSessionActionSchema.parse(body);
  assert.equal(parsed.promptMarkdown, prompt, "the boundary observes the prompt and never rewrites it");
  assert.equal(parsed.name, "Tidy", "a NAME is trimmed - it is an identifier, not a payload");
  assert.deepEqual(parsed.completion, { kind: "session_turn" });
});

test("the draft's own refusal names the field, with the shared bound behind it", () => {
  const ok: SessionActionDraftSeed = {
    name: "Tidy",
    description: "",
    promptMarkdown: "# Tidy\n",
    requiredSkillId: null,
    completionKind: "session_turn",
  };
  assert.equal(sessionActionDraftProblem(ok, 8), null);
  assert.match(sessionActionDraftProblem({ ...ok, name: "  " }, 8)!, /needs a name/);
  assert.match(sessionActionDraftProblem({ ...ok, promptMarkdown: "\n\n" }, 8)!, /needs an instruction to send/);
  // The ceiling is the DELIVERY packet's, so the sentence says what will not fit rather than
  // quoting a number an operator has no way to interpret.
  assert.match(
    sessionActionDraftProblem(ok, WORKFLOW_LIMITS.sessionActionPromptBytes + 1)!,
    /over the .* a session action packet can carry/,
  );
  // A skill is a catalog id and never a command; anything that could carry a shell
  // metacharacter or a path separator is refused before it reaches the route.
  assert.match(
    sessionActionDraftProblem({ ...ok, requiredSkillId: "rm -rf /" }, 8)!,
    /catalog id, not a command/,
  );
});

test("the prompt file name is derived, and never leaks an id", () => {
  assert.equal(sessionActionPromptPath("Tidy the workspace"), "tidy-the-workspace.md");
  assert.equal(sessionActionPromptPath(""), "session-action.md");
  assert.equal(sessionActionPromptPath("!!!"), "session-action.md");
});

test("Cmd/Ctrl+S saves, and stands down while an overlay owns the screen", () => {
  assert.equal(isSessionActionSaveShortcut({ metaKey: true, ctrlKey: false, key: "s" }, false), true);
  assert.equal(isSessionActionSaveShortcut({ metaKey: false, ctrlKey: true, key: "S" }, false), true);
  assert.equal(isSessionActionSaveShortcut({ metaKey: true, ctrlKey: false, key: "s" }, true), false);
  assert.equal(isSessionActionSaveShortcut({ metaKey: false, ctrlKey: false, key: "s" }, false), false);
});

test("no capability answer means nothing is selectable, and the reason is on screen", () => {
  const html = renderToStaticMarkup(createElement(SessionActionEditor, {
    action: null,
    capabilities: [],
    capabilityError: "Could not read what this build can prove",
    skills: [],
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
    onSaved: () => {},
    onDuplicate: () => {},
    onArchive: () => {},
  }));
  assert.match(html, /Until this daemon answers, no completion can be selected/);
  assert.match(html, /role="alert"/);
});

test("the library never speaks in a reviewer's vocabulary", () => {
  // The permanent negative, restated for the surface an operator authors on. A session action
  // has no model, returns no verdict and reviews nothing.
  const html = library([action()]) + editor(action());
  for (const word of [/\breviewer\b/i, /\bverdict\b/i, /changes requested/i, /\bpass\/fail\b/i]) {
    assert.doesNotMatch(html, word, `the actions library used ${word}`);
  }
});
