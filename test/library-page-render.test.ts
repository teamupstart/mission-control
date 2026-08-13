import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MissionSchedule } from "../src/shared/schedules.ts";
import type {
  PersonaView,
  SessionAction,
  WorkflowCommandView,
  WorkflowSummary,
} from "../src/shared/workflow.ts";
import { emptyWorkflowCommandView } from "../src/shared/workflow.ts";
import { LibraryPage } from "../src/web/library/LibraryPage.tsx";
import {
  actionCards,
  commandCards,
  ensembleStrategyCards,
  missionsCrossLink,
  personaCards,
  workflowCards,
  workflowRunsCrossLink,
  LIBRARY_SHELF_COPY,
} from "../src/web/library/library-model.ts";

// What is at stake: the Library exists because nothing in the product ever said what a
// workflow, a Persona or an action was FOR. The shape that teaches it - question as the
// heading, noun demoted to an eyebrow, one sentence of why - is the feature, so it is
// asserted as markup rather than left to a mockup nobody runs.

const workflow = (overrides: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  id: "wf-1",
  name: "No-Mistakes Review",
  description: "Checks, four reviewers, then the Inspector gate.",
  draftRevision: 3,
  currentVersionId: "v8",
  publishedVersion: 8,
  archivedAt: null,
  updatedAt: 0,
  errorCount: 0,
  warningCount: 0,
  nodeCount: 7,
  personaCount: 4,
  builtin: true,
  ...overrides,
});

const persona = (overrides: Partial<PersonaView> = {}): PersonaView => ({
  id: "p-1",
  name: "Code Risk Reviewer",
  normalizedName: "code risk reviewer",
  description: "Hunts regressions and contract drift in the diff.",
  guidanceMarkdown: "# Code Risk Reviewer",
  runner: null,
  model: null,
  builtin: true,
  revision: 1,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  execution: {
    runner: { id: "claude", source: "default", unknown: null },
    model: { id: "sonnet", source: "default", unknown: null },
  },
  ...overrides,
} as PersonaView);

const action = (overrides: Partial<SessionAction> = {}): SessionAction => ({
  id: "a-1",
  name: "Pull Request",
  normalizedName: "pull request",
  description: "Open or update the PR for this branch.",
  promptMarkdown: "# Pull Request",
  requiredSkillId: "pull-request",
  completion: { kind: "pull_request" },
  builtin: true,
  revision: 1,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
} as SessionAction);

const schedule = (overrides: Partial<MissionSchedule> = {}): MissionSchedule => ({
  id: "s-1",
  name: "Dependency audit",
  enabled: true,
  archivedAt: null,
  expression: "0 8 * * MON",
  timezone: "UTC",
  overlapPolicy: "skip",
  missedPolicy: "skip",
  executionMode: "dispatch",
  runnerId: null,
  revision: 1,
  template: null,
  nextRunAt: null,
  lastOccurrence: null,
  unreadable: null,
  health: "healthy",
  healthReasons: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
} as MissionSchedule);

function page(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(LibraryPage, {
    workflowSummaries: [workflow()],
    personas: [persona()],
    sessionActions: [action()],
    schedules: [schedule()],
    onOpenAsset: () => {},
    onCreateAsset: () => {},
    onLaunchEnsemble: () => {},
    onOpenRuns: () => {},
    onOpenEnsembles: () => {},
    onOpenMissions: () => {},
    onOpenTaskSources: () => {},
    ...overrides,
  }));
}

