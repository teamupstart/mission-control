import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SESSION_ACTION_COMPLETION_CAPABILITIES,
  SESSION_ACTION_COMPLETION_KINDS,
  WORKFLOW_LIMITS,
} from "../src/shared/workflow.ts";
import type {
  SessionAction,
  SessionActionCompletionCapability,
} from "../src/shared/workflow.ts";
import { CreateSessionActionSchema } from "../src/shared/protocol.ts";
import {
  filterSessionActions,
  groupSessionActions,
  SessionActionLibrary,
} from "../src/web/workflows/SessionActionLibrary.tsx";
import { sessionActionContractLabel } from "../src/web/library/library-model.ts";
import { LibraryMenuList } from "../src/web/library/LibraryWorkspaceHeader.tsx";
import {
  completionChoices,
  isSessionActionSaveShortcut,
  reconcileSessionActionSave,
  SessionActionContractLine,
  SessionActionEditor,
  SessionActionEditorStatus,
  SessionActionSkillControl,
  sessionActionCapabilityBlock,
  sessionActionCompletionInherited,
  sessionActionCreateBody,
  sessionActionDraftProblem,
  sessionActionOverflowActions,
  sessionActionPatchFrom,
  sessionActionPromptPath,
  sessionActionSaveTarget,
  sessionActionSeed,
  sessionActionUpdatedLine,
  sessionActionUpdatePatch,
  type SessionActionDraftSeed,
} from "../src/web/workflows/SessionActionEditor.tsx";
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
    onLeave: () => {},
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

test("the rail's first row is the way out, above its own heading", () => {
  // The reported dead end: opening this screen left no way back. Escape did nothing, and the
  // only control that navigated to `#/library` was the topbar chip already painted
  // `aria-current` - the page you are on, not the way out of it.
  //
  // Asserted as ORDER rather than presence. The row has to be first in reading order and
  // outside the scrolling list, or it is a control you have to already know about to find.
  const html = library([]);
  const row = html.indexOf('aria-label="Back to Library"');
  assert.ok(row > 0, "no back row in the rail");
  assert.ok(row < html.indexOf('wf-action-sidebar-head'), "the back row must precede the rail heading");
  // The keystroke on the face, so Escape is taught rather than assumed.
  assert.match(html, /<kbd class="kb-hint">esc<\/kbd>/);
});

test("the Actions shelf is a real route, and the legacy tab hash still reaches it", () => {
  assert.deepEqual(parseMissionRoute("#/library/actions"), {
    page: "library",
    shelf: "actions",
  });
  // The word an operator sees on the shelf is the word in the URL, so a link copied out of
  // the address bar comes back to the same place.
  assert.equal(missionRouteHash({ page: "library", shelf: "actions" }), "#/library/actions");
  // And the hash this surface lived at for its whole life before the split still lands here,
  // rather than on the fleet.
  assert.deepEqual(parseMissionRoute("#/workflows/actions"), {
    page: "library",
    shelf: "actions",
  });
});

function groupHead(label: string, count: number): RegExp {
  return new RegExp(
    `<h4 class="lib-rail-group"><span>${label}</span><span class="lib-rail-group-count">${count}</span></h4>`,
  );
}

