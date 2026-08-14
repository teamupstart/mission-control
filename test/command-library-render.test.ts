import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  argvPreview,
  argvReadout,
  CommandLibrary,
  commandSync,
  commandDraftFrom,
  overridesEmptyMessage,
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
  COMMAND_AUTHORIZATION_NOTE,
  parseCheckCommand,
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
    isOverlayOpen: () => false,
    onLeave: () => {},
    onDirtyChange: () => {},
  })));
}

test("the rail's first row is the way out, above its own heading", () => {
  // The reported dead end: opening this screen left no way back. Escape did nothing, and the
  // only control that navigated to `#/library` was the topbar chip already painted
  // `aria-current` - the page you are on, not the way out of it.
  //
  // Asserted as ORDER rather than presence. The row has to be first in reading order and
  // outside the scrolling list, or it is a control you have to already know about to find.
  const html = markup([view({ defaultCommand: ["npm", "test"] })]);
  const row = html.indexOf('aria-label="Back to Library"');
  assert.ok(row > 0, "no back row in the rail");
  assert.ok(row < html.indexOf('wf-command-sidebar-head'), "the back row must precede the rail heading");
  // The keystroke on the face, so Escape is taught rather than assumed.
  assert.match(html, /<kbd class="kb-hint">esc<\/kbd>/);
});

