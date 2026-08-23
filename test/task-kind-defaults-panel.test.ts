import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskKindDefaultsGroup, modelSurvivesAgentChange } from "../src/web/components/TaskKindDefaults.tsx";
import { HarnessesConfigSchema } from "../src/shared/protocol.ts";
import type { HarnessesConfig } from "../src/shared/protocol.ts";
import type { HarnessesState } from "../src/web/useHarnesses.ts";
import { HARNESS_LAUNCHED_TASK_KINDS, TASK_KIND_INFO } from "../src/shared/task.ts";
import { AGENT_IDENTITY } from "../src/shared/agent.ts";
import { TASK_KINDS } from "../src/shared/types.ts";
import type { ResolveHarnessModelCatalog } from "../src/web/model-catalog.tsx";

// The Task kinds grid, as MARKUP. What is at stake is not whether the values round-trip -
// `task-kind-defaults.test.ts` pins that - but whether the panel tells the truth about them:
//
//   - The asymmetry. The model and effort are read at LAUNCH and the agent is written at
//     CREATION, so a shelved task picks up a changed model and keeps the agent it was filed
//     with. An operator has no other way to find that out, and the wrong belief is expensive:
//     they change the agent, watch the backlog, and conclude the setting does not work.
//   - A disabled control with no reason on it, which reads as a bug rather than as a rule.
//   - `pipeline` acquiring a row, which would be a control that cannot reach the process it
//     names.

function decoded(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function config(over: Partial<HarnessesConfig> = {}): HarnessesConfig {
  return { ...HarnessesConfigSchema.parse({}), ...over };
}

function render(state: Partial<HarnessesState> = {}): string {
  return decoded(
    renderToStaticMarkup(
      createElement(TaskKindDefaultsGroup, {
        state: { config: config(), update: async () => {}, error: null, ...state },
      }),
    ),
  );
}

/**
 * The sentence a named control POINTS AT - `Tooltip` renders its label into a hidden
 * `tt-desc` span and aims the trigger's `aria-describedby` at it, so this is the description
 * a screen reader reads and the only place a control's explanation lives.
 */
function describedText(html: string, name: string): string {
  const id = /aria-describedby="([^"]+)"/.exec(select(html, name))?.[1];
  assert.ok(id, `"${name}" has no description to read`);
  const at = html.indexOf(`<span id="${id}"`);
  assert.ok(at > 0, `nothing renders the description "${name}" points at`);
  return html.slice(html.indexOf(">", at) + 1, html.indexOf("</span>", at));
}

/** One named `<select>`, opening tag to close, so its options can be asserted. */
function select(html: string, name: string): string {
  const at = html.indexOf(`aria-label="${name}"`);
  assert.ok(at > 0, `no control named "${name}"`);
  return html.slice(at, html.indexOf("</select>", at));
}

test("every kind this app launches gets a row, and pipeline does not", () => {
  const html = render();
  for (const kind of HARNESS_LAUNCHED_TASK_KINDS) {
    assert.ok(
      html.includes(`aria-label="Agent for ${TASK_KIND_INFO[kind].label} tasks"`),
      `no agent control for ${kind}`,
    );
    assert.ok(
      html.includes(`aria-label="Model for ${TASK_KIND_INFO[kind].label} tasks"`),
      `no model control for ${kind}`,
    );
    assert.ok(
      html.includes(`aria-label="Effort for ${TASK_KIND_INFO[kind].label} tasks"`),
      `no effort control for ${kind}`,
    );
  }
  const missing = TASK_KINDS.filter(
    (kind) => !(HARNESS_LAUNCHED_TASK_KINDS as readonly string[]).includes(kind),
  );
  assert.deepEqual(missing, ["pipeline"], "the guard below is about pipeline");
  assert.equal(
    html.includes(`aria-label="Agent for ${TASK_KIND_INFO.pipeline.label} tasks"`),
    false,
    "Conductor owns a pipeline task's downstream launch, so a row here could never reach it",
  );
  assert.match(html, /Conductor owns their downstream agent, model and effort/);
});

test("the panel states which half is read at launch and which is written at creation", () => {
  const html = render();
  assert.match(html, /read when a task launches/);
  assert.match(html, /reaches a task already waiting in the backlog/);
  assert.match(html, /written when a task is created/);
  assert.match(html, /reaches the next task filed/);
});

