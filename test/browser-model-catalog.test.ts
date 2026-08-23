import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelChoiceSpec } from "../src/shared/model-choice.ts";
import {
  DEFAULT_HARNESSES_SESSION_RUNTIMES,
  emptyTaskKindDefaults,
  type HarnessModelCatalogChoice,
  type HarnessModelCatalogs,
  type HarnessesConfig,
} from "../src/shared/protocol.ts";
import { AGENT_TYPES, type AgentType, type ThinkingLevel } from "../src/shared/types.ts";
import {
  defaultModelOptionLabel,
  harnessDefaultsLine,
} from "../src/web/components/DispatchModal.tsx";
import { HarnessesPanel } from "../src/web/components/HarnessesPanel.tsx";
import { ModelField } from "../src/web/components/ModelField.tsx";
import { ScheduleEditor } from "../src/web/components/schedules/ScheduleEditor.tsx";
import {
  BrowserModelCatalogStore,
  ModelCatalogNotice,
  ModelCatalogOptions,
  ModelCatalogProvider,
  modelCatalogNoticeContent,
  resolveHarnessModelCatalog,
  shippedModelCatalogs,
  type BrowserModelCatalogSnapshot,
  type ResolveHarnessModelCatalog,
} from "../src/web/model-catalog.tsx";
import { mkSchedule, mkScheduleTemplate } from "./helpers/schedule-fixture.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function choice(
  id: string,
  provider: string | null,
  label = id,
): HarnessModelCatalogChoice {
  return {
    id,
    label,
    hint: null,
    provider,
    contextWindow: null,
    reasoning: null,
    inputModes: [],
  };
}

const LIVE_CHOICES = [
  choice("openai/gpt-5.6-sol", "openai", "GPT-5.6 Sol"),
  choice("anthropic/claude-sonnet-5", "anthropic", "Claude Sonnet 5"),
  choice("openai/gpt-5.6-luna", "openai", "GPT-5.6 Luna"),
  choice("openrouter/meta-llama/llama-4-maverick", "openrouter", "Llama 4 Maverick"),
] as const;

function catalogs(
  piChoices: readonly HarnessModelCatalogChoice[] = LIVE_CHOICES,
  source: HarnessModelCatalogs["pi"]["source"] = "live",
  problem: HarnessModelCatalogs["pi"]["problem"] = null,
): HarnessModelCatalogs {
  return {
    ...shippedModelCatalogs(),
    pi: {
      choices: [...piChoices],
      source,
      refreshedAt: "2026-08-18T15:00:00.000Z",
      problem,
    },
  };
}

function snapshot(
  current = catalogs(),
  phase: BrowserModelCatalogSnapshot["phase"] = "ready",
  pending = false,
): BrowserModelCatalogSnapshot {
  return { catalogs: current, phase, pending };
}

function storeAt(initial: BrowserModelCatalogSnapshot): BrowserModelCatalogStore {
  return new BrowserModelCatalogStore(async () => initial.catalogs, initial);
}

function resolverFor(current: HarnessModelCatalogs): ResolveHarnessModelCatalog {
  return (agent, selected) => resolveHarnessModelCatalog(current[agent], selected);
}

function fullRecord<T>(value: T): Record<AgentType, T> {
  return Object.fromEntries(AGENT_TYPES.map((agent) => [agent, value])) as Record<AgentType, T>;
}

test("the browser starts from shipped choices and atomically replaces every catalog", async () => {
  const live = catalogs();
  const calls: boolean[] = [];
  const store = new BrowserModelCatalogStore(async (refresh) => {
    calls.push(refresh);
    return live;
  });

  assert.equal(store.getSnapshot().phase, "loading");
  assert.equal(store.getSnapshot().pending, true);
  assert.deepEqual(store.getSnapshot().catalogs, shippedModelCatalogs());

  await store.start();
  assert.deepEqual(calls, [false]);
  assert.deepEqual(store.getSnapshot(), snapshot(live));
});

