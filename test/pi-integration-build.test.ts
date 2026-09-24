// A build must survive deletion of the checkout that produced it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectMissionMcpTools } from "../src/server/mission-mcp.ts";
import { execFileSync } from "node:child_process";

test("two absolute source roots produce identical integration bytes that load after source removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-relocation-"));
  try {
    const builds: string[] = [];
    for (const name of ["first", "second"]) {
      const source = join(root, name); mkdirSync(source);
      for (const path of ["src", "scripts", "package.json", "tsconfig.json"]) cpSync(resolve(path), join(source, path), { recursive: true });
      symlinkSync(resolve("node_modules"), join(source, "node_modules"), "dir");
      execFileSync(process.execPath, ["--import", "tsx", "scripts/build-pi-extension.ts"], { cwd: source, env: { ...process.env, MISSION_PI_EXTENSION: join(source, "dist/pi-integration/extension.js") }, stdio: "pipe" });
      const copied = join(root, `${name}-app`);
      cpSync(join(source, "dist/pi-integration"), copied, { recursive: true });
      rmSync(source, { recursive: true }); builds.push(copied);
    }
    for (const file of ["extension.js", "mcp-server.mjs", "manifest.json"]) {
      assert.ok(existsSync(join(builds[0]!, file)), file);
      assert.deepEqual(readFileSync(join(builds[0]!, file)), readFileSync(join(builds[1]!, file)), file);
      assert.ok(!readFileSync(join(builds[0]!, file), "utf8").includes(root), "no absolute source path");
    }
    const loaded = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", "const m = await import(process.argv[1]); console.log(JSON.stringify(m.missionControlBuild))", join(builds[0]!, "extension.js")], { encoding: "utf8" }));
    assert.ok(existsSync(loaded.mcpServerPath));
    assert.equal(await inspectMissionMcpTools(loaded.mcpServerPath), true, "relocated bridge answers real tools/list after both source roots were removed");
    assert.equal(loaded.version, JSON.parse(readFileSync(join(builds[0]!, "manifest.json"), "utf8")).buildId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