test("a row that inherits its agent has its Model cell disabled, and says why", () => {
  const html = render();
  const model = select(html, `Model for ${TASK_KIND_INFO.plan.label} tasks`);
  assert.match(model, /disabled/, "an inheriting row cannot pin a model");
  // The reason travels ON the control - `Tooltip` renders its label into a hidden portal the
  // trigger's `aria-describedby` points at, which is what makes "this control says what it
  // does" checkable here and reachable by a keyboard user in the browser. A disabled control
  // with no reason reads as a bug, and this rule is not guessable.
  assert.match(
    describedText(html, `Model for ${TASK_KIND_INFO.plan.label} tasks`),
    /a model belongs to one harness/,
  );
  // ...and THAT row's reason goes away once it names a harness, rather than every row keeping
  // an explanation for a state it is no longer in.
  const chosen = render({
    config: config({
      kindDefaults: { ...config().kindDefaults, plan: { agent: "codex", model: null, effort: null } },
    }),
  });
  assert.doesNotMatch(
    describedText(chosen, `Model for ${TASK_KIND_INFO.plan.label} tasks`),
    /a model belongs to one harness/,
  );
  // The neighbours still carry it - they are still inheriting.
  assert.match(
    describedText(chosen, `Model for ${TASK_KIND_INFO.ship.label} tasks`),
    /a model belongs to one harness/,
  );
});

test("choosing an agent makes the Model cell available, narrowed to that harness", () => {
  const html = render({
    config: config({
      kindDefaults: { ...config().kindDefaults, plan: { agent: "codex", model: null, effort: null } },
    }),
  });
  const model = select(html, `Model for ${TASK_KIND_INFO.plan.label} tasks`);
  assert.doesNotMatch(model, /disabled/);
});

test("an Inherit option names what it would actually give the row", () => {
  // The same honesty the sibling matrix keeps: an option reading only "Inherit" makes an
  // operator open another panel to find out what this row is running on.
  const html = render({
    config: config({ defaultModel: { claude: "claude-opus-4-8", codex: null, pi: null } }),
  });
  const model = select(html, `Model for ${TASK_KIND_INFO.ship.label} tasks`);
  assert.match(model, /Inherit - /);
  assert.ok(model.includes("claude-opus-4-8") || /Inherit - Claude/.test(model));
});

test("the inherited row sends the operator somewhere that can actually change each value", () => {
  // This row once said all three inherited values "come from Settings → Harnesses". Two of
  // them do. The agent does not: its fallback is a built-in constant, and no harness card can
  // supply one, because the question a harness card answers is which card to use. A reachable
  // page that cannot change the thing it is named for is worse than no pointer at all - the
  // operator goes, finds nothing, and concludes the row is broken.
  const html = render();
  const note = /settings-matrix-inherited-note">([^<]*(?:<[^>]+>[^<]*)*)<\/span>/.exec(html)?.[1] ?? "";
  assert.ok(note.length > 0, "the inherited row states nothing about where its values come from");
  const plain = note.replace(/<[^>]+>/g, "");
  assert.match(plain, /model and effort come from Settings . Harnesses/i);
  // The agent is named in the same breath, as something this panel owns rather than that page.
  assert.match(plain, /agent has no setting behind it/i);
  assert.match(plain, new RegExp(`${AGENT_IDENTITY.claude.label} is`));
});

test("with no answer from the daemon every control is disabled, not showing defaults as fact", () => {
  const html = render({ config: null });
  const controls = html.match(/<select[^>]*>/g) ?? [];
  assert.ok(controls.length > 0);
  assert.ok(controls.every((control) => control.includes("disabled")));
});

test("a model survives an agent change only when the new harness offers the same id", () => {
  // The task-kind transposition of the pinning rule: a model is pinned to an AGENT, so the
  // row's own Agent select is a statement about that row and its model has to follow.
  const resolve = ((agent: string) => ({
    choices: agent === "codex" ? [{ id: "gpt-5.6-sol" }] : [{ id: "claude-opus-4-8" }],
    groups: [],
    ungrouped: [],
    retained: null,
  })) as unknown as ResolveHarnessModelCatalog;
  assert.equal(modelSurvivesAgentChange("", "codex", resolve), true, "nothing to strand");
  assert.equal(modelSurvivesAgentChange("claude-opus-4-8", "claude", resolve), true);
  assert.equal(modelSurvivesAgentChange("claude-opus-4-8", "codex", resolve), false);
  assert.equal(
    modelSurvivesAgentChange("claude-opus-4-8", null, resolve),
    false,
    "going back to Inherit never survives - an inheriting row may hold no model at all",
  );
});
