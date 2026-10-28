// Runtime ownership must survive old PATH shims, adopted daemons and renamed executables.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { integrationRuntime, ownedInvocation, ownedHook, ownedStatusline, repairOwnedMcp, INTEGRATION_REPAIR_NONCE } from "../src/main/integration-runtime.ts";
import { createMigrationConfigPort } from "../src/main/migration-integration-config.ts";
import { capabilitiesFor } from "../src/shared/harness-capabilities.ts";
import { servingRuntime } from "../src/server/owned-runtime.ts";
import { resolveMissionMcpRuntime } from "../src/server/mission-mcp.ts";
import { missionHookScriptPath } from "../src/server/harness/claude/hooks.ts";

const exe = "/Applications/Agent Mission Control.app/Contents/MacOS/Mission Control";
const runtime = integrationRuntime(exe, "electron");

test("owned invocations quote literal paths and never select host Node", () => {
  const script = '/checkout $HOME/`touch surprise`/a"b\\c/dist/satellites/hook.mjs';
  const command = runtime.hookCommand(script, "Stop");
  assert.deepEqual(ownedInvocation(command), {executable: exe, script, event: "Stop"});
  assert.equal(missionHookScriptPath(command), script, "Setup diagnoses exactly the escaped path emitted by repair");
  assert.deepEqual(runtime.mcpArgs(script), {env: ["ELECTRON_RUN_AS_NODE=1"], argv: [exe, script]});
  const literal = integrationRuntime(process.execPath, "node").hookCommand(script);
  // A shell actually parses the output; dollars/backticks remain data, not expansion.
  assert.equal(execFileSync("/bin/sh", ["-c", `${literal.replace('"' + process.execPath + '"', 'printf "%s"')} `], {encoding:"utf8"}), script);
  assert.equal(ownedHook(`echo before; ${command}`), null);
  assert.equal(ownedHook(`"/custom/wrapper" "/source/hooks/harness-hook.mjs" Stop`), null);
  assert.ok(ownedHook('"/mise/shims/node" "/source/hooks/harness-hook.mjs" Stop'));
  assert.ok(ownedStatusline('"/mise/shims/node" "/source/hooks/harness-statusline.mjs"'));
});

test("explicit runtime facts handle renamed Node binaries and adopted source daemons", () => {
  assert.deepEqual(resolveMissionMcpRuntime("/tools/node-24", "node"), {command:"/tools/node-24", env:{}});
  const facts = {executable:exe, node:"24.1.0", electron:"43.0.0", parentPort:true,
    modulePath:"/Applications/Agent Mission Control.app/Contents/Resources/app/dist/server/index.mjs"};
  assert.equal(servingRuntime(facts).origin, "bundled");
  assert.equal(servingRuntime({...facts, executable:"/Applications/Agent Mission Control.app/Contents/Frameworks/Agent Mission Control Helper.app/Contents/MacOS/Agent Mission Control Helper"}).origin,"bundled");
  assert.equal(servingRuntime({...facts, executable:process.execPath, electron:undefined, parentPort:false}).origin, "standalone");
  assert.equal(servingRuntime({...facts, modulePath:"/checkout/dist/server/index.mjs"}).origin, "electron-development");
  assert.equal(servingRuntime({...facts, parentPort:false}).origin, "electron-development");
});

test("repair upgrades an old source MCP registration without changing environment or custom commands", () => {
  const before = {command:"/mise/shims/node", args:["/durable clone/dist/mcp/server.mjs"], env:{CUSTOM:"$HOME unchanged"}};
  assert.deepEqual(repairOwnedMcp(before, runtime, "/app/dist/mcp/server.mjs"), {
    command:exe, args:["/app/dist/mcp/server.mjs"], env:{CUSTOM:"$HOME unchanged", ELECTRON_RUN_AS_NODE:"1"},
  });
  assert.equal(repairOwnedMcp({...before, args:["--custom", ...before.args]}, runtime, "script"), null);
  assert.equal(repairOwnedMcp({...before, command:"/custom/wrapper"}, runtime, "script"), null);
});