test("the rail separates what ships from what you wrote, and names each row by its contract", () => {
  const html = library([
    action(),
    action({ id: "b", name: "Pull Request", normalizedName: "pull request", builtin: true, requiredSkillId: "pull-request", completion: { kind: "pull_request" } }),
  ]);
  assert.match(html, /Tidy the workspace/);
  // The sub-label is the CONTRACT, from the one helper the Library card reads too. The
  // description sat here and, on the shipped pair, it is the title again in a longer
  // sentence - so two actions could not be told apart by the line meant to tell them apart.
  assert.match(
    html,
    /<small class="lib-rail-row-detail mono">No required skill · Session turn finishes<\/small>/,
  );
  assert.match(
    html,
    /<small class="lib-rail-row-detail mono">Skill · pull-request · Pull request is opened and verified<\/small>/,
  );
  assert.doesNotMatch(html, />Remove the scratch files</, "the description is not the sub-label");
  // Provenance is said once, at the head, for every row beneath it - rather than as a tag on
  // each row, which is the flat list apologising for being flat.
  assert.match(html, groupHead("Built-in", 1));
  assert.match(html, groupHead("Yours", 1));
  assert.doesNotMatch(html, /class="wf-action-list-tag/);
  // Not merely present: the shipped row is UNDER the head that claims it, and Built-in leads.
  const order = ["Built-in", "Pull Request", "Yours", "Tidy the workspace"].map((needle) => {
    const at = html.indexOf(needle);
    assert.ok(at > 0, `${needle} is missing from the rail`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the rail's groups are out of order");
  // 2 actions, one of them a built-in, both live.
  assert.match(html, /2 active/);
});

test("the contract label is one string, and grouping never re-decides which row wins", () => {
  assert.equal(
    sessionActionContractLabel(action()),
    "No required skill · Session turn finishes",
  );
  assert.equal(
    sessionActionContractLabel(action({ requiredSkillId: "pull-request" })),
    "Skill · pull-request · Session turn finishes",
  );

  // A built-in shadowed by a same-named action of the operator's resolves to theirs, and that
  // decision belongs to `sessionActionsForDisplay` - which has already made it by the time
  // these rows are split. The group a row lands in must not be a second opinion about it.
  const shipped = action({ id: "builtin:pull-request", builtin: true });
  assert.deepEqual(groupSessionActions([shipped, action()]), {
    builtin: [shipped],
    yours: [action()],
  });
  assert.deepEqual(groupSessionActions([]), { builtin: [], yours: [] });
});

test("an empty Yours group says what to do about it, and only where that is true", () => {
  const shipped = action({ id: "builtin:pull-request", builtin: true });
  const nothingYet = library([shipped]);
  assert.match(nothingYet, groupHead("Yours", 0));
  assert.match(nothingYet, /duplicate a built-in to see the shape/);

  // Not with the list empty, where the line below already says it in the right words for the
  // state, and not under a search, where it would be a claim about the catalog rather than
  // about the filter.
  assert.doesNotMatch(library([]), /duplicate a built-in to see the shape/);
  assert.match(library([]), /No session actions yet/);
});

test("the archived filter is a counted toggle under the list, not a select above it", () => {
  const html = library([action(), action({ id: "old", name: "Retired", normalizedName: "retired", archivedAt: 9 })]);
  // The count answers "is there anything in there?" without pressing it, which the
  // Active/Archived select it replaces could not.
  assert.match(html, /aria-pressed="false"[^>]*>Archived <span class="wf-action-archived-count mono">1<\/span>/);
  const list = html.indexOf('class="wf-action-list"');
  assert.ok(list > 0 && list < html.indexOf("wf-action-rail-foot"), "the footer must follow the list");
  assert.ok(
    html.indexOf('class="wf-action-search"') < list,
    "the search box is the last thing above the list",
  );
});

test("the header's dim line says when the open row was last written, and never for a built-in", () => {
  assert.equal(
    sessionActionUpdatedLine(action({ builtin: true })),
    null,
    "a shipped row has no publish instant to print, and the eyebrow already says it ships",
  );
  assert.equal(sessionActionUpdatedLine(null), null, "a draft has no history to state");
  assert.match(sessionActionUpdatedLine(action())!, /^Updated /);
  assert.match(editor(action()), /<p class="wf-action-updated">Updated /);
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

test("the contract is two chips and the sentence they form, not two selects in a field row", () => {
  const html = editor(action({ requiredSkillId: "pull-request" }));
  // The chips answer their own question while shut. `requires skill` draws solid because
  // this action asserts one; the byte count is a readout of the asset, not a setting on it.
  assert.match(html, /<span class="lib-chip-k">requires skill<\/span>/);
  assert.match(html, /<span class="lib-chip-k">completes when<\/span>/);
  assert.match(html, /<span class="lib-chip-v mono">pull-request<\/span>/);
  assert.match(html, /<span class="lib-chip-v">Session turn finishes<\/span>/);
  // The prompt's exact ceiling, still stated - as a property of the asset rather than as the
  // one file toolbar in the app that carried a byte count.
  const bytes = new TextEncoder().encode(action().promptMarkdown).byteLength;
  assert.match(
    html,
    new RegExp(`<span class="lib-chip-v mono">${bytes} / ${
      WORKFLOW_LIMITS.sessionActionPromptBytes.toLocaleString()
    }</span>`),
  );
  assert.doesNotMatch(html, /UTF-8 bytes<\/span>/);
  assert.match(html, /Revision 2/);
});

test("the contract line states the sentence the two chips form, in the shared words", () => {
  const html = editor(action({ requiredSkillId: "pull-request" }));
  // What the stage sends, what the session must have, and what Mission Control observes -
  // which is the thing this screen has never said. `<b>` carries the completion clause and it
  // is the shared string, letter for letter, so the chip and the sentence cannot disagree.
  assert.match(html, /The stage sends this instruction to the bound session/);
  assert.match(html, /must be able to invoke the <code>pull-request<\/code> skill/);
  assert.match(html, /<b>Session turn finishes<\/b>/);
  assert.match(html, /never because the session said so/);
  // And the "what happens next" sentence the note under the old selector carried.
  assert.match(html, /only the stages below this one read it/);

  // The clause is the SHARED one for every kind, not a two-armed test on the kind - which is
  // the shape `test/session-action-completion-copy.test.ts` scans this whole tree for. Here
  // it is checked by consequence: each kind prints its own capability label verbatim.
  for (const kind of SESSION_ACTION_COMPLETION_KINDS) {
    const line = renderToStaticMarkup(createElement(SessionActionContractLine, {
      requiredSkillId: null,
      completion: { kind },
    }));
    assert.match(line, new RegExp(`<b>${SESSION_ACTION_COMPLETION_CAPABILITIES[kind].label}</b>`));
    // An action requiring no skill says so rather than leaving the clause out, or the sentence
    // would read as though the requirement had been forgotten.
    assert.match(line, /whatever skills that session has loaded/);
  }
});

test("the chip and the contract line print ONE string, whatever the daemon calls it", () => {
  /*
   * The review finding this exists for. The chip read the matching capability's `label` off
   * the daemon's answer while the sentence beneath it called the shared helper - so a daemon
   * a version ahead, wording its own capability differently, put TWO contract strings for one
   * stored completion on one screen, with nothing to say which was the promise.
   *
   * The kinds are append-only and the wire carries a label, so this is a state a future
   * daemon can reach without anything here being edited. Both surfaces read the one owner.
   */
  const reworded: SessionActionCompletionCapability[] = [{
    kind: "session_turn",
    available: true,
    label: "The turn wraps up (a newer daemon's wording)",
    unavailableReason: null,
  }];
  const html = editor(action(), undefined, reworded);

  const shared = SESSION_ACTION_COMPLETION_CAPABILITIES.session_turn.label;
  assert.match(html, new RegExp(`<span class="lib-chip-v">${shared}</span>`));
  assert.match(html, new RegExp(`<b>${shared}</b>`));
  // Exactly one wording of the contract reaches the face of this screen.
  assert.doesNotMatch(html, /a newer daemon's wording/);

  // The picker is the one surface that still speaks the daemon's words, because it lists what
  // THAT daemon can prove rather than what this action promises. Asserted so the fix above is
  // read as "the contract has one owner" and not as "the capability label is ignored".
  const offered = completionChoices(reworded, "session_turn");
  assert.equal(offered[0]!.label, "The turn wraps up (a newer daemon's wording)");
});

test("an action already naming an unavailable adapter keeps it, marked, and says why", () => {
  const html = editor(action({ completion: { kind: "pull_request" } }));
  // Marked on the chip's FACE and readable while shut. It used to be a disabled option inside
  // a closed dropdown, so the one fact on this row that is waiting on somebody was the only
  // one an operator had to open a control to find.
  assert.match(html, /class="lib-chip is-overridden is-attention[^"]*"/);
  assert.match(html, /<span class="lib-chip-v">Pull request is opened and verified<\/span>/);
  assert.match(html, /<p class="lib-props-note">This build cannot verify a pull request yet\.<\/p>/);
  // And the contract line still states what this action names, rather than falling back to
  // something this build could prove - the action's own guarantee is not the build's to edit.
  assert.match(html, /<b>Pull request is opened and verified<\/b>/);

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

  // Once the read has finished, the note says which fact it is. An EMPTY list is "nothing
  // answered", not "the answer was no" - those lead an operator to different actions, so they
  // get different sentences.
  assert.equal(
    completionChoices([], "session_turn", false)[0]!.note,
    "This daemon has not said which completions it can prove yet.",
  );
  // Answered, and the answer is no: the daemon's own reason.
  assert.equal(
    completionChoices(CAPABILITIES, "pull_request", false)[0]!.note,
    "This build cannot verify a pull request yet.",
  );
});

test("a built-in and an archived action are read-only, and say which and why", () => {
  const builtin = editor(action({ builtin: true }));
  assert.match(builtin, /Built-in session action/);
  assert.match(builtin, /Duplicate it to make a copy you own and can edit/);
  assert.match(builtin, /<span class="lib-tag lib-tag-builtin">built-in<\/span>/);
  assert.doesNotMatch(builtin, /Archive/);

  const archived = editor(action({ archivedAt: 9 }));
  assert.match(archived, /is read-only and is no longer offered to new stages/);
  assert.match(archived, /Every published version keeps the instruction it was published with/);
});

test("one verb is promoted, and on a read-only action it is the one that does something", () => {
  // Save sat first in this header permanently greyed out on both shipped actions, which reads
  // as "the thing you want, unavailable" - when the thing you want was one control to its
  // right and perfectly available. There is no revision this editor could write, so it does
  // not offer one.
  const builtin = editor(action({ builtin: true }));
  assert.doesNotMatch(builtin, />Save<\/button>/);
  assert.match(builtin, />Duplicate to edit<\/button>/);
  assert.match(editor(action({ archivedAt: 9 })), />Duplicate to edit<\/button>/);
  assert.match(editor(action()), />Save<\/button>/);
});

test("everything the header does not promote is in the menu, and a read-only action has none", () => {
  const menu = (over: Partial<SessionAction> = {}): string[] => sessionActionOverflowActions({
    action: true,
    builtin: over.builtin === true,
    archived: over.archivedAt != null,
    onDuplicate: () => {},
    onArchive: () => {},
  }).map((entry) => entry.label);

  // Asserted about the ACTIONS rather than about the row they sit in: which verbs each state
  // offers is behaviour, and it survives a rearrangement of the header only if it is pinned
  // as data. A closed menu renders nothing, so markup could not say this at all.
  assert.deepEqual(menu(), ["Duplicate", "Archive"]);
  // Duplicate is the promoted verb on both read-only states, and offering it twice makes the
  // more prominent one the one nobody can find again later. Archive is a write neither takes.
  assert.deepEqual(menu({ builtin: true }), []);
  assert.deepEqual(menu({ archivedAt: 9 }), []);
  // A draft has no row to copy or retire yet.
  assert.deepEqual(
    sessionActionOverflowActions({
      action: false,
      builtin: false,
      archived: false,
      onDuplicate: () => {},
      onArchive: () => {},
    }),
    [],
  );

  // And the labels are unchanged from wherever each verb lived before: a menu is where they
  // are now, not what they are called.
  const rows = renderToStaticMarkup(createElement(LibraryMenuList, {
    actions: sessionActionOverflowActions({
      action: true,
      builtin: false,
      archived: false,
      onDuplicate: () => {},
      onArchive: () => {},
    }),
    onChoose: () => {},
  }));
  assert.match(rows, /role="menuitem"[^>]*>Duplicate</);
  assert.match(rows, /class="lib-menu-row is-danger"[^>]*>Archive</);
  assert.match(rows, /published versions keep their snapshot/);
});

test("a stored skill this build's catalog does not carry stays selectable, and is not accused", () => {
  // The control lives in a popover a static render cannot open, so the rule it carries would
  // otherwise have no test: an id the catalog no longer lists has to stay in the options, or
  // opening the action silently drops the requirement it was saved with.
  const control = (unlisted: boolean): string =>
    renderToStaticMarkup(createElement(SessionActionSkillControl, {
      skills: [{ id: "retro", name: "retro", description: "", category: "git", enforcement: "triggered" }],
      value: "pull-request",
      unlisted,
      disabled: false,
      onChange: () => {},
    }));
  assert.match(control(true), /<option value="pull-request" selected="">Unavailable: pull-request<\/option>/);
  assert.match(control(true), /<option value="">No required skill<\/option>/);
  assert.doesNotMatch(control(false), /Unavailable/);

  // The chip itself is never marked for it, and that is deliberate: the catalog is read once
  // over HTTP, so for the round trip before it lands EVERY stored skill looks unlisted. An
  // unread catalog is not a refusal - the same lesson the completion capability code learned.
  const html = editor(action({ requiredSkillId: "nothing-ships-this" }));
  assert.doesNotMatch(html, /class="lib-chip is-overridden is-attention/);
});

test("reapply is a three-way merge: my changes, onto the revision that now exists", () => {
  // The trap this exists to avoid is silent, and it is the one a first pass walked into.
  // An operator loaded r4 and changed the prompt; another tab saved r5 changing the
  // description. A "reapply" that wrote the whole draft - or that diffed against the row the
  // conflict reported - sends the description back to its r4 value, reverting a save the
  // banner was in the middle of reporting.
  const loaded = action({ revision: 4, description: "old blurb", promptMarkdown: "# Old\n" });
  const theirs = action({ revision: 5, description: "their newer blurb", promptMarkdown: "# Old\n" });
  const baseline = sessionActionSeed(loaded);
  const mine: SessionActionDraftSeed = { ...baseline, promptMarkdown: "# Mine\n" };

  const target = sessionActionSaveTarget({
    mode: "reapply",
    action: theirs,
    conflict: theirs,
    loadedRevision: 4,
    baseline,
  })!;
  assert.equal(target.kind, "update");
  assert.equal(target.kind === "update" ? target.expectedRevision : null, 5);
  // The SAME action - the whole difference from Duplicate, which is the only other way to
  // keep the draft and leaves every workflow pointing at the original.
  assert.equal(target.kind === "update" ? target.id : null, loaded.id);

  const patch = sessionActionPatchFrom(
    target.kind === "update" ? target.baseline : baseline,
    mine,
    target.kind === "update" ? target.expectedRevision : 4,
  );
  assert.deepEqual(Object.keys(patch).sort(), ["expectedRevision", "promptMarkdown"]);
  assert.equal(patch.expectedRevision, 5, "aimed at the revision that now exists");
  assert.equal(patch.promptMarkdown, "# Mine\n");
  assert.equal(
    patch.description,
    undefined,
    "a field the operator never touched is absent, so the other tab's value survives",
  );
});

test("the three conflict routes are three different writes", () => {
  const loaded = action({ revision: 4 });
  const theirs = action({ revision: 5 });
  const baseline = sessionActionSeed(loaded);

  // Save and Reapply differ in exactly one thing: which revision they expect to find.
  assert.deepEqual(
    sessionActionSaveTarget({ mode: "save", action: loaded, conflict: theirs, loadedRevision: 4, baseline }),
    { kind: "update", id: loaded.id, baseline, expectedRevision: 4 },
  );
  assert.deepEqual(
    sessionActionSaveTarget({ mode: "reapply", action: loaded, conflict: theirs, loadedRevision: 4, baseline }),
    { kind: "update", id: loaded.id, baseline, expectedRevision: 5 },
  );
  // Duplicate measures against nothing: it is a create, so the copy carries no revision.
  assert.deepEqual(
    sessionActionSaveTarget({ mode: "duplicate", action: loaded, conflict: theirs, loadedRevision: 4, baseline }),
    { kind: "create" },
  );
  // A brand-new action is a create however it is saved.
  assert.deepEqual(
    sessionActionSaveTarget({ mode: "save", action: null, conflict: null, loadedRevision: null, baseline }),
    { kind: "create" },
  );
  // And a gesture with nothing to act on is a no-op rather than an error: a Reapply with no
  // conflict is a button that should not have been reachable.
  assert.equal(
    sessionActionSaveTarget({ mode: "reapply", action: loaded, conflict: null, loadedRevision: 4, baseline }),
    null,
  );
});

test("the conflict effect reconciles against what is true NOW, not against its own render", () => {
  // A passive effect keeps the values of the render that scheduled it. A save landing while
  // an SSE upsert for that same write is in flight therefore leaves an effect holding the
  // pre-save revision: it wakes, decides the incoming row is newer, and raises a conflict
  // against a revision the save has already adopted - and every later run correctly finds
  // nothing new to report, so the banner never clears. Reproduced 5/5 in the browser before
  // the refs went in; pinned here because a `useEffect` closure is not renderable to markup.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "web", "workflows", "SessionActionEditor.tsx"),
    "utf8",
  );
  assert.match(
    source,
    /if \(!action \|\| action\.revision <= \(loadedRevisionRef\.current \?\? 0\)\) return;/,
    "the reconciling effect must read the accepted revision from the ref, and `<=` it",
  );
  assert.match(source, /if \(dirtyRef\.current\) \{/);
  // Both refs are written by wrappers, so no `setLoadedRevision`/`setDirty` call site can
  // update the state and leave the ref behind.
  assert.match(source, /loadedRevisionRef\.current = next;\s*\n\s*setLoadedRevisionState\(next\);/);
  assert.match(source, /dirtyRef\.current = next;\s*\n\s*setDirtyState\(next\);/);
  assert.doesNotMatch(
    source,
    /useState\(false\);\s*\n\s*const \[conflict/,
    "`dirty` must go through the wrapper, not a bare setter",
  );
});

test("the conflict banner preserves the draft and offers every way out", () => {
  const html = renderToStaticMarkup(createElement(SessionActionEditorStatus, {
    dirty: true,
    conflict: action({ revision: 7 }),
    archived: false,
    onReload: () => {},
    onReapply: () => {},
    onDuplicate: () => {},
  }));
  // The load-bearing sentence: nothing the operator typed has been touched.
  assert.match(html, /Your instruction has not been changed/);
  assert.match(html, /r7/, "the operator is told which revision is now current");
  assert.match(html, /Reload latest/);
  // The route the review found missing: keeping the draft WITHOUT making a different action.
  // Reload discards the edits and Duplicate keeps them somewhere else, so without this an
  // operator whose change belongs on the row a workflow already points at had no way there
  // except retyping it over a reload.
  assert.match(html, /Reapply my changes/);
  assert.match(html, /Write your edits onto revision 7, keeping this the same session action/);
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

test("a new action cannot be saved against a completion the daemon has not blessed", () => {
  // Inspector's finding. A brand-new draft defaults to `session_turn` and is perfectly well
  // formed, so a save gate that only asked `sessionActionDraftProblem` stayed OPEN while the
  // selector beside it said no completion could be selected - the surface contradicting
  // itself, and the daemon-capability boundary it exists to enforce quietly bypassed.
  const pick = (
    over: Partial<Parameters<typeof sessionActionCapabilityBlock>[0]> = {},
  ): string | null => sessionActionCapabilityBlock({
    completionKind: "session_turn",
    capabilities: CAPABILITIES,
    loading: false,
    inherited: false,
    ...over,
  });

  // The answer is in: `session_turn` is available, so a new action saves.
  assert.equal(pick(), null);
  // Still in flight. Unknown is not permission.
  assert.match(pick({ loading: true })!, /Waiting for this daemon to report/);
  // The read failed, so the catalog is empty - which means UNREAD, not "none available".
  assert.match(pick({ capabilities: [] })!, /has not reported which completions it can prove/);
  // Answered, and the answer is no. The daemon's own sentence is what the operator reads.
  assert.equal(
    pick({ completionKind: "pull_request" }),
    "This build cannot verify a pull request yet.",
  );

  // INHERITED writes are never blocked, and that is load-bearing rather than a loophole:
  // duplicating the shipped Pull Request action is SUPPOSED to carry its `pull_request`
  // adapter across, so an operator can customise the instruction without losing the PR
  // verification. Blocking it would break a documented behaviour to satisfy this check.
  assert.equal(pick({ completionKind: "pull_request", inherited: true }), null);
  assert.equal(pick({ capabilities: [], inherited: true }), null);
  assert.equal(pick({ loading: true, inherited: true }), null);
});

test("a completion is inherited when it was CARRIED, not merely when a row exists", () => {
  // The first pass asked `action !== null`, which looked like the whole question and was not:
  // Duplicate opens a NEW editor seeded from the source and holding no `action`, so a copy of
  // the shipped Pull Request action read as somebody freshly choosing `pull_request` and could
  // never be saved - killing the advertised "Duplicate it to make a copy you own" path.
  const carried = (
    over: Partial<Parameters<typeof sessionActionCompletionInherited>[0]> = {},
  ): boolean => sessionActionCompletionInherited({
    baselineInherited: true,
    baselineCompletionKind: "pull_request",
    completionKind: "pull_request",
    ...over,
  });

  // A duplicate of the built-in: no `action`, but the completion came from the source.
  assert.equal(carried(), true);
  // A loaded row, untouched.
  assert.equal(carried({ baselineCompletionKind: "session_turn", completionKind: "session_turn" }), true);
  // A blank New draft: `session_turn` is a default nobody picked, so it still has to prove
  // itself. This is the round-1 finding, and it stays fixed.
  assert.equal(carried({ baselineInherited: false, baselineCompletionKind: "session_turn", completionKind: "session_turn" }), false);
  // Changed away from what the draft started with: that IS a choice, however it began.
  assert.equal(carried({ completionKind: "session_turn" }), false);
});

test("a duplicate of an unavailable-adapter action can still be saved", () => {
  // The end-to-end consequence of the rule above, at the surface: the editor a Duplicate
  // opens offers Save even though `pull_request` is not available here.
  const duplicated: SessionActionDraftSeed = {
    name: "Pull Request copy",
    description: "",
    promptMarkdown: "# Pull Request\n",
    requiredSkillId: "pull-request",
    completionKind: "pull_request",
  };
  const render = (seedInherited: boolean): string =>
    renderToStaticMarkup(createElement(SessionActionEditor, {
      action: null,
      seed: duplicated,
      seedInherited,
      capabilities: CAPABILITIES,
      skills: [],
      isOverlayOpen: () => false,
      onDirtyChange: () => {},
      onSaved: () => {},
      onDuplicate: () => {},
      onArchive: () => {},
    }));

  assert.doesNotMatch(render(true), /<button class="btn" disabled=""[^>]*>Save<\/button>/);
  // And the control: the identical draft, if it had NOT been duplicated, is refused - so the
  // pass above is the inheritance and not a hole in the gate.
  assert.match(render(false), /<button class="btn" disabled=""[^>]*>Save<\/button>/);
});

test("the Save button is off, and says why, while the capability answer is unknown", () => {
  // A FILLED draft, because that is the state Inspector described: an empty form is already
  // refused for wanting a name, so the bypass only shows on a draft that is otherwise ready
  // to go. `sessionActionDraftProblem` still wins when both apply - an operator fixes their
  // own draft before the daemon's state is any of their business.
  const filled: SessionActionDraftSeed = {
    name: "Tidy the workspace",
    description: "",
    promptMarkdown: "# Tidy\n",
    requiredSkillId: null,
    completionKind: "session_turn",
  };
  const newEditor = (
    capabilities: SessionActionCompletionCapability[],
    capabilityError: string | null = null,
  ): string => renderToStaticMarkup(createElement(SessionActionEditor, {
    action: null,
    seed: filled,
    capabilities,
    ...(capabilityError ? { capabilityError } : {}),
    skills: [],
    isOverlayOpen: () => false,
    onDirtyChange: () => {},
    onSaved: () => {},
    onDuplicate: () => {},
    onArchive: () => {},
  }));

  const blocked = newEditor([], "Failed to fetch");
  assert.match(blocked, /<button class="btn" disabled=""[^>]*>Save<\/button>/);
  // The Save tooltip carries the refusal...
  assert.match(blocked, /has not reported which completions it can prove/);
  // ...and the two on-screen sentences say the same thing without accusing the build of a
  // limit it never reported, keeping the raw fetch message beside them as a detail rather
  // than pasting it onto the front of a sentence.
  assert.match(blocked, /has not said which completions it can prove, so a new session action/);
  assert.match(blocked, /<code>Failed to fetch<\/code>/);
  assert.match(blocked, /This daemon has not said which completions it can prove yet\./);
  assert.doesNotMatch(blocked, /This build cannot prove this completion/);

  // The control case that makes the negative mean something: with the answer in, the same
  // filled editor offers Save.
  const ready = newEditor(CAPABILITIES);
  assert.doesNotMatch(ready, /<button class="btn" disabled=""[^>]*>Save<\/button>/);
  assert.match(ready, /Save this session action as a new revision/);
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
  assert.match(html, /has not said which completions it can prove, so a new session action/);
  // The raw fetch message is kept BESIDE the sentence rather than pasted onto the front of
  // it, which produced "Failed to fetch Until this daemon answers, ..." on screen.
  assert.match(html, /<code>Could not read what this build can prove<\/code>/);
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
