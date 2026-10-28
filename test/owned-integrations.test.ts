// Exercise the real packaged installer against synthetic configuration, including its repair path.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { buildOwnedIntegrationInstaller } from "./helpers/owned-integration-installer.ts";

test("desktop installer reports partial MCP registration, repair and removal failures", async t => {
  for (const scenario of ["claude CLI", "codex CLI", "invalid configuration", "removal"] as const) {
    await t.test(scenario, async t => {
      const home = mkdtempSync(join(tmpdir(), "owned-mcp-failure-"));
      t.after(() => rmSync(home, {recursive: true, force: true}));
      mkdirSync(join(home, ".claude"));
      mkdirSync(join(home, "dist/satellites"), {recursive: true});
      writeFileSync(join(home, "dist/satellites/hook.mjs"), "");
      const settingsPath = join(home, ".claude/settings.json");
      writeFileSync(settingsPath, "{}");
      const mcpPath = join(home, ".claude.json");
      if (scenario === "invalid configuration") writeFileSync(mcpPath, '{"mcpServers":');
      if (scenario === "removal") writeFileSync(mcpPath, JSON.stringify({mcpServers: {
        "mission-control": {command: "/mise/shims/node", args: ["/source/dist/mcp/server.mjs"]},
      }}));
      const originalMcp = scenario === "invalid configuration" || scenario === "removal" ? readFileSync(mcpPath, "utf8") : null;
      const installer = await buildOwnedIntegrationInstaller(home);
      const result = JSON.parse(execFileSync(process.execPath, [installer, ...(scenario === "removal" ? ["--remove"] : [])], {
        env: {...process.env, HOME: home, MISSION_HOME: join(home, "state"), MISSION_TEST_APP_ROOT: home,
          CLAUDE_SETTINGS_PATH: settingsPath, CLAUDE_CONFIG_DIR: join(home, ".claude"),
          MISSION_CLAUDE_BIN: scenario === "codex CLI" ? "/usr/bin/true" : "/usr/bin/false",
          MISSION_CODEX_BIN: scenario === "codex CLI" ? "/usr/bin/false" : "/usr/bin/true"},
        encoding: "utf8",
      }));
      assert.equal(result.ok, false, result.message);
      assert.match(result.message, scenario === "removal" ? /MCP removal needs attention/ : /MCP installation needs attention/);
      assert.doesNotMatch(result.message, /Claude integrations (installed|removed)/);
      if (scenario === "codex CLI") assert.match(result.message, /Claude Code: MCP review server registered\./);
      if (scenario === "claude CLI") assert.match(result.message, /Codex: MCP review server registered\./);
      if (originalMcp !== null) assert.equal(readFileSync(mcpPath, "utf8"), originalMcp);
      if (scenario !== "removal") assert.equal(parse(readFileSync(settingsPath, "utf8")).hooks.Stop.length, 1);
    });
  }
});

test("desktop installer initializes blank settings and preserves malformed settings", async t => {
  for (const [label, original, valid] of [
    ["empty", "", true],
    ["whitespace only", " \t\r\n ", true],
    ["malformed JSON", '{"permissions":', false],
    ["non-object JSON", "[]", false],
  ] as const) {
    await t.test(label, async t => {
      const home = mkdtempSync(join(tmpdir(), "owned-blank-settings-"));
      t.after(() => rmSync(home, {recursive: true, force: true}));
      mkdirSync(join(home, ".claude"));
      mkdirSync(join(home, "dist/satellites"), {recursive: true});
      writeFileSync(join(home, "dist/satellites/hook.mjs"), "");
      const settingsPath = join(home, ".claude/settings.json");
      writeFileSync(settingsPath, original);
      const installer = await buildOwnedIntegrationInstaller(home);
      const env = {...process.env, HOME: home, MISSION_HOME: join(home, "state"),
        CLAUDE_SETTINGS_PATH: settingsPath, CLAUDE_CONFIG_DIR: join(home, ".claude"),
        MISSION_TEST_APP_ROOT: home, MISSION_CLAUDE_BIN: "/usr/bin/true", MISSION_CODEX_BIN: "/usr/bin/true"};
      const run = () => JSON.parse(execFileSync(process.execPath, [installer], {env, encoding: "utf8"}));
      const result = run();
      assert.equal(result.ok, valid, result.message);
      const text = readFileSync(settingsPath, "utf8");
      if (!valid) {
        assert.match(result.message, /invalid JSON\/JSONC/);
        assert.equal(text, original, "invalid settings remain byte-for-byte unchanged");
        return;
      }
      const settings = parse(text);
      assert.equal(settings.hooks.Stop.length, 1);
      assert.equal(settings.hooks.Stop[0].hooks.length, 1);
      assert.equal(settings.hooks.Stop[0].hooks[0].command,
        `ELECTRON_RUN_AS_NODE="1" "${process.execPath}" "${join(home, "dist/satellites/hook.mjs")}" "Stop"`);
      assert.equal(run().ok, true);
      assert.equal(readFileSync(settingsPath, "utf8"), text, "repair remains byte-stable");
    });
  }
});

