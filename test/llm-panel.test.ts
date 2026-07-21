import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LlmSettingsPanel } from "../src/web/components/LlmSettingsPanel.tsx";
import type { LlmState } from "../src/web/useLlm.ts";
import { LLM_JOB_IDS, LLM_JOB_SPECS } from "../src/shared/llm-jobs.ts";
import { LLM_RUNNER_ENV_VAR } from "../src/shared/llm.ts";
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

const CONFIG: LlmConfig = { runner: "", models: {} };

function status(over: Partial<LlmStatus> = {}): LlmStatus {
  return {
    runner: { id: "claude", source: "default", unknown: null },
    models: Object.fromEntries(
      LLM_JOB_IDS.map((job) => [
        job,
        { job, id: LLM_JOB_SPECS[job].fallback, source: "default" as const },
      ]),
    ) as LlmStatus["models"],
    runners: [{ id: "claude", label: "Claude Code" }],
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

function render(over: Partial<LlmState> = {}): string {
  const state: LlmState = {
    config: CONFIG,
    status: status(),
    update: async () => {},
    error: null,
    ...over,
  };
  return renderToStaticMarkup(createElement(LlmSettingsPanel, { state }));
}

test("every background job gets a field, labelled and explained", () => {
  const html = decoded(render());
  for (const job of LLM_JOB_IDS) {
    assert.ok(html.includes(LLM_JOB_SPECS[job].label), `no field for ${job}`);
    assert.ok(html.includes(LLM_JOB_SPECS[job].blurb), `${job} is unexplained`);
  }
});

test("an empty box advertises the model the daemon RESOLVED, not the shipped fallback", () => {
  // The placeholder is the resolved id on purpose: an empty box under a set env var must not
  // advertise a default that env var is overriding.
  const html = render({
    status: status({
      models: {
        ...status().models,
        goal: { job: "goal", id: "claude-opus-4-8", source: "env" },
      },
    }),
  });
  assert.match(html, /placeholder="claude-opus-4-8"/);
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
    config: { runner: "", models: { goal: "claude-sonnet-5" } },
    status: status({
      models: {
        ...status().models,
        goal: { job: "goal", id: "claude-sonnet-5", source: "config" },
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
  assert.equal(radios.length, 1, "one row per provider the build has");
  assert.ok(radios[0]!.includes("checked"), "the resolved provider is the checked one");
  assert.ok(html.includes("Claude Code"));
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
  const inputs = html.match(/<input[^>]*>/g) ?? [];
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every((i) => i.includes("disabled")));
});

test("the panel says where the models it does NOT edit live", () => {
  // Foreman's four and the Inspector's one are edited by the panels that own their blobs. A
  // "Models" category that quietly omitted them would read as "these are all of them".
  const html = render();
  assert.ok(html.includes("Foreman"));
  assert.ok(html.includes("Inspector"));
});

test("a refused edit is reported where it was made", () => {
  assert.match(render({ error: "nope" }), /nope/);
});
