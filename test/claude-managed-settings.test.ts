import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunResult } from "../src/server/util/exec.ts";
import type { FileRead } from "../src/server/environment/types.ts";

// The managed Claude Code policy reader, driven entirely through injected seams.
//
// Nothing here touches the filesystem or spawns `plutil`: every location is a map entry, so no
// test can read the developer's real `/Library` policy. The cases are the ones that decide what
// Settings > Cost may claim - precedence between the three locations, which endpoint wins, the
// two ways a policy turns metrics off, and every failure, each of which must claim nothing.

const {
  classifyManagedMetrics,
  defaultClaudeManagedDeps,
  managedSettingsLocations,
  readManagedClaudeEnv,
} = await import("../src/server/environment/claude-managed.ts");
type Deps = import("../src/server/environment/claude-managed.ts").ClaudeManagedDeps;

const ROOT = "/fixture-root";
const USER_PLIST = `${ROOT}/Library/Managed Preferences/ada/com.anthropic.claudecode.plist`;
const MDM_PLIST = `${ROOT}/Library/Managed Preferences/com.anthropic.claudecode.plist`;
const JSON_FILE = `${ROOT}/Library/Application Support/ClaudeCode/managed-settings.json`;

type PlistAnswer = Partial<RunResult> | "throw";

interface Arrangement {
  plists?: Record<string, PlistAnswer>;
  files?: Record<string, FileRead>;
  /** Paths that exist but cannot be stat'ed as a file: a permission error, a directory. */
  unstatable?: string[];
}

function answer(stdout: string, extra: Partial<RunResult> = {}): Partial<RunResult> {
  return { stdout, stderr: "", code: 0, outcomeUnknown: false, overflowed: false, ...extra };
}

function harness(arrangement: Arrangement): { deps: Deps; runs: string[][] } {
  const runs: string[][] = [];
  const plists = arrangement.plists ?? {};
  const files = arrangement.files ?? {};
  const deps: Deps = {
    root: ROOT,
    user: "ada",
    run: async (bin, args) => {
      runs.push([bin, ...args]);
      const path = args.at(-1) ?? "";
      const arranged = plists[path];
      if (arranged === "throw") throw new Error("spawn failed");
      return {
        stdout: "",
        stderr: "",
        code: 1,
        outcomeUnknown: false,
        overflowed: false,
        ...arranged,
      } as RunResult;
    },
    readText: async (path) => files[path] ?? { ok: false, missing: true, reason: "ENOENT" },
    stat: async (path) =>
      arrangement.unstatable?.includes(path)
        ? "unreadable"
        : path in plists || path in files
          ? { mtimeMs: 1, size: 1 }
          : "missing",
  };
  return { deps, runs };
}

const isThisDaemon = (endpoint: string) => endpoint.startsWith("http://127.0.0.1:7317");

function policyJson(env: Record<string, unknown>): FileRead {
  return { ok: true, text: JSON.stringify({ env }), truncated: false };
}

