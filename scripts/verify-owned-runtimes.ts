// Built artifacts on real Electron with synthetic state. This is not signed-release qualification.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpClient } from "../src/pi/mcp-client.ts";
import { buildOwnedIntegrationInstaller } from "../test/helpers/owned-integration-installer.ts";
import { parse } from "jsonc-parser";
import { build } from "esbuild";
import { resolveOwnedRuntime } from "../src/shared/owned-runtime.mjs";

const root = mkdtempSync(join(tmpdir(), "mission-owned-runtime-"));
const electron = createRequire(import.meta.url)("electron") as string;
const context = {executable:electron, kind:"electron" as const};
const runtime = resolveOwnedRuntime(context);
const received: string[] = [];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  assert.equal(req.headers["x-harness-token"], "synthetic-owned-runtime-token");
  received.push(`${req.url}:${body.agent ?? "statusline"}`);
  res.writeHead(204); res.end();
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const port = (server.address() as {port:number}).port;
const trapDir = join(root,"traps"); mkdirSync(trapDir);
const hits = join(root,"host-runtime-hits");
for (const name of ["node", "npm", "npx"]) writeFileSync(join(trapDir,name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${hits}'\nexit 99\n`, {mode:0o755});
writeFileSync(join(root,".tool-versions"),"nodejs 18.20.8\n");
const env: NodeJS.ProcessEnv = {...process.env, ...runtime.env, HOME:root, MISSION_HOME:join(root,"state"),
  PI_EXTENSIONS_DIR:join(root,"pi-extensions"), CLAUDE_SETTINGS_PATH:join(root,".claude/settings.json"), MISSION_PORT:String(port), MISSION_API_TOKEN:"synthetic-owned-runtime-token", PATH:trapDir+":/usr/bin:/bin"};
delete env.MISSION_HEADLESS; delete env.MISSION_STATUSLINE_INNER;
delete env.MISSION_API_TOKEN_FILE;
const run = (file:string,args:string[] = [], input="{}", childEnv=env): Promise<string> => new Promise((done,reject) => {
  const child = spawn(runtime.command, [resolve(file),...args], {cwd:root,env:childEnv,stdio:"pipe"});
  let output=""; let error="";
  const timer=setTimeout(()=>child.kill("SIGKILL"),30_000);
  child.stdout.on("data",b=>output+=b); child.stderr.on("data",b=>error+=b);
  child.on("error",reject);
  child.on("close",code=>{
    clearTimeout(timer);
    if (code===0) done(output);
    else reject(Error(`${file}: ${code}\n${error}`));
  });
  child.stdin.on("error",()=>{}); child.stdin.end(input);
});
try {
  const checkProbe = join(root, "check-runtime.mjs");
  await build({
    stdin: {contents: `import assert from 'node:assert/strict';
import {spawnCheckProcess} from './src/server/workflows/check-spawn.ts';
const outcome = await spawnCheckProcess({attemptId:'owned-runtime-probe', cwd:process.cwd(),
  command:['/bin/sh','-c','printf "%s" "\u0024{ELECTRON_RUN_AS_NODE-unset}"'], env:process.env, timeoutMs:10000});
assert.equal(outcome.result.kind, 'exited');
assert.equal(outcome.result.exitCode, 0);
assert.equal(outcome.result.output, 'unset');
assert.equal(outcome.emptiness, 'empty');`, resolveDir:process.cwd()},
    bundle:true, platform:"node", format:"esm", outfile:checkProbe,
    alias:{"@shared":"./src/shared"}, logLevel:"silent",
  });
  for (const mode of ["absent", "traps"] as const) {
    const childEnv = {...env, PATH:mode==="absent" ? "/usr/bin:/bin" : env.PATH};
    const before = received.length;
    await run("dist/satellites/hook.mjs",["Stop"],'{"session_id":"synthetic"}',childEnv);
    await run("dist/satellites/codex-hook.mjs",["Stop"],'{"session_id":"synthetic"}',childEnv);
    await run("dist/satellites/harness-statusline.mjs",[],"{}",childEnv);
    assert.equal(received.length-before,3,"each shipped reporter reached the isolated receiver");
    assert.match(await run("dist/satellites/resume-guard.mjs",["--check"],"",childEnv), /mission-resume-guard-v1/);
    for (const file of ["dist/mcp/server.mjs","dist/pi-integration/mcp-server.mjs"]) {
      const client = new McpClient(resolve(file), {runtime:context,cwd:root,env:childEnv});
      try { assert.ok((await client.tools()).some(tool=>tool.name==="request_input")); }
      finally {client.close();}
    }
    // Uninstall against a synthetic home executes the real publisher without creating a live integration.
    await run("dist/pi-installer/index.mjs",["--uninstall"],"",childEnv);
    await run(checkProbe, [], "", childEnv);
    console.log(`[owned-runtime] ${mode}: shipped Claude/Codex/statusline reports, MCP and Pi bridge handshakes, Pi installer, resume check and Check supervisor passed on Electron`);
  }
  mkdirSync(join(root,"state"),{recursive:true});
  writeFileSync(join(root,"state/statusline-inner"),'printf "saved command:%s" "${ELECTRON_RUN_AS_NODE-unset}"');
  assert.equal(await run("dist/satellites/harness-statusline.mjs"),"saved command:unset");
  assert.equal(readFileSync(join(root,"state/statusline-inner"),"utf8"),'printf "saved command:%s" "${ELECTRON_RUN_AS_NODE-unset}"');
  // Exercise the real desktop repair code with a synthetic Electron app-path adapter.
  // The child itself is real Electron; no live app, agent CLI or operator config is used.
  mkdirSync(join(root,".claude"),{recursive:true});
  mkdirSync(join(root,"dist/satellites"),{recursive:true});
  for (const file of ["hook.mjs","harness-statusline.mjs"]) copyFileSync(resolve("dist/satellites",file),join(root,"dist/satellites",file));
  writeFileSync(join(root,".claude/settings.json"),JSON.stringify({hooks:{Stop:[{hooks:[{command:'"/mise/shims/node" "/source/hooks/harness-hook.mjs" Stop'}]}]}}));
  writeFileSync(join(root,".claude.json"),JSON.stringify({mcpServers:{"mission-control":{command:"/mise/shims/node",args:["/source/dist/mcp/server.mjs"],env:{CUSTOM:"keep"}}}}));
  const installer = await buildOwnedIntegrationInstaller(root);
  // Codex has no existing registration here, so its vendor-CLI boundary must
  // succeed. Real MCP runtime handshakes are exercised separately above.
  const installEnv = {...env, MISSION_TEST_APP_ROOT:root,MISSION_CLAUDE_BIN:"/usr/bin/false",MISSION_CODEX_BIN:"/usr/bin/true",MISSION_NODE_BIN:join(trapDir,"node")};
  assert.equal(JSON.parse(await run(installer,[],"",installEnv)).ok,true);
  const repaired=parse(readFileSync(join(root,".claude/settings.json"),"utf8"));
  assert.ok(repaired.hooks.Stop[0].hooks[0].command.includes(electron));
  assert.equal(parse(readFileSync(join(root,".claude.json"),"utf8")).mcpServers["mission-control"].command,electron);
  const once=readFileSync(join(root,".claude/settings.json"),"utf8");
  assert.equal(JSON.parse(await run(installer,[],"",installEnv)).ok,true);
  assert.equal(readFileSync(join(root,".claude/settings.json"),"utf8"),once);
  console.log("[owned-runtime] Real desktop installer on Electron repaired old source registrations and repeated without changes.");
  assert.equal(existsSync(hits),false,"no host Node/npm/npx invocation");
  console.log("[owned-runtime] Saved third-party command preserved; Node mode did not leak; zero host-runtime trap hits.");
  console.log("[owned-runtime] Local Electron execution only. Signed installation, update and recovery remain R1/R2 qualification.");
} finally {
  await new Promise<void>(done=>server.close(()=>done()));
  rmSync(root,{recursive:true,force:true});
}