test("loading and discovery transport failures preserve the last usable choices", async () => {
  const shipped = shippedModelCatalogs();
  const initialFailure = new BrowserModelCatalogStore(async () => null);
  await initialFailure.start();
  assert.equal(initialFailure.getSnapshot().phase, "failed");
  assert.deepEqual(initialFailure.getSnapshot().catalogs, shipped);

  const live = catalogs();
  const retryFailure = new BrowserModelCatalogStore(async () => null, snapshot(live));
  await retryFailure.retry();
  assert.equal(retryFailure.getSnapshot().phase, "failed");
  assert.deepEqual(retryFailure.getSnapshot().catalogs, live);
});

test("a forced retry wins even when the superseded initial transport ignores abort", async () => {
  const releases: Array<(value: HarnessModelCatalogs) => void> = [];
  const requests: boolean[] = [];
  const store = new BrowserModelCatalogStore(
    (refresh) =>
      new Promise<HarnessModelCatalogs>((resolve) => {
        requests.push(refresh);
        releases.push(resolve);
      }),
  );

  const initial = store.start();
  const retry = store.retry();
  assert.deepEqual(requests, [false, true]);

  const newest = catalogs([choice("anthropic/newest", "anthropic", "Newest")]);
  releases[1]!(newest);
  await retry;
  assert.deepEqual(store.getSnapshot().catalogs, newest);

  releases[0]!(catalogs([choice("openai/older", "openai", "Older")]));
  await initial;
  assert.deepEqual(store.getSnapshot().catalogs, newest);
});

test("provider groups keep first-seen provider order and Pi order within each group", () => {
  const resolved = resolveHarnessModelCatalog({
    choices: [
      LIVE_CHOICES[0],
      LIVE_CHOICES[1],
      LIVE_CHOICES[2],
      LIVE_CHOICES[0],
      LIVE_CHOICES[3],
    ],
    source: "live",
    refreshedAt: "2026-08-18T15:00:00.000Z",
    problem: null,
  });

  assert.deepEqual(resolved.groups.map((group) => group.provider), [
    "openai",
    "anthropic",
    "openrouter",
  ]);
  assert.deepEqual(resolved.groups[0]!.choices.map((item) => item.id), [
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-luna",
  ]);
  assert.equal(resolved.choices.length, 4, "the full provider-qualified id is deduplicated");
});

test("an absent current value is retained exactly once and never blocks a select", () => {
  const selected = "anthropic/operator-private-model";
  const retained = resolveHarnessModelCatalog(catalogs().pi, selected);
  assert.equal(retained.choices.filter((item) => item.id === selected).length, 1);
  assert.equal(retained.retained?.hint, "not currently reported");
  assert.deepEqual(retained.ungrouped.map((item) => item.id), [selected]);

  const alreadyPresent = resolveHarnessModelCatalog(catalogs().pi, LIVE_CHOICES[1].id);
  assert.equal(alreadyPresent.retained, null);
  assert.equal(
    alreadyPresent.choices.filter((item) => item.id === LIVE_CHOICES[1].id).length,
    1,
  );
});

test("native option groups mirror every provider while static catalogs stay flat", () => {
  const piHtml = renderToStaticMarkup(
    createElement("select", null, createElement(ModelCatalogOptions, {
      catalog: resolveHarnessModelCatalog(catalogs().pi),
    })),
  );
  assert.match(piHtml, /<optgroup label="openai">/);
  assert.match(piHtml, /<optgroup label="anthropic">/);
  assert.match(piHtml, /<optgroup label="openrouter">/);
  assert.equal((piHtml.match(/<option /g) ?? []).length, LIVE_CHOICES.length);

  const staticHtml = renderToStaticMarkup(
    createElement("select", null, createElement(ModelCatalogOptions, {
      catalog: resolveHarnessModelCatalog(catalogs().claude),
    })),
  );
  assert.doesNotMatch(staticHtml, /<optgroup/);
});

test("bounded degraded notices expose retry without leaking discovery output", () => {
  const stale = catalogs(LIVE_CHOICES, "cached", "timeout");
  const content = modelCatalogNoticeContent(snapshot(stale), "pi");
  assert.deepEqual(content, {
    message:
      "Showing the last known Pi model list because refresh failed. Pi model discovery timed out.",
    retry: true,
    tone: "degraded",
  });

  const failed = snapshot(catalogs(), "failed");
  const html = renderToStaticMarkup(
    createElement(
      ModelCatalogProvider,
      {
        store: storeAt(failed),
        children: createElement(ModelCatalogNotice, { agent: "pi" }),
      },
    ),
  );
  assert.match(html, /Showing the last known Pi model list/);
  assert.match(html, /Retry Pi models/);
  assert.doesNotMatch(html, /stderr|stack|argv/i);
});