test("packaged installer repairs source hooks, statusline and MCP in place and reverses its wrapper", async t => {
  const home = mkdtempSync(join(tmpdir(), "owned-installer-"));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, "state"));
  mkdirSync(join(home, "dist/satellites"), {recursive:true});
  for (const file of ["hook.mjs", "harness-statusline.mjs"]) writeFileSync(join(home, "dist/satellites", file), "");
  const command = '"/mise/shims/node" "/source/hooks/harness-hook.mjs" Stop';
  const path = join(home, ".claude/settings.json");
  writeFileSync(path, `{// keep top\n"permissions":{"allow":["keep"]},"hooks":{"Stop":[{"matcher":"custom", "hooks":[{// keep hook\n"type":"command","command":${JSON.stringify(command)},"timeout":42,"disabled":true},{"type":"command","command":"echo custom"}]}]},"statusLine":{"type":"command","command":${JSON.stringify('"/mise/shims/node" "/source/hooks/harness-statusline.mjs"')},"padding":2}}`);
  writeFileSync(join(home, "state/statusline-inner"), "printf 'my custom line'\n");
  writeFileSync(join(home, ".claude.json"), '{"mcpServers":{"mission-control":{"command":"/mise/shims/node","args":["/source/dist/mcp/server.mjs"],"env":{"CUSTOM":"stay"},"timeout":12}}}');
  const installer = await buildOwnedIntegrationInstaller(home);
  const env = {...process.env, HOME:home, CLAUDE_SETTINGS_PATH:path, MISSION_HOME:join(home,"state"), MISSION_TEST_APP_ROOT:home, MISSION_CLAUDE_BIN:"/usr/bin/true", MISSION_CODEX_BIN:"/usr/bin/true", MISSION_NODE_BIN:"/nonexistent/node"};
  const run = (args:string[] = []) => JSON.parse(execFileSync(process.execPath, [installer,...args], {env, encoding:"utf8"}));
  assert.equal(run().ok, true);
  const text = readFileSync(path,"utf8");
  assert.match(text, /keep top/); assert.match(text, /keep hook/);
  const settings = parse(text);
  assert.deepEqual(settings.permissions, {allow:["keep"]});
  assert.equal(settings.hooks.Stop[0].matcher, "custom");
  assert.equal(settings.hooks.Stop[0].hooks[0].disabled, true);
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 42);
  assert.equal(settings.hooks.Stop[0].hooks[1].command, "echo custom");
  assert.match(settings.hooks.Stop[0].hooks[0].command, /ELECTRON_RUN_AS_NODE="1"/);
  assert.equal(settings.statusLine.padding,2);
  const mcp = parse(readFileSync(join(home,".claude.json"),"utf8")).mcpServers["mission-control"];
  assert.equal(mcp.command, process.execPath); assert.deepEqual(mcp.env,{CUSTOM:"stay",ELECTRON_RUN_AS_NODE:"1"});
  assert.equal(run().ok,true); assert.equal(readFileSync(path,"utf8"),text);
  assert.equal(run(["--remove"]).ok,true);
  const removed = parse(readFileSync(path,"utf8"));
  assert.equal(removed.statusLine.command,"printf 'my custom line'");
  assert.equal(removed.hooks.Stop[0].hooks[0].command,"echo custom");
  const custom = '{"hooks":{"Stop":[{"hooks":[{"command":"echo before; node /source/hooks/harness-hook.mjs Stop"}]}]}}';
  writeFileSync(path,custom);
  assert.equal(run().ok,false); assert.equal(readFileSync(path,"utf8"),custom);
  env.CLAUDE_SETTINGS_PATH = join(home, "custom-settings.json");
  assert.match(run().message, /custom settings path/);
  assert.equal(readFileSync(path,"utf8"),custom);
  env.CLAUDE_SETTINGS_PATH = path;
  const customHomeResult = JSON.parse(execFileSync(process.execPath, [installer], {
    env: {...env, CLAUDE_CONFIG_DIR: join(home, "custom-config")}, encoding:"utf8",
  }));
  assert.match(customHomeResult.message, /custom settings path/);
  assert.equal(readFileSync(path,"utf8"),custom);
});

