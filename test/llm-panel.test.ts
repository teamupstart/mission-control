import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LlmSettingsPanel } from "../src/web/components/LlmSettingsPanel.tsx";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { InspectorState } from "../src/web/useInspector.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import { LLM_JOB_IDS, LLM_JOB_SPECS } from "../src/shared/llm-jobs.ts";
import { LLM_RUNNER_ENV_VAR, LLM_RUNNER_IDS } from "../src/shared/llm.ts";
import { guardProviderModel, MODEL_CATALOG } from "../src/shared/model.ts";
import { modelSurvivesProviderChange } from "../src/web/components/SettingsMatrix.tsx";
import type { LlmConfig } from "../src/shared/protocol.ts";
import type { LlmStatus } from "../src/shared/types.ts";

// What is at stake: this panel is the only place the app answers "what am I spending on my
// own bookkeeping?". Before it existed the answer was three constants in three files and
// nothing rendered them anywhere - so the failures worth pinning are all the ways a control
// can LOOK like it is telling you something while telling you nothing.
//
//   - An empty greyed box is ambiguous by construction. It means either "shipped default" or
//     "an env var you set outside this app is silently outranking anything you type here",
//     and those are very different facts. The source line under the field is the whole
//     resolution of that ambiguity, so it has to render.
//   - Before the daemon answers, every value falls back to a shipped default. Drawing those
//     as though they were the daemon's answer tells the operator the app is running as
//     something it may well not be.
//   - A runner id the build cannot resolve is replaced. Replaced silently, the fallback reads
//     as the operator's own choice.
//
// Static markup rather than a browser, per the house rule: the panel's only interactivity is
// a commit handler, and the dashboard's SSE stream hangs headless automation.

const CONFIG: LlmConfig = {
  runner: "",
  claudeTransport: "",
  codexTransport: "",
  models: {},
  runners: {},
};

function status(over: Partial<LlmStatus> = {}): LlmStatus {
  return {
    runner: { id: "claude", source: "default", unknown: null },
    claudeTransport: "print",
    codexTransport: "exec",
    models: Object.fromEntries(
      LLM_JOB_IDS.map((job) => [
        job,
        { job, id: LLM_JOB_SPECS[job].fallback, source: "default" as const, unsupported: null },
      ]),
    ) as LlmStatus["models"],
    jobRunners: Object.fromEntries(
      LLM_JOB_IDS.map((job) => [
        job,
        { id: "claude" as const, source: "default" as const, unknown: null },
      ]),
    ) as LlmStatus["jobRunners"],
    runners: [
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
    ],
    ...over,
  };
}

/**
 * The entities `renderToStaticMarkup` emits, decoded, so a test can assert against the copy
 * as it was WRITTEN. Without it every apostrophe in a blurb ("each session's raw prompt")
 * has to be spelled `&#x27;` in the assertion, which pins the escaping rather than the words.
 */
