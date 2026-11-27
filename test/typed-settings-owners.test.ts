import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { APP_CONFIG_ENTRIES, type AppConfigEntry } from "../src/shared/app-config-entries.ts";
import { SETTINGS_VALUE_MAX_BYTES, settingsFailure } from "../src/shared/settings-mcp.ts";
import { persistConfigPatch } from "../src/server/config-patch-storage.ts";
import { getAppConfig, setAppConfig } from "../src/server/db.ts";
import { setForemanConfig } from "../src/server/foreman/config.ts";
import { setHarnessesConfig } from "../src/server/harnesses.ts";
import { setLlmConfig } from "../src/server/llm/config.ts";
import { dispatchSetting } from "../src/server/settings-dispatcher.ts";
import { setTerminalsConfig } from "../src/server/terminals-config.ts";
import { bindTypedSettings, field } from "../src/server/typed-settings.ts";

const unused = (): never => assert.fail("unexpected owner mutation");

test("typed replacement rejects stripped, inherited and oversized input before writing", () => {
  // The route's Zod object strips unknown keys. The one-field binding refuses them
  // rather than accepting a replacement that silently dropped part of the input.
  const schema = z.object({ appearance: z.object({ density: z.enum(["compact", "full"]) }) });
  const config = { appearance: { density: "compact" as const } };
  const [descriptor] = bindTypedSettings({
    schema, read: (): z.output<typeof schema> => config, apply: unused, revision: () => "0",
  }, [field("fixture", "appearance", "layout", { replacement: "composite" })]);
  const dispatch = (request: Parameters<typeof dispatchSetting>[0]) => dispatchSetting(request, [descriptor!], () => null);
  const get = dispatch({ operation: "get", key: "fixture.appearance" });
  assert.ok(get.ok && get.operation === "get" && get.version);
  const update = { operation: "set", key: get.key, expectedVersion: get.version } as const;
  for (const value of [
    { density: "full", unexpected: "secret" },
    JSON.parse('{"density":"full","__proto__":{"unexpected":"secret"}}'),
  ]) {
    assert.deepEqual(dispatch({ ...update, value }), settingsFailure("invalid_value"));
  }
  assert.deepEqual(dispatch({ ...update, value: { density: "x".repeat(SETTINGS_VALUE_MAX_BYTES) } }),
    settingsFailure("value_too_large"));
});

test("nested owner patches preserve stored siblings from a newer build", async (t) => {
  await t.test("Harnesses preserves an unknown advisor field and honors an override removal", () => {
    const entry = APP_CONFIG_ENTRIES.harnesses;
    setAppConfig(entry, {
      advisor: { claude: { default: "sonnet", overrides: { "claude-opus-5": "off" }, futureOption: true } },
    } as never);
    const next = setHarnessesConfig({ advisor: { claude: { overrides: { "claude-opus-5": null } } } });
    assert.deepEqual(next.advisor.claude, { default: "sonnet", overrides: {} });
    assert.deepEqual(getAppConfig(entry)?.advisor.claude, { default: "sonnet", overrides: {}, futureOption: true });
  });

  await t.test("Foreman preserves an unrecognized effort when another role is edited", () => {
    const entry = APP_CONFIG_ENTRIES.foreman;
    setAppConfig(entry, { efforts: { verify: "future-effort" } } as never);
    const next = setForemanConfig({ efforts: { review: "high" } });
    assert.deepEqual(next.efforts, { verify: null, review: "high" });
    assert.deepEqual(getAppConfig(entry)?.efforts, { verify: "future-effort", review: "high" });
  });

  await t.test("LLM preserves a stored sibling when a runner change pins a job's provider", () => {
    const entry = APP_CONFIG_ENTRIES.llm;
    const futureRunner = { provider: "future-runner" };
    setAppConfig(entry, {
      runner: "claude", models: { goal: "claude-sonnet-5" }, runners: { "future-job": futureRunner },
    } as never);
    const next = setLlmConfig({ runner: "codex" });
    assert.equal(next.runners.goal, "claude");
    assert.deepEqual(getAppConfig(entry)?.runners, { "future-job": futureRunner, goal: "claude" });
  });

  await t.test("Terminals persists a multiplexer added by a newer build beside the edited row", () => {
    const entry = APP_CONFIG_ENTRIES.terminals;
    setAppConfig(entry, { multiplexerTerminal: { tmux: "ghostty", "future-mux": "future-emulator" } } as never);
    const next = setTerminalsConfig({ multiplexerTerminal: { tmux: "wezterm" } });
    const stored = getAppConfig(entry)?.multiplexerTerminal;
    assert.equal(next.multiplexerTerminal.tmux, "wezterm");
    assert.equal(stored?.tmux, "wezterm");
    assert.equal((stored as Record<string, unknown>)["future-mux"], "future-emulator");
  });
});

test("repairing a malformed row keeps siblings inside merged fields", () => {
  const schema = z.object({
    limit: z.number(),
    group: z.object({ nested: z.object({ enabled: z.boolean() }) }),
  });
  const entry = { ...APP_CONFIG_ENTRIES.storageLimits, schema } as unknown as AppConfigEntry;
  const before = { limit: 10, group: { nested: { enabled: false } } };
  const patch = { group: { nested: { enabled: true } } };
  const next = schema.parse({ ...before, ...patch });
  setAppConfig(entry, {
    limit: "invalid",
    group: { nested: { enabled: false, futureOption: true } },
  } as never);

  persistConfigPatch(entry, before, next, patch, Object.keys(patch));

  assert.deepEqual(schema.parse(getAppConfig(entry)), next);
  assert.deepEqual(getAppConfig(entry), {
    limit: 10,
    group: { nested: { enabled: true, futureOption: true } },
  });
});