test("desktop MCP removal removes owned registrations and preserves custom or disabled ones", async t => {
  const home = mkdtempSync(join(tmpdir(), "owned-mcp-removal-"));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const claudeHome = join(home, ".claude");
  mkdirSync(claudeHome);
  const settingsPath = join(claudeHome, "settings.json");
  const mcpPath = join(home, ".claude.json");
  const callsPath = join(home, "claude-calls.json");
  const cli = join(home, "claude");
  writeFileSync(settingsPath, "{}");
  writeFileSync(callsPath, "[]");
  // This fixture is only the vendor CLI boundary. The real desktop installer
  // decides whether it may call remove; the fixture makes that decision observable.
  writeFileSync(cli, `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
assert.deepEqual(args, ["mcp", "remove", "-s", "user", "mission-control"]);
const callsPath = path.join(process.env.HOME, "claude-calls.json");
const calls = JSON.parse(fs.readFileSync(callsPath, "utf8"));
calls.push(args);
fs.writeFileSync(callsPath, JSON.stringify(calls));
const configPath = path.join(process.env.HOME, ".claude.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
delete config.mcpServers["mission-control"];
fs.writeFileSync(configPath, JSON.stringify(config));
`, {mode: 0o755});
  const installer = await buildOwnedIntegrationInstaller(home);
  const env = {
    ...process.env,
    HOME: home,
    MISSION_HOME: join(home, "state"),
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_SETTINGS_PATH: settingsPath,
    MISSION_TEST_APP_ROOT: home,
    MISSION_CLAUDE_BIN: cli,
    MISSION_CODEX_BIN: "/usr/bin/false",
  };
  const remove = () => JSON.parse(execFileSync(process.execPath, [installer, "--remove"], {env, encoding: "utf8"}));
  const calls = () => JSON.parse(readFileSync(callsPath, "utf8"));
  const owned = {command: "/mise/shims/node", args: ["/source/dist/mcp/server.mjs"]};
  const unrelated = {command: "/custom/unrelated", args: ["keep"]};
  writeFileSync(mcpPath, JSON.stringify({mcpServers: {"mission-control": owned, unrelated}}));

  const result = remove();
  assert.equal(result.ok, true);
  assert.match(result.message, /Claude Code: MCP server removed\./);
  assert.deepEqual(calls(), [["mcp", "remove", "-s", "user", "mission-control"]]);
  assert.deepEqual(parse(readFileSync(mcpPath, "utf8")).mcpServers, {unrelated});

  for (const [label, registration] of [
    ["custom", {...owned, command: "/custom/wrapper"}],
    ["disabled", {...owned, enabled: false}],
  ] as const) {
    const original = JSON.stringify({mcpServers: {"mission-control": registration, unrelated}}, null, 2) + "\n";
    writeFileSync(mcpPath, original);
    const preserved = remove();
    assert.equal(preserved.ok, true);
    assert.match(preserved.message, /Claude Code: Disabled, absent or custom MCP registration preserved\./);
    assert.equal(readFileSync(mcpPath, "utf8"), original, `${label} registration remains byte-for-byte unchanged`);
    assert.equal(calls().length, 1, `${label} registration never invokes CLI removal`);
  }
});