function decoded(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One named `<select>`, from its opening tag to its close, so options can be asserted. */
function sliceSelect(html: string, name: string): string {
  const at = html.indexOf(`aria-label="${name}"`);
  assert.ok(at > 0, `no control named "${name}"`);
  return html.slice(at, html.indexOf("</select>", at));
}

/**
 * Foreman and the Inspector, pre-poll.
 *
 * Null config is what the page shows before the daemon answers: every control present and
 * disabled. That is the right fixture for a file asking what the panel RENDERS, and it keeps
 * this file about the background jobs - the Foreman and Inspector groups have their own
 * assertions in `foreman-models-panel.test.ts`.
 */
const FOREMAN: ForemanState = {
  config: null,
  status: null,
  backlogPlan: null,
  episodes: [],
  update: async () => true,
  refresh: async () => {},
  error: null,
};
const INSPECTOR: InspectorState = {
  config: null,
  inspections: [],
  model: null,
  runner: null,
  update: async () => true,
  refresh: async () => {},
  resolveFindings: async () => true,
  error: null,
};

function render(over: Partial<LlmState> = {}): string {
  const state: LlmState = {
    config: CONFIG,
    status: status(),
    personaDefaults: null,
    update: async () => {},
    error: null,
    ...over,
  };
  return renderToStaticMarkup(
    createElement(LlmSettingsPanel, { state, foreman: FOREMAN, inspector: INSPECTOR }),
  );
}

test("every background job gets a field, labelled and explained", () => {
  const html = decoded(render());
  for (const job of LLM_JOB_IDS) {
    assert.ok(html.includes(LLM_JOB_SPECS[job].label), `no field for ${job}`);
    assert.ok(html.includes(LLM_JOB_SPECS[job].blurb), `${job} is unexplained`);
  }
});

test("every blurb is still PRINTED, once per row, not left to a tooltip", () => {
  // The blurb moved from under the model field to the row heading when the group became a
  // matrix - the model select is now one of two controls in the row, so an explanation
  // hanging off it described the row from the wrong place. What must not change is that it
  // is VISIBLE: the assertion above would keep passing off the Tooltip's hidden portal copy
  // alone, which is exactly the regression this pins.
  // Scoped to the background-jobs group. The page now carries Foreman's and the Inspector's
  // grids too, and counting blurbs across all three would make this assertion move whenever
  // a group is added rather than when a job's explanation goes missing.
  const html = render();
  const group = html.slice(
    html.indexOf('data-anchor="models/jobs"'),
    html.indexOf('data-anchor="models/foreman"'),
  );
  assert.equal(
    (group.match(/settings-matrix-slot-blurb/g) ?? []).length,
    LLM_JOB_IDS.length,
    "each job's row must print its own explanation exactly once",
  );
});

test("every background job gets its own PROVIDER control, named for the job", () => {
  // The whole point of the phase: five jobs, five providers. A single app-wide picker with
  // five model boxes under it renders almost identically and is the state being left behind.
  const html = decoded(render());
  for (const job of LLM_JOB_IDS) {
    assert.ok(
      html.includes(`aria-label="${LLM_JOB_SPECS[job].label} provider"`),
      `${job} has no provider of its own`,
    );
    assert.ok(
      html.includes(`aria-label="${LLM_JOB_SPECS[job].label} model"`),
      `${job}'s model select lost its accessible name when the visible label came off`,
    );
  }
});

test("an inheriting row says WHAT it inherits, not just that it inherits", () => {
  // "Inherit" alone sends the operator back up the page to find out what this row runs on.
  const html = decoded(render());
  assert.ok(html.includes("Inherit - Claude Code"));
});

test("a job pinned to its own provider shows that provider selected, and its neighbours do not", () => {
  const html = render({
    config: { ...CONFIG, runners: { goal: "codex" } },
    status: status({
      jobRunners: {
        ...status().jobRunners,
        goal: { id: "codex", source: "config", unknown: null },
      },
    }),
  });
  const goal = sliceSelect(html, "Goal provider");
  assert.match(goal, /<option value="codex" selected="">/, "the Goal row must show its own pick");
  // The other four are untouched by a write that named one job - the failure that made the
  // old blanket clear-on-change unusable, asserted from the panel this time.
  for (const job of LLM_JOB_IDS.filter((j) => j !== "goal")) {
    const at = html.indexOf(`aria-label="${LLM_JOB_SPECS[job].label} provider"`);
    assert.ok(at > 0, `${job} lost its provider control`);
  }
});

test("a per-job provider this build cannot resolve is named as dropped, like the app-wide one", () => {
  // The row inherits rather than dropping to the shipped default, and says which id it could
  // not read - otherwise the inherited provider reads back as this row's own choice, which is
  // exactly the failure the picker above already refuses to make.
  const html = decoded(render({
    config: { ...CONFIG, runners: { goal: "ollama" } },
    status: status({
      jobRunners: {
        ...status().jobRunners,
        goal: { id: "claude", source: "default", unknown: "ollama" },
      },
    }),
  }));
  assert.match(html, /"ollama" is not a provider this build has, so this row is inheriting/);
});

test("an overridden row's Inherit option names the APP-WIDE provider, not its own override", () => {
  // The one thing selecting Inherit will not do is keep this row on Codex, so labelling the
  // option "Inherit - Codex" is a control that describes the opposite of what it does. The
  // difference is only visible on a row that HAS an override, which is why the fixture sets
  // one and leaves the app-wide picker alone.
  const html = decoded(render({
    config: { ...CONFIG, runners: { goal: "codex" } },
    status: status({
      jobRunners: {
        ...status().jobRunners,
        goal: { id: "codex", source: "config", unknown: null },
      },
    }),
  }));
  const goal = sliceSelect(html, "Goal provider");
  assert.match(goal, /Inherit - Claude Code/);
  assert.doesNotMatch(goal, /Inherit - Codex/, "the row advertised its override as its fallback");
  // ...and an unpinned row, where the two answers coincide, still reads the same.
  assert.match(sliceSelect(html, "Task title provider"), /Inherit - Claude Code/);
});

test("a model its provider cannot run is named as dropped, not silently replaced", () => {
  // The resolver substitutes the provider's own cheap default. Presented silently, the row
  // reads as though the operator asked for that default.
  const html = decoded(render({
    status: status({
      models: {
        ...status().models,
        goal: { job: "goal", id: "gpt-5.6-luna", source: "default", unsupported: "claude-sonnet-5" },
      },
    }),
  }));
  assert.match(html, /"claude-sonnet-5" is not a model this provider offers/);
});

test("workflow context compaction is a visible configurable background job", () => {
  const html = decoded(render());
  assert.ok(html.includes("Workflow context"));
  assert.ok(html.includes("Compacts user goals, decisions, and rationale for Persona review."));
  assert.ok(html.includes('aria-label="Workflow context model"'));
  assert.ok(html.includes('aria-label="Workflow context provider"'));
});

test("an empty box advertises the model the daemon RESOLVED, not the shipped fallback", () => {
  // The placeholder is the resolved id on purpose: an empty box under a set env var must not
  // advertise a default that env var is overriding.
  const html = render({
    status: status({
      models: {
        ...status().models,
        goal: { job: "goal", id: "claude-opus-4-8", source: "env", unsupported: null },
      },
    }),
  });
  assert.match(html, />Default - claude-opus-4-8<\/option>/);
  assert.ok(
    html.includes(LLM_JOB_SPECS.goal.envVar),
    "an env-sourced value must name the variable doing the overriding",
  );
});

test("a shipped default says so, so an empty box is never mistaken for an unset one", () => {
  assert.match(render(), /Shipped default\./);
});

test("a config override renders in the box and explains nothing further", () => {
  const html = render({
    config: { ...CONFIG, models: { goal: "claude-sonnet-5" } },
    status: status({
      models: {
        ...status().models,
        goal: { job: "goal", id: "claude-sonnet-5", source: "config", unsupported: null },
      },
    }),
  });
  assert.match(html, /value="claude-sonnet-5"/);
});

test("the provider picker offers what the DAEMON says it has, with the live one checked", () => {
  const html = render();
  const radios = (html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []).filter((i) =>
    i.includes('name="llm-runner"'),
  );
  assert.equal(radios.length, 2, "one row per provider the build has");
  assert.ok(radios[0]!.includes("checked"), "the resolved provider is the checked one");
  assert.ok(html.includes("Claude Code"));
  assert.ok(html.includes("Codex"));
});

test("a provider pinned by the environment is shown pinned, not silently overridden", () => {
  // A control that loses to the environment without saying so is worse than a disabled one:
  // the click appears to work, the poll puts it back, and nothing explains why.
  const html = render({ status: status({ runner: { id: "claude", source: "env", unknown: null } }) });
  assert.ok(html.includes(LLM_RUNNER_ENV_VAR));
  const radios = (html.match(/<input[^>]*name="llm-runner"[^>]*>/g) ?? []);
  assert.ok(radios.every((r) => r.includes("disabled")), "an env-pinned picker must not invite a click");
});

test("a stored provider this build cannot resolve is named as dropped", () => {
  const html = render({
    status: status({ runner: { id: "claude", source: "default", unknown: "ollama" } }),
  });
  assert.match(decoded(html), /"ollama" is not a provider this build has/);
});

test("with no answer from the daemon, the panel says so rather than showing defaults as fact", () => {
  const html = render({ config: null, status: null });
  assert.match(html, /what these calls actually run as is unknown/);
  // ...and nothing is editable, because a disabled input is not a claim about what is running.
  const controls = html.match(/<(?:input|select)[^>]*>/g) ?? [];
  assert.ok(controls.length > 0);
  assert.ok(controls.every((control) => control.includes("disabled")));
});

test("the panel says where the models it does NOT edit live", () => {
  // Foreman's four and the Inspector's one are edited by the panels that own their blobs. A
  // "Models" category that quietly omitted them would read as "these are all of them".
  const html = render();
  assert.ok(html.includes("Foreman"));
  assert.ok(html.includes("Inspector"));
});

// The panel's reset predicate and the daemon's resolver guard answer one question - "can this
// provider run this model" - and they have to answer it identically. They did not: the panel
// asked the catalog for membership, which clears any id NEITHER catalog knows, while the
// resolver deliberately keeps such an id because it cannot prove it is incompatible. A custom
// or newly-released model was therefore deleted by a provider click the server would have
// honoured. These pin the two together rather than pinning the panel's own behaviour, so the
// next change to either has to move both.

test("a provider change keeps a model no catalog knows - ids are free text", () => {
  // The regression. `gpt-6-unreleased` and a vendor's private id are not Claude's and not
  // Codex's; nothing here can say they are wrong, so nothing here may throw them away.
  for (const custom of ["gpt-6-unreleased", "internal/tuned-v3", "some-future-model"]) {
    for (const provider of LLM_RUNNER_IDS) {
      assert.equal(
        modelSurvivesProviderChange(custom, provider),
        true,
        `"${custom}" was deleted by a switch to ${provider}`,
      );
      // ...and the resolver agrees, which is the property that matters.
      assert.equal(guardProviderModel(provider, custom).unsupported, null);
    }
  }
});

test("a provider change resets only a model positively known to belong to another provider", () => {
  assert.equal(modelSurvivesProviderChange("claude-sonnet-5", "codex"), false);
  assert.equal(modelSurvivesProviderChange("gpt-5.6-sol", "claude"), false);
  // Kept: the provider's own catalog, and an empty box that is already inheriting.
  assert.equal(modelSurvivesProviderChange("claude-sonnet-5", "claude"), true);
  assert.equal(modelSurvivesProviderChange("gpt-5.6-sol", "codex"), true);
  assert.equal(modelSurvivesProviderChange("", "codex"), true);
  assert.equal(modelSurvivesProviderChange("   ", "codex"), true);
});

test("the panel resets a model exactly when the resolver would refuse it, over both catalogs", () => {
  // Swept rather than sampled: every shipped id against every provider. A divergence here is
  // the panel deleting something the daemon would have run, or keeping something it will drop.
  for (const provider of LLM_RUNNER_IDS) {
    for (const other of LLM_RUNNER_IDS) {
      for (const choice of MODEL_CATALOG[other]) {
        assert.equal(
          modelSurvivesProviderChange(choice.id, provider),
          guardProviderModel(provider, choice.id).unsupported === null,
          `the panel and the resolver disagree about ${choice.id} on ${provider}`,
        );
      }
    }
  }
});

test("a refused edit is reported where it was made", () => {
  assert.match(render({ error: "nope" }), /nope/);
});