test("every shelf is headed by the question it answers, with the noun as its eyebrow", () => {
  const html = page();
  const questions = [
    "What counts as done?",
    "Who does the reviewing?",
    "What can a run tell the session to do?",
    "Not sure of the best approach?",
    "Where does work come from?",
    "What does each standard gate run?",
  ];
  for (const question of questions) {
    // In an `h3`, which is what makes it the shelf's accessible name through the
    // `aria-labelledby` the section carries.
    assert.match(html, new RegExp(`<h3 id="lib-shelf-[a-z]+">${question.replace("?", "\\?")}</h3>`));
  }
  // The nouns are present, and demoted. A shelf that headed itself "Personas" would be the
  // silence this page was built to end.
  for (const noun of [
    "Workflows", "Personas", "Actions", "Ensembles", "Missions · Sources", "Commands",
  ]) {
    assert.match(html, new RegExp(`class="lib-shelf-eyebrow">${noun}<`));
  }
  // Six shelves, each a labelled region.
  assert.equal(html.match(/aria-labelledby="lib-shelf-/g)?.length, 6);
});

test("the page says out loud that nothing runs from it", () => {
  // The one sentence that keeps authoring and execution apart in an operator's head. If a
  // later phase puts live state on a shelf, this is the claim it breaks.
  //
  // "Nothing RUNS FROM HERE" since Commands were shelved here: a Command is an executable
  // argv, and the old phrasing would have read as a claim that the box an operator typed
  // `npm test` into is inert. Saving one still executes nothing; a workflow reaching its
  // slot, later, in a granted repository, is what runs it.
  assert.match(page(), /Nothing runs from here - live state stays on the runs and ensembles pages/);
});

test("cards carry durable facts, and a draft says so", () => {
  const html = page({
    workflowSummaries: [
      workflow(),
      workflow({ id: "wf-2", name: "Docs gate", builtin: false, publishedVersion: null, personaCount: 1 }),
      workflow({ id: "wf-3", name: "Broken", builtin: false, errorCount: 2 }),
    ],
  });
  assert.match(html, /v8 · 4 reviewers/);
  assert.match(html, /class="lib-tag lib-tag-builtin">built-in</);
  assert.match(html, /class="lib-tag lib-tag-attention">draft</);
  assert.match(html, /Never published · 1 reviewer/);
  // A validation error is a property of the DRAFT, which is why it belongs on an authoring
  // card at all - and it is toned so it reads as something to fix.
  assert.match(html, /class="lib-asset-fact is-warn">2 validation errors</);
});

test("an archived asset is off the shelf, not merely marked", () => {
  const html = page({
    personas: [persona(), persona({ id: "p-2", name: "Retired", normalizedName: "retired", archivedAt: 1 })],
    sessionActions: [action(), action({ id: "a-2", name: "Old action", normalizedName: "old action", archivedAt: 1 })],
  });
  assert.match(html, /Code Risk Reviewer/);
  assert.doesNotMatch(html, /Retired/);
  assert.doesNotMatch(html, /Old action/);
});

test("the Ensembles shelf offers launchers and no way to author one", () => {
  const html = page();
  for (const strategy of ensembleStrategyCards()) {
    assert.match(html, new RegExp(strategy.name));
  }
  assert.match(html, /Launch one →/);
  // Every authoring shelf has a "＋ New" card; this one must not, because there is nothing
  // to save - a strategy ships with the build, exactly as a Command slot does.
  assert.equal(
    html.match(/class="lib-asset lib-asset-new"/g)?.length,
    4,
    "one dashed card per authoring shelf, and none on Ensembles or Commands",
  );
  assert.doesNotMatch(html, /New ensemble/);
});

test("the Missions shelf links to task sources without claiming to own them", () => {
  const html = page();
  assert.match(html, /Dependency audit/);
  assert.match(html, /Task sources/);
  assert.match(html, /Configured in Settings →/);
});

test("shelf cross-links count what is live without rendering any of it", () => {
  assert.deepEqual(workflowRunsCrossLink([]), { label: "runs →", attention: false });
  assert.deepEqual(
    workflowRunsCrossLink([
      { status: "running" },
      { status: "completed" },
      { status: "failed" },
      { status: "waiting_for_session" },
    ] as never),
    { label: "2 running →", attention: false },
  );
  assert.deepEqual(missionsCrossLink([schedule()]), { label: "intake healthy →", attention: false });
  assert.deepEqual(
    missionsCrossLink([schedule({ health: "attention" })]),
    { label: "1 need attention →", attention: true },
  );
});

test("the card model sorts by name and never invents a description", () => {
  const cards = workflowCards([
    workflow({ id: "b", name: "Beta" }),
    workflow({ id: "a", name: "Alpha" }),
  ]);
  assert.deepEqual(cards.map((card) => card.name), ["Alpha", "Beta"]);
  assert.deepEqual(personaCards([persona({ description: "" })])[0]?.description, "");
  // The honest answer is rendered, not stored: a card model that filled in "No description"
  // would make an empty description indistinguishable from that literal text.
  assert.match(page({ personas: [persona({ description: "" })] }), /No description/);
  assert.equal(actionCards([action()])[0]?.fact, "Skill · pull-request · Pull request is opened and verified");
});

// A drifted source file is a DURABLE fact about the asset - it stays drifted until a human
// adopts it - so it belongs on a card tag rather than on the runs page with the live state.
test("a reviewer card is tagged when its imported source file has moved on", () => {
  const imported = persona({ id: "p-imported", name: "Reviewer", normalizedName: "reviewer", builtin: false });
  const untagged = personaCards([imported]);
  assert.deepEqual(untagged[0]?.tags, [], "no check has been made, so the card claims nothing");

  const tagged = personaCards([imported], new Map([["p-imported", "changed"]]));
  assert.deepEqual(tagged[0]?.tags, [{ label: "upstream changed", tone: "attention" }]);
  assert.deepEqual(
    personaCards([imported], new Map([["p-imported", "missing"]]))[0]?.tags,
    [{ label: "source missing", tone: "attention" }],
  );
  assert.deepEqual(personaCards([imported], new Map([["p-imported", "current"]]))[0]?.tags, []);

  // Beside the built-in tag rather than replacing it: the two say different things.
  assert.deepEqual(
    personaCards([persona({ id: "p-1" })], new Map([["p-1", "changed"]]))[0]?.tags,
    [{ label: "built-in", tone: "builtin" }, { label: "upstream changed", tone: "attention" }],
  );
  assert.match(
    page({ personas: [imported], personaUpstream: new Map([["p-imported", "changed"]]) }),
    /upstream changed/,
  );
});

// ---- Commands ----
//
// What is at stake: this shelf is the one place an operator can answer "what does `test` run
// on this machine, and where is that not true?" without choosing a repository first. Four
// cards, always, in registry order - and the fact on each is durable configuration, never
// anything a run is doing.

test("Commands is the sixth shelf, with one card per built-in slot and no New card", () => {
  const html = page();
  // Appended, not filed beside Workflows: the shelf strings are hash segments, so the
  // reading order is append-only.
  assert.deepEqual(
    LIBRARY_SHELF_COPY.map((shelf) => shelf.id),
    ["workflows", "personas", "actions", "ensembles", "missions", "commands"],
  );
  const cards = commandCards([]);
  assert.deepEqual(cards.map((card) => card.id), ["test", "lint", "typecheck", "build"]);
  // Every one is built-in and none of them is creatable, which is the difference between
  // this shelf and the three above it.
  assert.ok(cards.every((card) => card.tags.some((tag) => tag.label === "built-in")));
  assert.doesNotMatch(html, /New Command/);
  // And no cross-link: a Command has no runs of its own, and pointing all four at the
  // workflow run list would be a number this shelf did not measure.
  const shelf = /<section class="lib-shelf" aria-labelledby="lib-shelf-commands">(.*?)<\/section>/s
    .exec(html);
  assert.ok(shelf, "the Commands shelf should render");
  assert.doesNotMatch(shelf[1]!, /lib-shelf-live/);
});

test("a Command card states durable configuration, and nothing about a run", () => {
  const catalog = (over: Partial<WorkflowCommandView>): WorkflowCommandView => ({
    ...emptyWorkflowCommandView("test"),
    ...over,
  });
  // The four readings the shelf has to be able to tell apart.
  assert.equal(commandCards([catalog({})])[0]?.fact, "Not configured");
  assert.equal(
    commandCards([catalog({ defaultCommand: ["npm", "test"] })])[0]?.fact,
    "Global default",
  );
  assert.equal(
    commandCards([catalog({ overrides: [{ repoRoot: "/a", command: ["a"] }] })])[0]?.fact,
    "1 override · no global default",
  );
  assert.equal(
    commandCards([catalog({
      defaultCommand: ["npm", "test"],
      overrides: [{ repoRoot: "/a", command: ["a"] }, { repoRoot: "/b", command: ["b"] }],
    })])[0]?.fact,
    "Global default · 2 overrides",
  );
  // A slot the catalog has not answered for is still a card, reading as unconfigured rather
  // than vanishing - "unconfigured" and "not loaded" must not be the same missing tile.
  assert.deepEqual(
    commandCards([]).map((card) => card.fact),
    ["Not configured", "Not configured", "Not configured", "Not configured"],
  );
  // Rendered through the page, so the fact reaches the DOM rather than only the model.
  assert.match(
    page({ workflowCommands: [catalog({ defaultCommand: ["npm", "test"] })] }),
    /class="lib-asset-fact">Global default</,
  );
});
