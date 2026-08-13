import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommandLibrary,
  commandDraftFrom,
  commandDraftDirty,
  commandRepoOptions,
  commandRevisionLine,
  commandUpdateBody,
} from "../src/web/workflows/CommandLibrary.tsx";
import {
  emptyWorkflowCommandView,
  workflowCommandFact,
  workflowCommandStatusSentence,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_COMMAND_UNKNOWN,
} from "../src/shared/workflow.ts";
import type { WorkflowCommandView } from "../src/shared/workflow.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// What is at stake: this editor is the ONLY surface that writes the Global Command catalog,
// and every argv it stores is something the daemon will later execute with its own
// filesystem authority. Three properties carry that weight, and none of them is visible in a
// static render, so they are pinned as pure functions:
//
//   1. blank means null, never an empty argv - "no default" and "run nothing" are different;
//   2. one save replaces a slot's default AND its whole override list, so the two halves can
//      never be committed apart;
//   3. dirtiness is measured against the stored view, so the discard guard and the CAS
//      conflict banner are asking about a real difference rather than about whitespace.

const view = (over: Partial<WorkflowCommandView> = {}): WorkflowCommandView => ({
  ...emptyWorkflowCommandView("test", 1_000),
  ...over,
});

function markup(commands: WorkflowCommandView[], initialSlot: string | null = null): string {
  return renderToStaticMarkup(withOverlayHost(createElement(CommandLibrary, {
    commands,
    hasSnapshot: true,
    initialSlot,
    onDirtyChange: () => {},
  })));
}