test("the per-user profile beats the machine profile, which beats managed-settings.json", async () => {
  const user = answer(JSON.stringify({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://user.example" }));
  const machine = answer(JSON.stringify({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://mdm.example" }));
  const file = policyJson({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://file.example" });

  const all = harness({ plists: { [USER_PLIST]: user, [MDM_PLIST]: machine }, files: { [JSON_FILE]: file } });
  assert.deepEqual(await readManagedClaudeEnv(all.deps), {
    source: "mdm-user",
    env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://user.example" },
  });
  // `plutil -extract env` on the winning profile only: one key path, json, to stdout.
  assert.deepEqual(all.runs, [["plutil", "-extract", "env", "json", "-o", "-", USER_PLIST]]);

  const noUser = harness({ plists: { [MDM_PLIST]: machine }, files: { [JSON_FILE]: file } });
  assert.equal((await readManagedClaudeEnv(noUser.deps))?.source, "mdm");

  const fileOnly = harness({ files: { [JSON_FILE]: file } });
  assert.deepEqual(await readManagedClaudeEnv(fileOnly.deps), {
    source: "managed-settings",
    env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://file.example" },
  });
  // No profile exists, so `plutil` never ran.
  assert.deepEqual(fileOnly.runs, []);
});

test("a higher-priority profile that cannot be read stops the read with no claim", async () => {
  // The per-user profile is there, so it - not the machine profile or the JSON file - is what
  // Claude Code obeys. Not knowing what it says is not permission to name another file's host.
  const lower = {
    plists: { [MDM_PLIST]: answer(JSON.stringify({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://mdm.example" })) },
    files: { [JSON_FILE]: policyJson({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://file.example" }) },
  };
  for (const [label, reply] of [
    ["a plutil timeout", answer("", { code: null, outcomeUnknown: true })],
    ["a plutil overflow", answer("{}", { overflowed: true })],
    ["a spawn failure", "throw"],
    ["a malformed plist", answer("<<not json>>")],
    ["an env that is not a dictionary", answer('"https://user.example"')],
    // Phase 3's reader answers a missing `env` key with the same null as a failure, so it is
    // indistinguishable from one, and the safe reading is the same.
    ["a profile with no env key", { code: 1 }],
  ] as const) {
    const { deps, runs } = harness({ ...lower, plists: { [USER_PLIST]: reply, ...lower.plists } });
    assert.equal(await readManagedClaudeEnv(deps), null, label);
    // The machine profile was never consulted to stand in for it.
    assert.deepEqual(runs.map((call) => call.at(-1)), [USER_PLIST], label);
  }
});

test("a higher-priority location that exists but cannot be stat'ed stops the read", async () => {
  const { deps, runs } = harness({
    plists: { [MDM_PLIST]: answer(JSON.stringify({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://mdm.example" })) },
    unstatable: [USER_PLIST],
  });
  assert.equal(await readManagedClaudeEnv(deps), null);
  assert.deepEqual(runs, []);
});

test("an unreadable machine profile stops the read before managed-settings.json", async () => {
  const { deps } = harness({
    plists: { [MDM_PLIST]: answer("", { code: null, outcomeUnknown: true }) },
    files: { [JSON_FILE]: policyJson({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://file.example" }) },
  });
  assert.equal(await readManagedClaudeEnv(deps), null);
});

test("managed-settings.json that parses with no env key is a definite no policy", async () => {
  const { deps } = harness({ files: { [JSON_FILE]: { ok: true, text: '{"model":"x"}', truncated: false } } });
  assert.equal(await readManagedClaudeEnv(deps), null);
});

test("the metrics-specific endpoint beats the generic one", () => {
  assert.deepEqual(
    classifyManagedMetrics(
      {
        source: "mdm",
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example",
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example",
        },
      },
      isThisDaemon,
    ),
    { kind: "redirect", host: "metrics.example", source: "mdm" },
  );
  assert.deepEqual(
    classifyManagedMetrics(
      { source: "mdm", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example" } },
      isThisDaemon,
    ),
    { kind: "redirect", host: "generic.example", source: "mdm" },
  );
});

test("a policy that turns metrics off is disabled, whatever endpoint it also names", () => {
  for (const env of [
    { CLAUDE_CODE_ENABLE_TELEMETRY: "0" },
    { CLAUDE_CODE_ENABLE_TELEMETRY: "false" },
    { CLAUDE_CODE_ENABLE_TELEMETRY: " FALSE " },
    { OTEL_METRICS_EXPORTER: "none", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://x.example" },
  ]) {
    assert.deepEqual(
      classifyManagedMetrics({ source: "managed-settings", env }, isThisDaemon),
      { kind: "disabled", host: null, source: "managed-settings" },
      JSON.stringify(env),
    );
  }
  assert.equal(
    classifyManagedMetrics({ source: "mdm", env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } }, isThisDaemon),
    null,
  );
});

test("an endpoint that is this daemon, or no endpoint at all, claims nothing", () => {
  assert.equal(
    classifyManagedMetrics(
      { source: "mdm", env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:7317" } },
      isThisDaemon,
    ),
    null,
  );
  assert.equal(classifyManagedMetrics({ source: "mdm", env: {} }, isThisDaemon), null);
  assert.equal(classifyManagedMetrics(null, isThisDaemon), null);
});

test("an unparseable or non-HTTP endpoint claims nothing", () => {
  for (const endpoint of ["not a url", "corp-otel:4318", "file:///etc/passwd", "  "]) {
    assert.equal(
      classifyManagedMetrics(
        { source: "mdm", env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint } },
        isThisDaemon,
      ),
      null,
      endpoint,
    );
  }
});

test("only the host survives: no scheme, userinfo, port, path or query", () => {
  const policy = classifyManagedMetrics(
    {
      source: "mdm-user",
      env: {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
          "https://svc:hunter2@corp-otel.example.com:4318/v1/metrics?token=abc#frag",
      },
    },
    isThisDaemon,
  );
  assert.deepEqual(policy, { kind: "redirect", host: "corp-otel.example.com", source: "mdm-user" });
  assert.doesNotMatch(JSON.stringify(policy), /hunter2|svc|4318|v1|token|abc|https/);
});

test("an oversized managed-settings.json is no policy", async () => {
  const { deps } = harness({
    files: {
      [JSON_FILE]: { ok: true, text: '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://x"', truncated: true },
    },
  });
  assert.equal(await readManagedClaudeEnv(deps), null);
});

test("unparseable managed-settings.json, or an env that is not an object, is no policy", async () => {
  for (const text of ["{ env: ", "[]", '{"env": "https://x.example"}', '{"env": ["a"]}']) {
    const { deps } = harness({ files: { [JSON_FILE]: { ok: true, text, truncated: false } } });
    assert.equal(await readManagedClaudeEnv(deps), null, text);
  }
});

test("managed-settings.json may carry comments and trailing commas, as Claude Code allows", async () => {
  const text = `{
    // set by IT
    "env": { "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "https://otel.example.com", },
  }`;
  const { deps } = harness({ files: { [JSON_FILE]: { ok: true, text, truncated: false } } });
  assert.deepEqual(await readManagedClaudeEnv(deps), {
    source: "managed-settings",
    env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.com" },
  });
});

test("a malformed plist, a plutil timeout, an overflow or a spawn failure is no policy", async () => {
  // The only profile present; see above for the same failures on a higher-priority one.
  for (const reply of [
    answer("<<not json>>"),
    answer('"a string, not a dictionary"'),
    answer("", { code: null, outcomeUnknown: true }),
    answer("{}", { overflowed: true }),
    "throw" as const,
  ]) {
    const { deps } = harness({ plists: { [MDM_PLIST]: reply } });
    assert.equal(await readManagedClaudeEnv(deps), null, JSON.stringify(reply));
  }
});

test("the reader never returns another env key", async () => {
  const secretEnv = {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.com",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer s3cret",
    ANTHROPIC_API_KEY: "sk-ant-s3cret",
    HTTPS_PROXY: "http://proxy.internal:3128",
    CLAUDE_CODE_ENABLE_TELEMETRY: 1,
  };
  const plist = harness({ plists: { [MDM_PLIST]: answer(JSON.stringify(secretEnv)) } });
  const file = harness({ files: { [JSON_FILE]: policyJson(secretEnv) } });
  for (const { deps } of [plist, file]) {
    const read = await readManagedClaudeEnv(deps);
    assert.deepEqual(Object.keys(read?.env ?? {}).sort(), [
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    ]);
    // A plist integer reads as the string the process environment would see.
    assert.equal(read?.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
    assert.doesNotMatch(JSON.stringify(read), /s3cret|proxy|Authorization/);
  }
});

test("a user name that could leave the profiles directory is not read", () => {
  for (const user of ["../root", "a/b", "..", ".", "", null]) {
    const sources = managedSettingsLocations(ROOT, user).map((location) => location.source);
    assert.deepEqual(sources, ["mdm", "managed-settings"], String(user));
  }
  assert.equal(managedSettingsLocations("/", "ada")[0]?.path, "/Library/Managed Preferences/ada/com.anthropic.claudecode.plist");
});

test("under the test runner, no override means nothing is read at all", () => {
  // This file never sets MISSION_MANAGED_SETTINGS_ROOT, and the runner marks the process, so
  // the production deps refuse rather than reading the real `/Library` policy.
  assert.equal(process.env.MISSION_MANAGED_SETTINGS_ROOT, undefined);
  assert.equal(defaultClaudeManagedDeps(), null);
});
