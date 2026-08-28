import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LlmSettingsPanel } from "../src/web/components/LlmSettingsPanel.tsx";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "../src/shared/foreman-models.ts";
import { INSPECTOR_MODEL_SPEC } from "../src/shared/inspector.ts";
import {
  ForemanConfigSchema,
  HarnessesConfigSchema,
  InspectorConfigSchema,
  LlmConfigSchema,
} from "../src/shared/protocol.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { InspectorState } from "../src/web/useInspector.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import type { ForemanStatus, LlmStatus } from "../src/shared/types.ts";

// What is at stake: Settings → Models now claims to answer "what is this app spending, and on
// whose account?" in one screen. That claim is only worth anything if the rows are actually
// here AND say the right thing about what each one inherits - which for Foreman is one rung
// deeper than anywhere else on the page. A row labelled "Inherit - Claude Code" under a
// Foreman group set to Codex would be a confident wrong answer to the one question the page
// exists for.
//
// The controls' behaviour (the ladder, the pinning, the guard) is pinned server-side in
// `foreman-role-providers.test.ts`. This file is about what an operator can SEE and reach.

const RUNNERS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;

function llmStatus(over: Partial<LlmStatus> = {}): LlmStatus {
  return {
    runner: { id: "claude", source: "default", unknown: null },
    claudeTransport: "sdk",
    codexTransport: "exec",
    models: {} as LlmStatus["models"],
    jobRunners: {} as LlmStatus["jobRunners"],
    runners: [...RUNNERS],
    ...over,
  };
}

function foremanStatus(over: Partial<ForemanStatus> = {}): ForemanStatus {
  return {
    enabled: true,
    mode: "dry-run",
    instructionsSource: "builtin",
    running: false,
    queueDepth: 0,
    counts: { answered: 0, escalated: 0, pending: 0, skipped: 0 },
    lastActionAt: null,
    autopilot: { on: false, active: 0, max: 3, ready: 0, blocked: 0, disabled: 0 },
    planner: {
      state: "healthy",
      runner: "claude",
      model: "claude-sonnet-5",
      failureCount: 0,
      lastError: null,
      nextRetryAt: null,
    },
    models: Object.fromEntries(
      FOREMAN_MODEL_ROLES.map((role) => [
        role,
        { role, id: FOREMAN_MODEL_SPECS[role].fallback, source: "default", unsupported: null },
      ]),
    ) as ForemanStatus["models"],
    runner: "claude",
    groupRunner: { id: "claude", source: "default", unknown: null },
    roleRunners: Object.fromEntries(
      FOREMAN_MODEL_ROLES.map((role) => [
        role,
        { id: "claude", source: "default", unknown: null },
      ]),
    ) as ForemanStatus["roleRunners"],
    ...over,
  };
}

function render({
  llm,
  foreman,
  inspector,
}: {
  llm?: Partial<LlmState>;
  foreman?: Partial<ForemanState>;
  inspector?: Partial<InspectorState>;
} = {}): string {
  const llmState: LlmState = {
    config: LlmConfigSchema.parse({}),
    status: llmStatus(),
    personaDefaults: null,
    update: async () => {},
    error: null,
    ...llm,
  };
  const foremanState: ForemanState = {
    config: null,
    status: foremanStatus(),
    backlogPlan: null,
    episodes: [],
    update: async () => true,
    refresh: async () => {},
    error: null,
    ...foreman,
  };
  const inspectorState: InspectorState = {
    config: InspectorConfigSchema.parse({}),
    inspections: [],
    model: null,
    runner: { id: "claude", source: "default", unknown: null },
    update: async () => true,
    refresh: async () => {},
    resolveFindings: async () => true,
    error: null,
    ...inspector,
  };
  return renderToStaticMarkup(
    createElement(LlmSettingsPanel, {
      state: llmState,
      // The task-kind grid is a different question on the same page; this file is about the
      // Foreman and Inspector groups, so it renders with defaults and is not asserted on.
      harnesses: { config: HarnessesConfigSchema.parse({}), update: async () => {}, error: null },
      foreman: foremanState,
      inspector: inspectorState,
    }),
  );
}