test("settings and headless model fields consume the same live Pi snapshot", () => {
  const selected = "anthropic/operator-private-model";
  const config: HarnessesConfig = {
    autoModeOnDispatch: false,
    defaultModel: { ...fullRecord<string | null>(null), pi: selected },
    defaultEffort: fullRecord<ThinkingLevel | null>(null),
    sessionRuntime: DEFAULT_HARNESSES_SESSION_RUNTIMES,
    kindDefaults: emptyTaskKindDefaults(),
  };
  const spec: ModelChoiceSpec = {
    envVar: "MISSION_EXAMPLE_MODEL",
    fallback: "openai/gpt-5.6-sol",
    label: "Backlog model",
    blurb: "Runs one headless task.",
  };
  const sharedStore = storeAt(snapshot(catalogs()));
  const html = renderToStaticMarkup(
    createElement(
      ModelCatalogProvider,
      {
        store: sharedStore,
        children: createElement(
          "div",
          null,
          createElement(HarnessesPanel, {
            state: { config, update: async () => {}, error: null },
          }),
          createElement(ModelField, {
            id: "headless-pi-model",
            anchor: null,
            spec,
            value: selected,
            resolved: { id: selected, source: "config" },
            runner: "pi",
            disabled: false,
            onCommit: () => {},
          }),
        ),
      },
    ),
  );

  assert.ok((html.match(/value="anthropic\/claude-sonnet-5"/g) ?? []).length >= 2);
  assert.ok((html.match(new RegExp(`value="${selected}" selected`, "g")) ?? []).length >= 2);
  assert.match(html, /not currently reported/);
  assert.doesNotMatch(html, /headless-pi-model"[^>]*disabled/);
});

test("recurring dispatch retains and offers the same live provider-qualified Pi models", () => {
  const selected = LIVE_CHOICES[1].id;
  const html = renderToStaticMarkup(
    createElement(
      ModelCatalogProvider,
      {
        store: storeAt(snapshot(catalogs())),
        children: createElement(ScheduleEditor, {
          schedule: mkSchedule({
            template: mkScheduleTemplate({ agent: "pi", model: selected }),
          }),
          onSaved: () => {},
          onCancel: () => {},
        }),
      },
    ),
  );

  assert.match(html, /<optgroup label="anthropic">/);
  assert.match(html, new RegExp(`value="${selected}" selected`));
  assert.match(html, /openrouter\/meta-llama\/llama-4-maverick/);
});

test("dispatch summaries resolve labels from the same browser catalog", () => {
  const resolve = resolverFor(catalogs());
  const defaults: HarnessesConfig = {
    autoModeOnDispatch: false,
    defaultModel: { ...fullRecord<string | null>(null), pi: LIVE_CHOICES[1].id },
    defaultEffort: { ...fullRecord<ThinkingLevel | null>(null), pi: "high" },
    sessionRuntime: DEFAULT_HARNESSES_SESSION_RUNTIMES,
    kindDefaults: emptyTaskKindDefaults(),
  };

  assert.equal(
    defaultModelOptionLabel("pi", "ship", defaults, resolve),
    "Default - Claude Sonnet 5",
  );
  assert.equal(harnessDefaultsLine("pi", "ship", defaults, resolve), "Claude Sonnet 5 · high");
});

test("every web model picker is wired through the browser catalog module", () => {
  const consumers = [
    "src/web/components/DispatchModal.tsx",
    "src/web/components/HarnessesPanel.tsx",
    "src/web/components/ModelField.tsx",
    "src/web/components/schedules/ScheduleEditor.tsx",
    "src/web/ensembles/dispatch/EnsembleDispatch.tsx",
  ];
  for (const relative of consumers) {
    const source = readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /model-catalog\.tsx/, `${relative} bypasses the browser catalog`);
    assert.doesNotMatch(source, /modelChoicesFor|MODEL_CATALOG/, `${relative} reads a local catalog`);
  }
});
