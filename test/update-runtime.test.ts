import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkUpdateRuntime, inspectUpdateRuntime, updateNodeProblem } from "../src/main/update-runtime.ts";
import { executableLocator } from "../src/server/executables/locator.ts";

test("Node runtime policy shares the installer's minimum and gives actionable copy", () => {
  for (const version of ["18.20.0", "22.0.0", "23.11.0", "unknown"]) {
    assert.match(updateNodeProblem(version)!, /requires Node.js 24 or newer/);
    assert.match(updateNodeProblem(version)!, /Install or select Node.js 24\+, then choose Check again/);
    assert.match(updateNodeProblem(version)!, /If this warning persists after changing Node in another terminal, restart Mission Control with the corrected Node.js environment\./);
    assert.ok(updateNodeProblem(version)!.includes(version));
  }
  for (const version of ["24.0.0", "26.7.0"]) assert.equal(updateNodeProblem(version), null);
});

test("runtime probes reject old, missing and malformed Node before npm runs, then recover", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mission-node-preflight-"));
  try {
    const selected = join(cwd, "selected-node");
    const npm = join(cwd, "npm");
    const node = { path: selected, env: { ...process.env, PATH: "/usr/bin:/bin" } };
    const identity = async (version: string) => writeFile(selected, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ version, execPath: process.execPath }))});\n`, { mode: 0o755 });
    // npm fails unless the real runtime's directory was placed ahead of the inherited PATH.
    await writeFile(npm, `#!/usr/bin/env node\nif(process.execPath!==${JSON.stringify(process.execPath)}) process.exit(9); console.log(JSON.stringify({npm:"11.0.0",node:process.versions.node}));\n`, { mode: 0o755 });
    await identity("22.0.0");
    assert.deepEqual(await inspectUpdateRuntime(node, { path: "/missing/npm" }, cwd), { ok: false, message: updateNodeProblem("22.0.0") });
    await identity(process.versions.node);
    const runtime = await inspectUpdateRuntime(node, { path: npm }, cwd);
    assert.equal(runtime.ok, true);
    if (runtime.ok) {
      assert.equal(runtime.node, process.execPath);
      assert.ok(runtime.env.PATH!.startsWith(dirname(process.execPath)));
      assert.equal(runtime.env.MISSION_NPM_BIN, npm);
    }
    assert.deepEqual(await inspectUpdateRuntime(null, { path: npm }, cwd), {
      ok: false,
      message: "A system Node.js installation is required to prepare this update. Install or select Node.js 24+ with npm, then choose Check again. Mission Control will keep running. If this warning persists after changing Node in another terminal, restart Mission Control with the corrected Node.js environment.",
    });
    assert.equal((await inspectUpdateRuntime(node, null, cwd)).ok, false);
    assert.equal((await inspectUpdateRuntime(node, null, cwd, false)).ok, true, "installing an already staged bundle does not require npm");
    await writeFile(selected, `#!${process.execPath}\nconsole.log("not-json");\n`, { mode: 0o755 });
    const malformed = await inspectUpdateRuntime(node, { path: npm }, cwd);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.match(malformed.message, /could not verify/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an npm failure or mismatched child Node refuses preparation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mission-node-mismatch-"));
  try {
    const npm = join(cwd, "npm");
    await writeFile(npm, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    const node = { path: process.execPath, env: process.env };
    assert.equal((await inspectUpdateRuntime(node, { path: npm }, cwd)).ok, false);
    await writeFile(npm, `#!${process.execPath}\nconsole.log(JSON.stringify({npm:"11.0.0",node:"22.0.0"}));\n`, { mode: 0o755 });
    const oldNpmNode = await inspectUpdateRuntime(node, { path: npm }, cwd);
    assert.equal(oldNpmNode.ok, false);
    if (!oldNpmNode.ok) assert.match(oldNpmNode.message, /npm is using an incompatible.*found 22.0.0/);
    const differentSupportedVersion = `${Number(process.versions.node.split(".")[0]) + 1}.0.0`;
    await writeFile(npm, `#!${process.execPath}\nconsole.log(JSON.stringify({npm:"11.0.0",node:${JSON.stringify(differentSupportedVersion)}}));\n`, { mode: 0o755 });
    const differentNpmNode = await inspectUpdateRuntime(node, { path: npm }, cwd);
    assert.equal(differentNpmNode.ok, false);
    if (!differentNpmNode.ok) assert.match(differentNpmNode.message, /npm is using a different Node.js version/);
    const bin = join(cwd, "bin");
    await mkdir(bin);
    const shim = join(cwd, "shim");
    await writeFile(shim, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ version: process.versions.node, execPath: join(bin, "other-node") }))});\n`, { mode: 0o755 });
    const mismatch = await inspectUpdateRuntime({ ...node, path: shim }, { path: npm }, cwd);
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.match(mismatch.message, /does not match/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("checking again forces discovery refresh and uses its replacement runtime", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mission-node-refresh-"));
  const node = join(cwd, "selected-node");
  const npm = join(cwd, "selected-npm");
  const calls: string[] = [];
  // Only discovery is doubled. The selected programs and all runtime checks run for real.
  t.mock.method(executableLocator, "refresh", async (options: { force?: boolean }) => {
    assert.deepEqual(options, { force: true });
    calls.push("refresh");
  });
  t.mock.method(executableLocator, "resolve", async (spec: { id: string }) => {
    calls.push(spec.id);
    return { path: spec.id === "node" ? node : npm, env: process.env };
  });
  try {
    await writeFile(node, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ version: "22.0.0", execPath: process.execPath }))});\n`, { mode: 0o755 });
    await writeFile(npm, `#!/usr/bin/env node\nconsole.log(JSON.stringify({npm:"11.0.0",node:process.versions.node}));\n`, { mode: 0o755 });
    const first = await checkUpdateRuntime(cwd);
    assert.equal(first.ok, false);
    if (!first.ok) assert.match(first.message, /found 22.0.0/);
    await writeFile(node, `#!${process.execPath}\nconsole.log(JSON.stringify({version:process.versions.node,execPath:process.execPath}));\n`, { mode: 0o755 });
    const second = await checkUpdateRuntime(cwd);
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.env.MISSION_NPM_BIN, npm);
    assert.deepEqual(calls, ["refresh", "node", "npm", "refresh", "node", "npm"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