/** Entities back to characters, so a copy assertion reads as prose rather than as `&#x27;`. */
function decoded(html: string): string {
  return html
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

// ---- the page is the whole inventory ----------------------------------------------------

test("all three groups of app-owned model calls are on one page", () => {
  const html = render({ foreman: { config: null } });
  for (const anchor of ["models/jobs", "models/foreman", "models/inspector"]) {
    assert.match(html, new RegExp(`data-anchor="${anchor.replace("/", "\\/")}"`), `${anchor}`);
  }
  assert.doesNotMatch(html, /data-anchor="models\/provider"/);
});

test("every Foreman role gets a provider and a model control, named for the role", () => {
  const html = render({ foreman: { config: null } });
  for (const role of FOREMAN_MODEL_ROLES) {
    const spec = FOREMAN_MODEL_SPECS[role];
    assert.match(html, new RegExp(`id="foreman-${role}-provider"`), `${role} has no provider`);
    assert.match(html, new RegExp(`id="foreman-${role}-model"`), `${role} has no model`);
    // Named individually, because the row heading beside a control is a `<th>` a screen
    // reader announces separately and a Playwright spec cannot select on.
    // Scoped by group: the Inspector's row is also called "Review", and two controls sharing
    // an accessible name on one page is an operator who cannot tell which account moves.
    assert.match(
      html,
      new RegExp(`aria-label="Foreman ${spec.label} provider"`),
      `${role} is unnamed`,
    );
    assert.match(html, new RegExp(`aria-label="Foreman ${spec.label} model"`), `${role} model`);
    assert.ok(decoded(html).includes(spec.blurb), `${role} is unexplained`);
  }
});

test("Foreman's group-level provider leads its grid, and is a real editable setting", () => {
  const html = render({ foreman: { config: null } });
  assert.match(html, /id="foreman-provider"/);
  assert.match(html, /aria-label="Foreman provider"/);
  // Not drawn as an inherited readout row: it is what the four rows beneath it inherit FROM,
  // and an operator has to be able to change it.
  const grid = html.slice(html.indexOf('data-anchor="models/foreman"'));
  assert.doesNotMatch(grid.slice(0, grid.indexOf("</table>")), /settings-matrix-row is-inherited/);
});

test("the Inspector's one review row is here, under its own heading", () => {
  const html = decoded(render());
  assert.match(html, /id="inspector-provider"/);
  assert.match(html, /id="inspector-model"/);
  assert.match(html, /aria-label="Inspector Review provider"/);
  assert.match(html, /aria-label="Inspector Review model"/);
  assert.ok(html.includes(INSPECTOR_MODEL_SPEC.blurb));
  assert.match(html, /GitHub Inspector/);
});

// ---- what Inherit means, per group ------------------------------------------------------

test("a Foreman role's Inherit names FOREMAN's provider, not the app-wide one", () => {
  // The rung that is easy to get wrong, and the one this phase adds. A role inherits from
  // Foreman's All roles value; only that value inherits from the app-wide provider default.
  const html = render({
    llm: { status: llmStatus({ runner: { id: "claude", source: "config", unknown: null } }) },
    foreman: {
      config: null,
      status: foremanStatus({
        runner: "codex",
        groupRunner: { id: "codex", source: "config", unknown: null },
      }),
    },
  });
  const grid = html.slice(
    html.indexOf('data-anchor="models/foreman"'),
    html.indexOf('data-anchor="models/inspector"'),
  );
  const roleOptions = [...grid.matchAll(/<option value=""[^>]*>Inherit - ([^<]+)<\/option>/g)].map(
    (match) => match[1],
  );
  // Five rows: the All roles row, which inherits the APP-WIDE answer, then four roles that
  // inherit Foreman's.
  assert.deepEqual(roleOptions, ["Claude Code", "Codex", "Codex", "Codex", "Codex"]);
});

test("the Inspector's Inherit names the app-wide answer, because that is its next rung", () => {
  const html = render({
    llm: { status: llmStatus({ runner: { id: "codex", source: "env", unknown: null } }) },
  });
  const grid = html.slice(html.indexOf('data-anchor="models/inspector"'));
  assert.match(grid, /<option value=""[^>]*>Inherit - Codex<\/option>/);
});

// ---- what could not be honoured, said out loud -------------------------------------------

test("a Foreman role running a model its provider cannot offer says which id was dropped", () => {
  // The case the resolver guard exists for: an app-wide provider change moves a role's
  // effective provider with no Foreman write at all, so the saved pair goes mismatched and
  // only the row can explain the substitution.
  const html = decoded(render({
    foreman: {
      config: null,
      status: foremanStatus({
        models: {
          ...foremanStatus().models,
          review: {
            role: "review",
            id: "gpt-5.6-sol",
            source: "default",
            unsupported: "claude-opus-5",
          },
        },
      }),
    },
  }));
  assert.match(
    html,
    /"claude-opus-5" is not a model this provider offers/,
    "a silently substituted model reads as the operator's own choice",
  );
});

test("an unreadable GROUP provider is reported on the group row, and the row reads Inherit", () => {
  // The group row has no per-role note beneath it to fall back on, so if the status reduces
  // its answer to a bare id there is nowhere left to say which value was dropped - and the
  // inherited provider reads as Foreman's own choice. The select also cannot show a value it
  // has no option for, so it says what is IN FORCE and the note says what was refused.
  const html = decoded(render({
    llm: { status: llmStatus({ runner: { id: "codex", source: "config", unknown: null } }) },
    foreman: {
      config: { ...ForemanConfigSchema.parse({}), runner: "gemini" },
      status: foremanStatus({
        runner: "codex",
        groupRunner: { id: "codex", source: "config", unknown: "gemini" },
      }),
    },
  }));
  assert.match(html, /"gemini" is not a provider this build has/);
  const group = html.slice(html.indexOf('id="foreman-provider"'));
  assert.doesNotMatch(
    group.slice(0, group.indexOf("</select>")),
    /value="gemini"/,
    "a select cannot select an option it does not have",
  );
});

test("a stored Foreman provider this build cannot read is reported, not swallowed", () => {
  const html = decoded(render({
    foreman: {
      config: null,
      status: foremanStatus({
        roleRunners: {
          ...foremanStatus().roleRunners,
          triage: { id: "claude", source: "default", unknown: "gemini" },
        },
      }),
    },
  }));
  assert.match(html, /"gemini" is not a provider this build has/);
});

// ---- the page says what it does NOT cover -------------------------------------------------

test("the page names what is deliberately elsewhere rather than implying it is everything", () => {
  const html = decoded(render());
  assert.match(html, /Persona/, "an unbounded per-row model is not an app setting");
  assert.match(html, /dispatch choice/, "Foreman's backlog LAUNCH models are a different ladder");
  // And it no longer sends the operator away for the two groups it now holds.
  assert.doesNotMatch(html, /Foreman's four models are under/);
});
