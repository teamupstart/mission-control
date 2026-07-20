import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

// What is at stake: this writes into `~/.claude/settings.json`, which is the user's file
// and not ours.
//
// Three installers write these same six keys - the CLI, the packaged app's teardown, and
// the dashboard's Cost panel - so the edit has to be surgical in both directions: it must
// leave every other key, comment and byte of formatting alone on the way in, and on the
// way out remove exactly what it added and nothing else. The failure mode of getting it
// wrong is not a broken feature, it is someone's Claude Code configuration.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-env-"));
const settingsPath = join(home, "settings.json");
process.env.CLAUDE_SETTINGS_PATH = settingsPath;

const { otelEnvBlock, otelEnvInstalled, sessionIdAttributionDisabled, writeOtelEnv } = await import(
  "../src/shared/claude-settings.ts"
);

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.CLAUDE_SETTINGS_PATH;
  delete process.env.OTEL_METRICS_INCLUDE_SESSION_ID;
});

const SPEC = { endpoint: "http://127.0.0.1:7317", token: "tok-123", intervalMs: 15000 };

beforeEach(() => rmSync(settingsPath, { force: true }));

/** JSONC, not JSON: the file may legitimately carry the user's comments, and does below. */
function read(): Record<string, unknown> {
  return parse(readFileSync(settingsPath, "utf8"), [], { allowTrailingComma: true }) as Record<
    string,
    unknown
  >;
}

test("an install writes the whole block and reports what it did", () => {
  assert.equal(writeOtelEnv(SPEC), "installed");
  assert.deepEqual(read().env, otelEnvBlock(SPEC));
  assert.equal(otelEnvInstalled(), true);
});

test("OTEL_METRICS_INCLUDE_SESSION_ID is never written", () => {
  // It defaults to true, which is what we need. Writing "true" would be writing a default
  // and would then have to be un-written on uninstall - so it is only ever read.
  writeOtelEnv(SPEC);
  assert.equal("OTEL_METRICS_INCLUDE_SESSION_ID" in (read().env as object), false);
});

test("re-running with the same spec changes nothing", () => {
  writeOtelEnv(SPEC);
  const before = readFileSync(settingsPath, "utf8");
  assert.equal(writeOtelEnv(SPEC), "unchanged");
  assert.equal(readFileSync(settingsPath, "utf8"), before, "an idempotent re-run is byte-stable");
});

test("changing the interval updates in place rather than reinstalling", () => {
  writeOtelEnv(SPEC);
  assert.equal(writeOtelEnv({ ...SPEC, intervalMs: 30000 }), "updated");
  assert.equal((read().env as Record<string, string>).OTEL_METRIC_EXPORT_INTERVAL, "30000");
});

test("the user's other keys, env entries and comments survive the round trip", () => {
  writeFileSync(
    settingsPath,
    `{
  // my own note
  "statusLine": { "type": "command", "command": "starship prompt" },
  "env": {
    "EDITOR": "hx",
    "OTEL_SERVICE_NAME": "mine"
  }
}
`,
  );
  writeOtelEnv(SPEC);
  const after = readFileSync(settingsPath, "utf8");
  assert.ok(after.includes("// my own note"), "comments are preserved (jsonc-parser edit)");
  const env = read().env as Record<string, string>;
  assert.equal(env.EDITOR, "hx");
  // Not one of ours, and named similarly enough to be exactly what a careless removal
  // would take with it.
  assert.equal(env.OTEL_SERVICE_NAME, "mine");
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");

  // ...and the uninstall gives their file back, keys and all.
  assert.equal(writeOtelEnv(null), "removed");
  const back = read().env as Record<string, string>;
  assert.deepEqual(back, { EDITOR: "hx", OTEL_SERVICE_NAME: "mine" });
  assert.equal((read().statusLine as { command: string }).command, "starship prompt");
  assert.equal(readFileSync(settingsPath, "utf8").includes("// my own note"), true);
});

test("an uninstall drops an `env` object it emptied, rather than leaving `{}` behind", () => {
  writeOtelEnv(SPEC);
  writeOtelEnv(null);
  assert.equal("env" in read(), false, "a user who had no env before us gets that back");
});

test("uninstalling when nothing is installed is a no-op", () => {
  writeFileSync(settingsPath, `{ "env": { "EDITOR": "hx" } }\n`);
  const before = readFileSync(settingsPath, "utf8");
  assert.equal(writeOtelEnv(null), "unchanged");
  assert.equal(readFileSync(settingsPath, "utf8"), before);
});

test("a broken settings.json is refused rather than overwritten", () => {
  writeFileSync(settingsPath, `{ "env": `);
  assert.throws(() => writeOtelEnv(SPEC), /not valid JSON/);
  assert.equal(readFileSync(settingsPath, "utf8"), `{ "env": `, "their file is left exactly as-is");
  // And the read side answers honestly instead of throwing into a route handler.
  assert.equal(otelEnvInstalled(), false);
});

test("attribution being switched off is detected in either place it can be", () => {
  rmSync(settingsPath, { force: true });
  assert.equal(sessionIdAttributionDisabled(), false);

  writeFileSync(settingsPath, `{ "env": { "OTEL_METRICS_INCLUDE_SESSION_ID": "false" } }\n`);
  assert.equal(sessionIdAttributionDisabled(), true, "as a session would inherit it");

  writeFileSync(settingsPath, `{ "env": { "OTEL_METRICS_INCLUDE_SESSION_ID": "true" } }\n`);
  assert.equal(sessionIdAttributionDisabled(), false);

  process.env.OTEL_METRICS_INCLUDE_SESSION_ID = "false";
  assert.equal(sessionIdAttributionDisabled(), true, "as the daemon inherited it");
  delete process.env.OTEL_METRICS_INCLUDE_SESSION_ID;
});