test("desktop repair collapses owned duplicates within and across hook groups", async t => {
  const home = mkdtempSync(join(tmpdir(), "owned-hook-duplicates-"));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, "dist/satellites"), {recursive: true});
  writeFileSync(join(home, "dist/satellites/hook.mjs"), "");
  const path = join(home, ".claude/settings.json");
  const source = {type: "command", command: '"/mise/shims/node" "/source/hooks/harness-hook.mjs" Stop'};
  const packaged = {type: "command", command: 'ELECTRON_RUN_AS_NODE=1 "/old/Agent Mission Control.app/Contents/MacOS/Mission Control" "/old/Agent Mission Control.app/Contents/Resources/app/dist/satellites/hook.mjs" Stop'};
  const firstCustom = {type: "command", command: "echo first", timeout: 11};
  const lastCustom = {type: "command", command: "echo last", disabled: true};
  const settings = {
    permissions: {allow: ["keep"]},
    hooks: {Stop: [
      {matcher: "original", hooks: [{...source, timeout: 42, async: true}, firstCustom, packaged]},
      {matcher: "keep this matcher", hooks: [source, lastCustom]},
      {hooks: [packaged]},
    ]},
  };
  writeFileSync(path, '// keep settings comment\n' + JSON.stringify(settings, null, 2));
  const installer = await buildOwnedIntegrationInstaller(home);
  const env = {...process.env, HOME: home, MISSION_HOME: join(home, "state"), CLAUDE_SETTINGS_PATH: path,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), MISSION_TEST_APP_ROOT: home,
    MISSION_CLAUDE_BIN: "/usr/bin/true", MISSION_CODEX_BIN: "/usr/bin/true"};
  const run = () => JSON.parse(execFileSync(process.execPath, [installer], {env, encoding: "utf8"}));
  assert.equal(run().ok, true);
  const once = readFileSync(path, "utf8");
  const repaired = parse(once);
  assert.equal(repaired.hooks.Stop.length, 2, "the duplicate-only group is removed");
  assert.equal(repaired.hooks.Stop[0].hooks.length, 2, "only the first owned hook and the unrelated hook remain");
  assert.equal(repaired.hooks.Stop[0].matcher, "original");
  assert.deepEqual(repaired.hooks.Stop[0].hooks[0], {...source, timeout: 42, async: true,
    command: `ELECTRON_RUN_AS_NODE="1" "${process.execPath}" "${join(home, "dist/satellites/hook.mjs")}" "Stop"`});
  assert.deepEqual(repaired.hooks.Stop[0].hooks[1], firstCustom);
  assert.deepEqual(repaired.hooks.Stop[1], {matcher: "keep this matcher", hooks: [lastCustom]});
  assert.deepEqual(repaired.permissions, settings.permissions);
  assert.match(once, /keep settings comment/);
  assert.equal(run().ok, true);
  assert.equal(readFileSync(path, "utf8"), once, "repair remains byte-stable");
});

test("desktop MCP removal preserves a registration replaced after its initial inspection", async t => {
  const home = mkdtempSync(join(tmpdir(), "owned-mcp-race-"));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  mkdirSync(join(home, ".claude"));
  const settingsPath = join(home, ".claude/settings.json");
  const mcpPath = join(home, ".claude.json");
  const cli = join(home, "claude");
  const callsPath = join(home, "removal-calls");
  writeFileSync(settingsPath, "{}");
  writeFileSync(cli, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, "remove\\n");
`, {mode: 0o755});
  writeFileSync(callsPath, "");
  const installer = await buildOwnedIntegrationInstaller(home, `
if (command === "claude") {
  const fs = require("node:fs");
  const path = require("node:path").join(process.env.HOME, ".claude.json");
  fs.writeFileSync(path + ".replacement", process.env.MISSION_TEST_MCP_REPLACEMENT);
  fs.renameSync(path + ".replacement", path);
}`);
  const owned = {command: "/mise/shims/node", args: ["/source/dist/mcp/server.mjs"]};
  for (const registration of [{...owned, command: "/custom/wrapper"}, {...owned, enabled: false}, owned]) {
    const original = JSON.stringify({mcpServers: {"mission-control": owned}});
    const replacement = JSON.stringify({mcpServers: {"mission-control": registration}});
    writeFileSync(mcpPath, original);
    const result = JSON.parse(execFileSync(process.execPath, [installer, "--remove"], {
      env: {...process.env, HOME: home, MISSION_HOME: join(home, "state"), CLAUDE_SETTINGS_PATH: settingsPath,
        CLAUDE_CONFIG_DIR: join(home, ".claude"), MISSION_TEST_APP_ROOT: home,
        MISSION_CLAUDE_BIN: cli, MISSION_CODEX_BIN: "/usr/bin/false", MISSION_TEST_MCP_REPLACEMENT: replacement},
      encoding: "utf8",
    }));
    assert.equal(result.ok, false);
    assert.equal(readFileSync(callsPath, "utf8"), "", "changed file identity must prevent CLI removal, even with identical content");
    assert.equal(readFileSync(mcpPath, "utf8"), replacement);
    assert.match(result.message, /MCP registration changed before removal/);
  }
});
