import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskSettingsPanel } from "../src/web/components/TaskSettingsPanel.tsx";
import type { WorkflowSettingsState } from "../src/web/useWorkflowSettings.ts";
import type { SkillsState } from "../src/web/useSkills.ts";
import type { SkillsView } from "../src/shared/types.ts";
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowSummary } from "../src/shared/workflow.ts";

const REVIEW: WorkflowSummary = {
  id: "workflow-review",
  name: "Release review",
  description: "",
  draftRevision: 2,
  currentVersionId: "version-2",
  publishedVersion: 2,
  archivedAt: null,
  updatedAt: 1,
  errorCount: 0,
  warningCount: 0,
  nodeCount: 3,
  personaCount: 1,
  builtin: false,
};

function render(
  config: WorkflowSettingsState["config"],
  props: { foremanEnabled?: boolean; workflows?: WorkflowSummary[]; skills?: SkillsState } = {},
): string {
  const state: WorkflowSettingsState = {
    config,
    status: null,
    testEvidenceAudit: null,
    update: async () => true,
    error: null,
  };
  return renderToStaticMarkup(createElement(TaskSettingsPanel, { state, ...props }));
}

function skills(view: Partial<SkillsView> | null): SkillsState {
  return {
    view: view && {
      alwaysDraftPr: false,
      commitPlanHtml: false,
      planStorage: "repository",
      grillFirstKinds: [],
      enabled: true,
      skills: [{ id: "grill", name: "grill", description: "", category: "planning", enforcement: "triggered", enabled: true }],
      pending: 0,
      problems: [],
      ...view,
    },
    update: async () => {},
    error: null,
  };
}

function renderGrill(state: SkillsState): string {
  return render(DEFAULT_WORKFLOW_CONFIG, { skills: state });
}

/** One kind's After work row, as drawn: from its anchor to the next kind's row. */
function section(html: string, kind: string): string {
  const start = html.indexOf(`data-anchor="tasks/kind-${kind}"`);
  if (start === -1) return "";
  const next = html.indexOf('data-anchor="tasks/kind-', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

/** One card, by its anchor, up to the next card. */
function card(html: string, anchor: string): string {
  const start = html.indexOf(`data-anchor="${anchor}"`);
  if (start === -1) return "";
  const next = html.indexOf('<section class="sc-card"', start);
  return html.slice(start, next === -1 ? undefined : next);
}

/** The toggle chip for one kind's default, as drawn. */
function kindChip(html: string, kind: string): string {
  return html.match(new RegExp(`<button[^>]*aria-label="Grill me first for ${kind} tasks"[^>]*>`))?.[0] ?? "";
}

test("the Tasks panel offers one dispatch default per task kind", () => {
  const html = render(
    { ...DEFAULT_WORKFLOW_CONFIG, kindWorkflowDefaults: { bugfix: "workflow-review", scout: null } },
    { foremanEnabled: true, workflows: [REVIEW] },
  );
  assert.match(html, /data-anchor="tasks\/kinds"/);
  for (const kind of ["ship", "bugfix", "document", "plan", "scout", "chat"]) {
    const row = section(html, kind);
    assert.ok(row, `a row for ${kind}`);
    assert.match(row, new RegExp(`<span class="task-kind-setting-name" aria-hidden="true">${kind}</span>`));
    assert.match(row, new RegExp(`aria-label="Default after-work Workflow for ${kind} tasks"`), `${kind}'s select is on ${kind}'s row`);
    assert.ok(card(html, "tasks/kinds").includes(`data-anchor="tasks/kind-${kind}"`), `${kind}'s row is in the After work card`);
  }
  assert.equal(section(html, "pipeline"), "");
  assert.doesNotMatch(html, /for pipeline tasks/, "Conductor owns what runs after a pipeline");
  assert.match(html, /Release review · v2/);
  // A row with nothing stored says what it resolves to; the built-in catalog is not in this
  // fixture, so a built-in Workflow is named as unavailable and a None built-in as None.
  assert.match(html, /Built-in default \(unavailable Workflow\)/);
  assert.match(html, /Built-in default \(None\)/);
  // The selected option of each row is the stored choice.
  assert.match(html, /<option value="workflow-review" selected="">Release review · v2<\/option>/);
  assert.doesNotMatch(html, /Foreman is off/);
});

test("before the daemon answers, the rows are drawn disabled on their anchor", () => {
  const html = render(null);
  assert.match(html, /data-anchor="tasks\/kind-ship"/);
  assert.match(html, /Can&#x27;t reach the daemon/);
  assert.match(html, /<select[^>]*disabled=""[^>]*aria-label="Default after-work Workflow for ship tasks"/);
});

test("a default that arms a Workflow while Foreman is off says so", () => {
  const html = render(DEFAULT_WORKFLOW_CONFIG, { foremanEnabled: false, workflows: [REVIEW] });
  assert.match(html, /Foreman is off/);
});

test("Grill me first's defaults are one card of kind chips, all off, with an info tip", () => {
  const html = renderGrill(skills({}));
  const grill = card(html, "tasks/grill-first");
  assert.match(grill, /<h3 class="sc-card-title">Grill me first<\/h3>/);
  assert.match(grill, /<button type="button" class="info-tip" aria-label="About Grill me first"[^>]*>i<\/button>/);
  assert.match(grill, /role="group" aria-label="Kinds that start with Grill me first"/);
  for (const kind of ["ship", "bugfix", "document", "plan", "scout", "chat"]) {
    const chip = kindChip(grill, kind);
    assert.ok(chip, `${kind}'s chip is in the Grill me first card`);
    assert.match(chip, /aria-pressed="false"/, `${kind} starts off`);
    assert.doesNotMatch(chip, /disabled/);
    assert.equal(kindChip(section(html, kind), kind), "", `${kind}'s After work row holds no chip`);
  }
  assert.equal(kindChip(html, "pipeline"), "", "Conductor owns a pipeline's launch");
  assert.match(html, /runs the Library&#x27;s Grill action/);
  assert.doesNotMatch(html, /Can&#x27;t reach the daemon/);

  const chosen = renderGrill(skills({ grillFirstKinds: ["plan", "bugfix"] }));
  assert.match(kindChip(chosen, "plan"), /aria-pressed="true"/);
  assert.match(kindChip(chosen, "bugfix"), /aria-pressed="true"/);
  assert.match(kindChip(chosen, "ship"), /aria-pressed="false"/);
  assert.doesNotMatch(chosen, /The grill skill is off/);
});

test("a Grill me first default whose skill is off says the dispatch would be refused", () => {
  const grillOff = skills({
    grillFirstKinds: ["ship"],
    skills: [{ id: "grill", name: "grill", description: "", category: "planning", enforcement: "triggered", enabled: false }],
  });
  assert.match(renderGrill(grillOff), /The grill skill is off/);
  assert.match(renderGrill(skills({ grillFirstKinds: ["ship"], enabled: false })), /The grill skill is off/);
  // No kind on, nothing is refused, so nothing is said.
  assert.doesNotMatch(renderGrill({ ...grillOff, view: { ...grillOff.view!, grillFirstKinds: [] } }), /The grill skill is off/);
});

test("before the Skills config answers, the Grill me first chips are drawn disabled", () => {
  const html = renderGrill(skills(null));
  assert.match(html, /Can&#x27;t reach the daemon/);
  assert.match(kindChip(html, "plan"), /disabled=""/);
});