test("the rail is the four built-in slots, in registry order, configured or not", () => {
  const html = markup([view({ defaultCommand: ["npm", "test"] })]);
  for (const slot of WORKFLOW_CHECK_SLOTS) {
    assert.ok(html.includes(`>${slot}</span>`), `${slot} is missing from the rail`);
  }
  // Registry order, asserted as order rather than as presence: the four slots are a fixed
  // vocabulary and a rail that sorted them would be inventing a hierarchy they do not have.
  const at = WORKFLOW_CHECK_SLOTS.map((slot) => html.indexOf(`>${slot}</span>`));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  // Four rows, under ONE group head that says built-in once for all of them. The per-row
  // tag is gone with the flat list it apologised for - a rail whose every row carries the
  // same tag is a rail whose tag distinguishes nothing.
  assert.equal(html.match(/class="wf-command-list-item/g)?.length, 4);
  assert.match(html, /<h4 class="lib-rail-group"><span>Built-in slots<\/span>/);
  assert.match(html, /<span class="lib-rail-group-count">4<\/span>/);
  assert.equal(html.match(/lib-rail-tag/g)?.length, undefined);
  for (const absent of ["New", "Duplicate", "Archive"]) {
    assert.ok(
      !new RegExp(`>${absent}<`).test(html),
      `a fixed catalog must not offer ${absent}`,
    );
  }
});

test("each rail row carries the slot's stored state, through the shared fact", () => {
  // What tells four rows apart is which of them has exceptions, and that is one vocabulary
  // shared with the Library shelf card and the workflow palette rather than a second string
  // formatted here. The purpose sentence that used to sit on every row is identical on every
  // machine, so as a distinguishing fact it was worth nothing.
  const html = markup([
    view({ defaultCommand: ["npm", "test"], overrides: [{ repoRoot: "/a", command: ["a"] }] }),
    view({ slot: "lint" }),
  ]);
  assert.ok(html.includes(">Global default · 1 override</small>"));
  assert.ok(html.includes(">Not configured</small>"));
  // And the slot's purpose is still on the row - in the tooltip, where a sentence belongs.
  assert.ok(html.includes("The automated test suite this repository gates on."));
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
  // No more Default-command and Overrides headings: one table, one header row, and the two
  // things that used to be separately titled sections are rows of it.
  assert.doesNotMatch(html, /<h4>Default command<\/h4>/);
  assert.doesNotMatch(html, /<h4>Overrides<\/h4>/);
  assert.match(html, /<th scope="col">Scope<\/th><th scope="col">Command<\/th>/);
  assert.match(html, /default is repository-neutral/);
  // The blank-is-fine sentence, said where the empty box is - an unconfigured slot passes
  // with a note rather than failing, and that has to read as a choice, not a gap.
  assert.match(html, /passes with a note instead of running/);
  // The precedence, stated on the screen that draws it rather than left to be inferred.
  assert.match(html, /The longest matching path wins/);
  // The fixture has no default, so the empty row must say so rather than pointing at one.
  assert.match(html, /No exceptions, and no default - this Command resolves to nothing/);
  assert.doesNotMatch(html, /uses the default above/);
  // The sr-only labels reach their inputs by id: both boxes sit outside a wrapping label.
  assert.match(html, /<label class="sr-only" for="workflow-command-default">/);
  assert.match(html, /id="workflow-command-default"/);
  assert.match(html, /<label class="sr-only" for="workflow-command-override-path">/);
  assert.match(html, /<div class="combobox">/, "the repo box is the shared RepoCombobox");
});

test("the default is the first rule of the table, and says which rule it is", () => {
  // The fault this phase exists for: a default drawn as its own titled section above an
  // unrelated list, so the one structure an operator has to hold - these are rules, and they
  // are ordered - was the thing the layout denied.
  const html = markup([view({
    defaultCommand: ["npm", "test"],
    overrides: [{ repoRoot: "/src/app", command: ["pnpm", "test"] }],
  })]);
  const head = html.indexOf('<th scope="col">Scope</th>');
  const fallback = html.indexOf('class="wf-command-rule is-default"');
  const override = html.indexOf("wf-command-rule-path");
  const add = html.indexOf('class="wf-command-rule is-add"');
  assert.ok(head > 0 && fallback > head, "the default must sit under the table's header row");
  assert.ok(override > fallback, "the default is the FIRST rule, above every exception");
  assert.ok(add > override, "the add row is last");
  // Labelled as the rule it actually is, rather than as a section that happens to be above.
  assert.match(html, /<strong>Every repository<\/strong>/);
  assert.match(html, /the default, where no override matches/);
});

test("the add row is drawn as an add row, not as a third saved rule", () => {
  const html = markup([view({
    defaultCommand: ["npm", "test"],
    overrides: [
      { repoRoot: "/src/a", command: ["a"] },
      { repoRoot: "/src/b", command: ["b"] },
    ],
  })]);
  // Exactly one, and the two saved exceptions do not share its class - which is the whole
  // claim: two empty boxes used to sit in the same list as the saved rules and read as a
  // third override somebody had half-configured.
  assert.equal(html.match(/class="wf-command-rule is-add"/g)?.length, 1);
  assert.equal(html.match(/class="wf-command-rule"/g)?.length, 2);
  // Its own control, disabled until both halves are given, as before the table existed.
  assert.match(html, /<button class="btn" disabled="" [^>]*>Add override<\/button>/);
  assert.ok(
    html.indexOf('class="wf-command-rule is-add"') < html.indexOf(">Add override</button>"),
  );
});

test("the empty overrides row names which empty state it is in", () => {
  // Two states share one row, and only one of them has a default to point at. On a fresh
  // slot - the first thing a new operator sees - the other reading invents configuration.
  const withDefault = markup([view({ defaultCommand: ["npm", "test"] })]);
  assert.match(withDefault, /No exceptions - every repository resolves to the default above/);
  assert.doesNotMatch(withDefault, /no default/);

  const bare = markup([view()]);
  assert.match(bare, /No exceptions, and no default - this Command resolves to nothing/);
  assert.doesNotMatch(bare, /resolves to the default above/);
});

test("a half-typed default is not described as one a repository can use", () => {
  // `npm "unclosed` is non-blank and is not a default: it cannot be parsed, so it cannot be
  // saved, so there is nothing for any repository to fall back to. Keying the row on "is the
  // box non-empty" described it as active - the operator most likely to read this row is the
  // one mid-keystroke, and the argv preview directly above is already telling them it is
  // broken.
  const message = overridesEmptyMessage('npm "unclosed');
  assert.doesNotMatch(message, /resolves to the default above/);
  assert.doesNotMatch(message, /uses the default above/);
  assert.match(message, /not a command yet/);

  // The other two states are unchanged and still tell each other apart.
  assert.match(overridesEmptyMessage(""), /no default/);
  assert.match(overridesEmptyMessage("   "), /no default/);
  assert.match(overridesEmptyMessage("npm test"), /every repository resolves to the default/);
  // A line that only parses once it is finished flips as it becomes valid.
  assert.match(overridesEmptyMessage('npm run test -- --grep "a b"'), /resolves to the default/);
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
  assert.match(html, /wf-command-rule-path">\/src\/mission-control<\//);
  assert.match(html, /wf-command-rule-path">\/src\/mission-control\/packages\/web<\//);
  // Three rules and the add row: the default, two exceptions, and the way to write a third.
  assert.equal(html.match(/class="wf-command-rule[ "]/g)?.length, 4);
  assert.match(html, /Revision 4/);
});

test("every rule shows its parsed argv, not only the default", () => {
  // Where a quoting mistake becomes visible - and until this phase it was offered for one of
  // the three rules on screen, which is precisely the wrong one: the default is the line
  // being typed and read back, while the exceptions are the ones somebody wrote once and
  // never looked at again.
  const long = [
    "/opt/homebrew/bin/node",
    "-e",
    "const v = require('node:fs').readFileSync(process.argv[1], 'utf8')",
    "/var/folders/check marker.txt",
  ];
  const html = markup([view({
    defaultCommand: ["make", "test"],
    overrides: [
      { repoRoot: "/src/mission-control", command: ["npm", "test", "--filter=a b"] },
      { repoRoot: "/src/mission-control/packages/web", command: long },
    ],
  })]);
  const readouts = [...html.matchAll(/class="wf-command-preview">([^<]*)</g)].map((m) => m[1]);
  assert.equal(readouts.length, 3, "the default and both exceptions each carry one readout");
  assert.ok(readouts[0]?.startsWith("Runs as: 1. make   2. test"));
  // Numbered, so a quoted pair is visibly ONE argument rather than two.
  assert.ok(readouts[1]?.includes("3. --filter=a b"));
  // The long one is not truncated: an argv you cannot read to the end is an argv you cannot
  // check, and the mockup's own worked example is a four-argument `node -e`.
  assert.ok(readouts[2]?.includes("4. /var/folders/check marker.txt"), readouts[2]);
  // Every rule's readout uses one helper, so the numbering cannot drift between rows.
  assert.equal(argvReadout(["make", "test"]), "Runs as: 1. make   2. test");
});

test("a rule whose command cannot be split says so where its argv would be", () => {
  // Only a TYPED rule can fail to parse - a stored override is already argv - so this is the
  // default line mid-keystroke and the add row's command box, and both render the parser's
  // own sentence in place of the numbered split rather than a generic complaint.
  const broken = argvPreview('npm "unclosed');
  assert.doesNotMatch(broken, /Runs as:/);
  assert.ok(broken.length > 0);
  assert.equal(broken, (parseCheckCommand('npm "unclosed') as { error: string }).error);
  // The two states either side of it are unchanged: a finished line splits, and an empty one
  // is the honest "there is no machine-wide default" rather than an error.
  assert.equal(argvPreview('npm run test -- --grep "a b"'), argvReadout([
    "npm", "run", "test", "--", "--grep", "a b",
  ]));
  assert.match(argvPreview("   "), /Leave this empty for no machine-wide default/);
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
    /everywhere else this Command skips and passes/,
  );
  assert.match(
    workflowCommandStatusSentence({ defaultCommand: ["a"], overrides: [] }, true),
    /every repository resolves to it/,
  );
});

// The one thing a configured Command is NOT: guaranteed to run. Configuration decides which
// argv RESOLVES here; execution is owned by the machine-wide switch, the repository's Trust
// grant and the platform floor. Saying "so this runs wherever the workflow reaches it" told an
// operator a gate was active when a paused switch or a missing grant makes it pass silently -
// which the plan rules out in as many words.
test("no configured Command is described as guaranteed to run", () => {
  const configured = [
    { defaultCommand: ["npm", "test"], overrides: [] },
    { defaultCommand: ["npm", "test"], overrides: [{ repoRoot: "/a", command: ["a"] }] },
    { defaultCommand: null, overrides: [{ repoRoot: "/a", command: ["a"] }] },
  ];
  for (const view of configured) {
    const sentence = workflowCommandStatusSentence(view, true);
    assert.ok(
      sentence.includes(COMMAND_AUTHORIZATION_NOTE),
      `a configured Command must name the gates it still passes through: ${sentence}`,
    );
    assert.doesNotMatch(sentence, /\bruns wherever\b/);
    assert.doesNotMatch(sentence, /\bwill run\b/);
  }
  // The negative direction IS certain in both, so the unconfigured arm states it flatly and
  // does not carry the qualifier - nothing about authorization changes "there is no command".
  const nothing = workflowCommandStatusSentence({ defaultCommand: null, overrides: [] }, true);
  assert.match(nothing, /Nothing is configured, so this Command skips and passes with a note\./);
  assert.ok(!nothing.includes(COMMAND_AUTHORIZATION_NOTE));
});

// The synchronization decision, which is where every race between a compare-and-swap refusal
// and an SSE delivery is settled. Each case below is a way to lose an operator's typing or
// strand them in a retry loop, and none of them can be reached by rendering.
test("the stream is adopted only when it is newer than what the editor holds", () => {
  const at = (revision: number): WorkflowCommandView => view({ revision });
  const clean = { conflict: null, dirty: false };

  // Nothing to sync before the snapshot.
  assert.deepEqual(
    commandSync({ selected: null, baseline: null, ...clean }),
    { kind: "idle" },
  );
  // The first delivery, and every later one, on a clean draft.
  assert.deepEqual(
    commandSync({ selected: at(1), baseline: null, ...clean }),
    { kind: "adopt", view: at(1) },
  );
  assert.deepEqual(
    commandSync({ selected: at(3), baseline: at(2), ...clean }),
    { kind: "adopt", view: at(3) },
  );
  // The same revision is not news.
  assert.deepEqual(
    commandSync({ selected: at(2), baseline: at(2), ...clean }),
    { kind: "idle" },
  );
  // A stream sitting BEHIND the editor is never adopted. This is the state Load newer leaves:
  // the baseline is the refusal's view, which the stream has not delivered. Adopting it would
  // silently undo the adoption the operator just asked for.
  assert.deepEqual(
    commandSync({ selected: at(1), baseline: at(9), ...clean }),
    { kind: "idle" },
  );
  // A dirty draft is never overwritten - the newer view is held for the operator instead.
  assert.deepEqual(
    commandSync({ selected: at(3), baseline: at(2), conflict: null, dirty: true }),
    { kind: "conflict", view: at(3) },
  );
});

test("a refusal's conflict outlives a stream that has not caught up to it", () => {
  const at = (revision: number): WorkflowCommandView => view({ revision });

  // The 409 case: the server named r9, the stream still holds the r1 this draft was taken
  // from. That agreement says nothing about the refusal, so the conflict stands - including
  // once the operator undoes their edit and the draft goes clean, which is the move that used
  // to retire it and leave every retry refused with no way to load the newer revision.
  for (const dirty of [true, false]) {
    assert.deepEqual(
      commandSync({ selected: at(1), baseline: at(1), conflict: at(9), dirty }),
      { kind: "idle" },
      `a conflict at r9 must survive a stream at r1 (dirty=${dirty})`,
    );
  }
  // It is retired when the stream reaches the revision it named, and not before.
  assert.deepEqual(
    commandSync({ selected: at(9), baseline: at(9), conflict: at(9), dirty: false }),
    { kind: "resolved" },
  );
  assert.deepEqual(
    commandSync({ selected: at(10), baseline: at(10), conflict: at(9), dirty: false }),
    { kind: "resolved" },
  );
  // And a delivery that is newer than both keeps the conflict pointed at the newest committed
  // view: a refusal can name a revision two saves ahead of what the stream has managed to
  // deliver, and offering the older of the two would hand back a Load newer that still 409s.
  assert.deepEqual(
    commandSync({ selected: at(4), baseline: at(1), conflict: at(9), dirty: true }),
    { kind: "conflict", view: at(9) },
  );
  assert.deepEqual(
    commandSync({ selected: at(11), baseline: at(1), conflict: at(9), dirty: true }),
    { kind: "conflict", view: at(11) },
  );
});

// An override is keyed by PATH, not by repository: a monorepo puts two of them under one
// checkout. Counting paths and calling them repositories overstates how much of the fleet is
// configured, which is the number an operator reads to decide whether a workflow travels.
test("overrides are counted as overrides, never as repositories", () => {
  const monorepo = [
    { repoRoot: "/src/app/packages/web", command: ["pnpm", "-C", "packages/web", "test"] },
    { repoRoot: "/src/app/packages/api", command: ["pnpm", "-C", "packages/api", "test"] },
  ];
  const overridesOnly = workflowCommandStatusSentence(
    { defaultCommand: null, overrides: monorepo },
    true,
  );
  assert.doesNotMatch(overridesOnly, /2 repositories/);
  assert.match(overridesOnly, /2 overrides/);

  const withDefault = workflowCommandStatusSentence(
    { defaultCommand: ["npm", "test"], overrides: monorepo },
    true,
  );
  assert.doesNotMatch(withDefault, /2 repository exceptions/);
  assert.match(withDefault, /2 overrides/);

  // Singular still reads correctly, and the card fact was already right - both now use the
  // same noun, so the shelf and the palette cannot disagree about what the number counts.
  assert.match(
    workflowCommandStatusSentence({ defaultCommand: null, overrides: [monorepo[0]!] }, true),
    /1 override\b/,
  );
  assert.equal(
    workflowCommandFact({ defaultCommand: null, overrides: monorepo }, true),
    "2 overrides · no global default",
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
    /every repository resolves to it/,
  );

  // And with the catalog in hand, an absent view is the honest "nobody configured this".
  assert.equal(workflowCommandFact(null, true), "Not configured");
  assert.match(workflowCommandStatusSentence(null, true), /skips and passes with a note/);
});