test("MCP repair preserves JSONC environment comments, disabled records and repeat publication", t => {
  const home = mkdtempSync(join(tmpdir(), "owned-mcp-"));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const path = join(home, ".claude.json");
  writeFileSync(path, '{// top comment\n"mcpServers":{"mission-control":{"command":"/mise/shims/node","args":["/source/dist/mcp/server.mjs"],"env":{// keep env comment\n"CUSTOM":"stay"},"disabledTools":["one"]}}}');
  const port = createMigrationConfigPort({home, command:() => {throw Error("no CLI for JSONC");}});
  const spec = capabilitiesFor("claude").mcp!;
  const before = port.readMcp(spec);
  const desired = repairOwnedMcp(before.registration!, runtime, "/app/dist/mcp/server.mjs")!;
  port.writeMcp(spec, INTEGRATION_REPAIR_NONCE, before, desired);
  const text = readFileSync(path, "utf8");
  assert.match(text, /keep env comment/);
  assert.deepEqual(parse(text).mcpServers[spec.serverName].disabledTools, ["one"]);
  port.writeMcp(spec, INTEGRATION_REPAIR_NONCE, port.readMcp(spec), desired);
  assert.equal(readFileSync(path, "utf8"), text);
  writeFileSync(path, '{"mcpServers":{"mission-control":{"enabled":false,"command":"node","args":[]}}}');
  assert.equal(port.readMcp(spec).registration, null);
  assert.equal(port.readMcp(spec).present, true);
  mkdirSync(join(home, ".codex"));
});

test("Codex repair adds invocation-scoped Node mode while keeping TOML comments and custom environment", t => {
  const home = mkdtempSync(join(tmpdir(),"owned-toml-"));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  mkdirSync(join(home,".codex"));
  const path = join(home,".codex/config.toml");
  for (const withEnv of [false,true]) {
    writeFileSync(path,'# keep file\n[mcp_servers.mission-control]\ncommand = "/mise/shims/node" # keep command\nargs = ["/source/dist/mcp/server.mjs"]\ntool_timeout_sec = 42\n'+(withEnv?'[mcp_servers.mission-control.env]\nCUSTOM = "stay" # keep custom\n':''));
    const port = createMigrationConfigPort({home,command:()=> {
      const text=readFileSync(path,"utf8");
      return JSON.stringify([{name:"mission-control",transport:{command:JSON.parse(/^command = (".*?")/m.exec(text)![1]!),args:JSON.parse(/^args = (\[.*\])/m.exec(text)![1]!),env:{...(withEnv?{CUSTOM:"stay"}:{}),...(text.includes('"ELECTRON_RUN_AS_NODE" = "1"')?{ELECTRON_RUN_AS_NODE:"1"}:{})}}}]);
    }});
    const spec=capabilitiesFor("codex").mcp!;
    const before=port.readMcp(spec);
    const desired=repairOwnedMcp(before.registration!,runtime,"/app/dist/mcp/server.mjs")!;
    assert.deepEqual(port.writeMcp(spec,INTEGRATION_REPAIR_NONCE,before,desired).registration,desired);
    const text=readFileSync(path,"utf8");
    assert.match(text,/# keep file/); assert.match(text,/# keep command/); assert.match(text,/tool_timeout_sec = 42/);
    if(withEnv) assert.match(text,/# keep custom/);
  }
});

test("Codex repair handles an empty env table without a newline and refuses custom inline env", t => {
  const home = mkdtempSync(join(tmpdir(), "owned-toml-edge-"));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/config.toml");
  const before = {command: "/mise/shims/node", args: ["/source/dist/mcp/server.mjs"]};
  const prefix = '[mcp_servers.mission-control]\ncommand = "/mise/shims/node"\nargs = ["/source/dist/mcp/server.mjs"]\n';
  const port = createMigrationConfigPort({home, command: () => JSON.stringify([
    {name: "mission-control", transport: before},
  ])});
  const spec = capabilitiesFor("codex").mcp!;
  const desired = repairOwnedMcp(before, runtime, "/app/dist/mcp/server.mjs")!;
  writeFileSync(path, prefix + '[mcp_servers.mission-control.env]');
  port.writeMcp(spec, INTEGRATION_REPAIR_NONCE, port.readMcp(spec), desired);
  assert.match(readFileSync(path, "utf8"), /\[mcp_servers\.mission-control\.env\]\n"ELECTRON_RUN_AS_NODE" = "1"\n/);
  const inline = prefix + 'env = {}\n';
  writeFileSync(path, inline);
  assert.throws(() => port.writeMcp(spec, INTEGRATION_REPAIR_NONCE, port.readMcp(spec), desired), /custom inline TOML/);
  assert.equal(readFileSync(path, "utf8"), inline);
});