test("the rail is the four built-in slots, in registry order, configured or not", () => {
  const html = markup([view({ defaultCommand: ["npm", "test"] })]);
  for (const slot of WORKFLOW_CHECK_SLOTS) {
    assert.ok(html.includes(`>${slot}</span>`), `${slot} is missing from the rail`);
  }
  // Four rows, and every one of them tagged built-in: there is no fifth slot to author, so
  // this surface offers no New, no duplicate and no archive.
  assert.equal(html.match(/class="wf-command-list-item/g)?.length, 4);
  assert.equal(html.match(/wf-command-list-tag">Built-in</g)?.length, 4);
  for (const absent of ["New", "Duplicate", "Archive"]) {
    assert.ok(
      !new RegExp(`>${absent}<`).test(html),
      `a fixed catalog must not offer ${absent}`,
    );
  }
});

test("the route's slot is what opens, and an unknown one falls back to the first", () => {
  const opened = markup(WORKFLOW_CHECK_SLOTS.map((slot) => view({ slot })), "lint");
  assert.match(opened, /<h3>lint<\/h3>/);
  // Not a blank pane: an id naming no slot opens the surface's own default, the same rule
  // the router applies on the way in.
  assert.match(markup([view()], "deploy"), /<h3>test<\/h3>/);
  assert.match(markup([view()], null), /<h3>test<\/h3>/);
});

test("the editor states, once, that saving executes nothing", () => {
  const html = markup([view()]);
  // The authoring/execution boundary, in the place an operator is about to type an argv.
  assert.match(html, /Saving stores an argv - it runs nothing/);
  assert.match(html, /commit-pinned checkout/);
  assert.match(html, /granted the Workflows cell in Trust/);
  // ONE note, not a warning banner around every control.
  assert.equal(html.match(/class="wf-command-note"/g)?.length, 1);
});

test("both fields are offered, with the default named as repository-neutral", () => {
  const html = markup([view()]);
  assert.match(html, /<h4>Default command<\/h4>/);
  assert.match(html, /<h4>Overrides<\/h4>/);
  assert.match(html, /Repository-neutral/);
  // The blank-is-fine sentence, said where the empty box is - an unconfigured slot passes
  // with a note rather than failing, and that has to read as a choice, not a gap.
  assert.match(html, /passes with a note instead of running/);
  assert.match(html, /No exceptions - every repository uses the default above/);
  // The sr-only labels reach their inputs by id: both boxes sit outside a wrapping label.
  assert.match(html, /<label class="sr-only" for="workflow-command-default">/);
  assert.match(html, /id="workflow-command-default"/);
  assert.match(html, /<label class="sr-only" for="workflow-command-override-path">/);
  assert.match(html, /<div class="combobox">/, "the repo box is the shared RepoCombobox");
});

test("a stored slot renders its default and every override, argv included", () => {
  const html = markup([view({
    defaultCommand: ["npm", "test"],
    overrides: [
      { repoRoot: "/src/mission-control", command: ["npm", "test", "--filter=a b"] },
      { repoRoot: "/src/mission-control/packages/web", command: ["pnpm", "test"] },
    ],
    revision: 4,
  })]);
  assert.match(html, /value="npm test"/);
  // Printed the way the parser reads it, so what is listed re-parses to what runs.
  assert.ok(html.includes("npm test &quot;--filter=a b&quot;"));
  // Enough path to tell a nested package override from the repository-wide one above it.
  assert.match(html, /wf-command-override-path">\/src\/mission-control<\//);
  assert.match(html, /wf-command-override-path">\/src\/mission-control\/packages\/web<\//);
  assert.equal(html.match(/wf-command-override-list"|<li>/g)?.length, 3);
  assert.match(html, /Revision 4/);
});

test("blank means no default, and one save carries a slot's whole state", () => {
  // The rule that makes "no machine-wide default" expressible at all. An empty argv would be
  // a command that runs nothing, which the route refuses and the runtime could not execute.
  const blank = commandUpdateBody({ defaultText: "   ", overrides: [] }, 3);
  assert.ok(blank.ok && blank.body.defaultCommand === null);
  assert.deepEqual(blank.ok && blank.body, {
    expectedRevision: 3,
    defaultCommand: null,
    overrides: [],
  });

  // Both halves, always, under the revision the draft was taken from: a partial save of a
  // slot is not expressible, so a default and its exceptions can never be stored apart.
  const whole = commandUpdateBody({
    defaultText: 'npm run test -- --grep "a b"',
    overrides: [
      { repoRoot: "/z", command: ["z"] },
      { repoRoot: "/a", command: ["a"] },
    ],
  }, 7);
  assert.ok(whole.ok);
  assert.deepEqual(whole.body.defaultCommand, ["npm", "run", "test", "--", "--grep", "a b"]);
  // Sorted the way the store returns them, so a saved draft looks identical to the row that
  // arrives back over SSE instead of visibly reordering itself on every save.
  assert.deepEqual(whole.body.overrides.map((entry) => entry.repoRoot), ["/a", "/z"]);

  // A line that does not parse is refused with the parser's own sentence rather than sent.
  const broken = commandUpdateBody({ defaultText: 'npm "unclosed', overrides: [] }, 1);
  assert.equal(broken.ok, false);
  assert.ok(!broken.ok && broken.error.length > 0);
});

test("dirtiness is measured against the stored slot, not against the text", () => {
  const stored = view({
    defaultCommand: ["npm", "test"],
    overrides: [{ repoRoot: "/a", command: ["a"] }],
  });
  const draft = commandDraftFrom(stored);
  assert.deepEqual(draft, {
    defaultText: "npm test",
    overrides: [{ repoRoot: "/a", command: ["a"] }],
  });
  assert.equal(commandDraftDirty(draft, stored), false);
  // Trailing whitespace re-parses to the same argv, so it is not a change an operator has to
  // answer a discard dialog about.
  assert.equal(commandDraftDirty({ ...draft, defaultText: "npm test  " }, stored), false);
  // A half-typed line cannot equal any stored argv, and saying so is what keeps the guard
  // from dropping work mid-keystroke.
  assert.equal(commandDraftDirty({ ...draft, defaultText: 'npm "unclosed' }, stored), true);
  assert.equal(commandDraftDirty({ ...draft, defaultText: "" }, stored), true);
  assert.equal(commandDraftDirty({ ...draft, defaultText: "npm run test" }, stored), true);
  assert.equal(commandDraftDirty({ ...draft, overrides: [] }, stored), true);
  assert.equal(
    commandDraftDirty({ ...draft, overrides: [{ repoRoot: "/a", command: ["b"] }] }, stored),
    true,
  );
  // Order is not a change: the draft sorts to the store's order before comparing.
  assert.equal(
    commandDraftDirty(
      {
        defaultText: "npm test",
        overrides: [{ repoRoot: "/b", command: ["b"] }, { repoRoot: "/a", command: ["a"] }],
      },
      view({
        defaultCommand: ["npm", "test"],
        overrides: [{ repoRoot: "/a", command: ["a"] }, { repoRoot: "/b", command: ["b"] }],
      }),
    ),
    false,
  );
  // A slot the snapshot has not delivered is dirty the moment anything is typed into it, and
  // clean while it is untouched.
  assert.equal(commandDraftDirty(commandDraftFrom(null), null), false);
  assert.equal(commandDraftDirty({ defaultText: "npm test", overrides: [] }, null), true);
});

test("the picker offers granted repositories first, then the workspace scan", () => {
  // `/outside` is granted from outside the workspace roots, so the scan never names it.
  // Dropping it would leave the one repository a Command can actually run in unofferable.
  assert.deepEqual(
    commandRepoOptions(["/ws/a", "/ws/b"], ["/outside", "/ws/b"]),
    ["/outside", "/ws/b", "/ws/a"],
  );
  // Listed once. A repository in both lists appears in its granted position, and a duplicate
  // would be two rows in the dropdown that select the same path.
  assert.deepEqual(commandRepoOptions(["/ws/a"], ["/ws/a"]), ["/ws/a"]);
  // Either side alone still answers, which is what the daemon being unreachable looks like.
  assert.deepEqual(commandRepoOptions([], ["/ws/a"]), ["/ws/a"]);
  assert.deepEqual(commandRepoOptions(["/ws/a"], []), ["/ws/a"]);
});

test("the revision line tells a never-configured slot from an edited one", () => {
  // A seeded slot opens at revision 1 with nothing stored, and "Revision 1" would read as a
  // save somebody made.
  assert.equal(commandRevisionLine(view()), "Never configured on this machine");
  assert.match(
    commandRevisionLine(view({ revision: 2, defaultCommand: ["npm", "test"] })),
    /^Revision 2 · updated /,
  );
  // Revision 1 with something stored is a legacy row the migration carried across, and it
  // has been configured whatever its revision says.
  assert.match(
    commandRevisionLine(view({ overrides: [{ repoRoot: "/a", command: ["a"] }] })),
    /^Revision 1 · updated /,
  );
  assert.equal(commandRevisionLine(null), "Waiting for the daemon");
});

// The two shared vocabularies, pinned here because three surfaces read them - the Library
// card, this editor's rail, and the workflow palette - and a fact that reads differently in
// three places is three answers to one question.
test("one catalog fact and one status sentence serve every surface", () => {
  assert.equal(workflowCommandFact(null, true), "Not configured");
  assert.equal(workflowCommandFact({ defaultCommand: [], overrides: [] }, true), "Not configured");
  assert.equal(
    workflowCommandFact({ defaultCommand: ["a"], overrides: [{ repoRoot: "/a", command: ["a"] }] }, true),
    "Global default · 1 override",
  );
  assert.equal(
    workflowCommandFact({
      defaultCommand: null,
      overrides: [{ repoRoot: "/a", command: ["a"] }, { repoRoot: "/b", command: ["b"] }],
    }, true),
    "2 overrides · no global default",
  );
  // The sentence states the SKIP rather than converting it into a validation error: a
  // portable workflow is meant to name a slot a machine may not configure.
  assert.match(workflowCommandStatusSentence(null, true), /skips and passes with a note/);
  assert.match(
    workflowCommandStatusSentence({ defaultCommand: null, overrides: [{ repoRoot: "/a", command: ["a"] }] }, true),
    /Everywhere else this Command skips and passes/,
  );
  assert.match(
    workflowCommandStatusSentence({ defaultCommand: ["a"], overrides: [] }, true),
    /runs wherever the workflow reaches it/,
  );
});

// Both helpers gate on the snapshot, and the gate is REQUIRED rather than defaulted. Every
// string they return is a claim about what this machine has stored, and an absent view means
// one of two very different things - nobody configured this slot, or the catalog has not
// arrived. Three surfaces read these (the shelf card, this editor's rail, the workflow
// palette), so the rule lives here rather than being re-derived at each of them.
test("neither helper claims durable state without the catalog to back it", () => {
  // The unloaded reading, and it is one wording rather than three.
  assert.equal(workflowCommandFact(null, false), WORKFLOW_COMMAND_UNKNOWN);
  assert.equal(workflowCommandFact(undefined, false), WORKFLOW_COMMAND_UNKNOWN);
  assert.equal(commandRevisionLine(null), WORKFLOW_COMMAND_UNKNOWN);
  assert.match(workflowCommandStatusSentence(null, false), new RegExp(WORKFLOW_COMMAND_UNKNOWN));

  // The palette's sentence matters MORE than the fact, because it does not merely describe
  // configuration - it promises what a run will do. "Skips and passes" read off a catalog
  // that has not arrived tells an operator their working gate is inert.
  assert.doesNotMatch(workflowCommandStatusSentence(null, false), /skips and passes/);
  assert.doesNotMatch(workflowCommandStatusSentence(undefined, false), /Nothing is configured/);

  // A view that HAS arrived is trusted whatever the flag says: the flag describes an absence,
  // and a slot the stream delivered is not absent.
  const configured = { defaultCommand: ["npm", "test"], overrides: [] };
  assert.equal(workflowCommandFact(configured, false), "Global default");
  assert.match(
    workflowCommandStatusSentence(configured, false),
    /runs wherever the workflow reaches it/,
  );

  // And with the catalog in hand, an absent view is the honest "nobody configured this".
  assert.equal(workflowCommandFact(null, true), "Not configured");
  assert.match(workflowCommandStatusSentence(null, true), /skips and passes with a note/);
});
