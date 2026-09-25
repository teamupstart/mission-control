// A failed/concurrent build may never truncate the machine-wide load target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPiExtension } from "../scripts/build-pi-extension.ts";
import { piExtensionPath } from "../src/server/config.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { verifyPiIntegration } from "../src/server/extensions/pi-artifact.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { writePiIntegration } from "./helpers/pi-integration.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { mockSymlinkPublication } from "./helpers/symlink-publication.ts";

ensureNativeStateLockAddon();

test("directory publication refuses to discard unrelated output-directory contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-build-foreign-"));
  const dir = join(root, "integration"); writePiIntegration(dir);
  const prior = verifyPiIntegration(dir);
  await writeFile(join(dir, "operator.txt"), "keep me");
  try {
    await assert.rejects(buildPiExtension(join(dir, "extension.js")), /contains unrelated files/);
    assert.deepEqual(verifyPiIntegration(dir), prior);
    assert.equal(await readFile(join(dir, "operator.txt"), "utf8"), "keep me");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of ["swap", "rollback"] as const) {
  test(`failed build ${failure} preserves the previous integration for recovery`, async t => {
    const root = await mkdtemp(join(tmpdir(), "pi-build-swap-"));
    const dir = join(fs.realpathSync(root), "integration"); writePiIntegration(dir);
    const prior = verifyPiIntegration(dir);
    let calls = 0, retained = "";
    const swap = mockSymlinkPublication(t, "exchangePaths", (exchange, from, to) => {
      calls++; retained = from;
      if (calls === (failure === "swap" ? 1 : 2)) throw new Error("injected swap failure");
      exchange(from, to);
    });
    const read = fs.readFileSync;
    const fault = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      if (failure === "rollback" && String(args[0]) === join(dir, "manifest.json")) throw new Error("verification denied");
      return read(...args);
    }); syncBuiltinESMExports();
    try {
      await assert.rejects(buildPiExtension(join(dir, "extension.js")), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, failure === "swap" ? /injected swap failure/ : /previous integration retained at/);
        if (failure === "rollback") assert.ok(error.message.includes(retained));
        return true;
      });
    } finally { swap.restore(); fault.mock.restore(); syncBuiltinESMExports(); }
    try {
      assert.equal(calls, failure === "swap" ? 1 : 2);
      assert.deepEqual(verifyPiIntegration(failure === "swap" ? dir : retained), prior);
      if (failure === "swap") assert.equal(fs.existsSync(retained), false, "failed candidate is cleaned");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("failed final build verification restores the previous complete integration", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-build-rollback-"));
  const dir = join(fs.realpathSync(root), "integration"); writePiIntegration(dir);
  const prior = verifyPiIntegration(dir);
  const read = fs.readFileSync;
  let failed = false;
  const fault = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === join(dir, "manifest.json") && !failed) { failed = true; throw new Error("final verification I/O failure"); }
    return read(...args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(buildPiExtension(join(dir, "extension.js")), /final verification I\/O failure/); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  try { assert.equal(failed, true); assert.deepEqual(verifyPiIntegration(dir), prior); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("configured and explicit non-.js targets are rejected before touching the destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-suffix-"));
  const prior = process.env.MISSION_PI_EXTENSION;
  try {
    for (const name of ["index.mjs", "index.cjs", "index", "index.JS", "index.js.map"]) {
      const output = join(dir, name);
      await writeFile(output, "previous");
      process.env.MISSION_PI_EXTENSION = output;
      assert.throws(() => piExtensionPath(), /must end in \.js/);
      await assert.rejects(buildPiExtension(), /must end in \.js/);
      await assert.rejects(buildPiExtension(output), /must end in \.js/);
      assert.equal(await readFile(output, "utf8"), "previous");
      assert.deepEqual(await readdir(dir), [name], "rejection creates no staging files");
      await rm(output);
    }
    process.env.MISSION_PI_EXTENSION = join(dir, "absent", "index.mjs");
    await assert.rejects(buildPiExtension(), /must end in \.js/);
    assert.deepEqual(await readdir(dir), [], "rejection does not create the parent directory");
    process.env.MISSION_PI_EXTENSION = join(dir, "extension.js");
    assert.equal(piExtensionPath(), process.env.MISSION_PI_EXTENSION);
    await buildPiExtension();
    assert.match(await readFile(process.env.MISSION_PI_EXTENSION, "utf8"), /missionControlBuild/);
    assert.deepEqual(await readdir(dir), ["extension.js", "manifest.json", "mcp-server.mjs"]);
  } finally {
    if (prior === undefined) delete process.env.MISSION_PI_EXTENSION; else process.env.MISSION_PI_EXTENSION = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("configured and explicit .js targets not named extension.js are rejected without filesystem changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-output-name-"));
  const prior = process.env.MISSION_PI_EXTENSION;
  const existing = join(dir, "custom.js");
  try {
    await writeFile(existing, "previous");
    for (const output of [existing, join(dir, "absent", "custom.js")]) {
      process.env.MISSION_PI_EXTENSION = output;
      assert.equal(piExtensionPath(), output, "the .js suffix is valid; the builder owns the filename restriction");
      for (const build of [() => buildPiExtension(), () => buildPiExtension(output)]) {
        await assert.rejects(build(), /Pi integration output must be named extension\.js/);
        assert.equal(await readFile(existing, "utf8"), "previous", "rejection preserves existing output bytes");
        assert.deepEqual(await readdir(dir), ["custom.js"], "rejection creates neither parent directories nor artifacts");
      }
    }
  } finally {
    if (prior === undefined) delete process.env.MISSION_PI_EXTENSION; else process.env.MISSION_PI_EXTENSION = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent publishers expose only the old or complete .js bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-publish-"));
  const output = join(dir, "extension.js");
  await writeFile(output, "previous");
  const samples: string[] = [];
  const poll = setInterval(() => { void readFile(output, "utf8").then((text) => samples.push(text)); }, 1);
  try {
    await Promise.all([buildPiExtension(output), buildPiExtension(output)]);
    const final = await readFile(output, "utf8");
    assert.match(final, /missionControlBuild/);
    assert.match(final, /mcpServerPath/);
    assert.ok(samples.length > 0);
    assert.ok(samples.every((text) => text === "previous" || text === final));
    assert.deepEqual(await readdir(dir), ["extension.js", "manifest.json", "mcp-server.mjs"]);
    // Failed resolution leaves the existing artifact untouched.
    const cwd = process.cwd();
    try { process.chdir(dir); await assert.rejects(buildPiExtension(output)); }
    finally { process.chdir(cwd); }
    assert.equal(await readFile(output, "utf8"), final);
  } finally { clearInterval(poll); await rm(dir, { recursive: true, force: true }); }
});

test("different process builds cannot interleave integration publication", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-build-race-"));
  const output = join(dir, "integration", "extension.js");
  const release = join(dir, "release");
  await mkdir(join(dir, "integration"));
  await symlink(join(dir, "integration"), join(dir, "alias"), "dir");
  for (const tag of ["A", "B"]) {
    const source = join(dir, tag); await mkdir(source);
    for (const path of ["src", "scripts", "package.json", "tsconfig.json"]) await cp(resolve(path), join(source, path), { recursive: true });
    await symlink(resolve("node_modules"), join(source, "node_modules"), "dir");
    for (const file of ["src/pi/extension.ts", "src/mcp/server.ts"]) {
      await appendFile(join(source, file), `\nexport const buildRaceTag = ${JSON.stringify(tag)};\n`);
    }
  }
  // Pause A after its directory swap; B must wait until A verifies the complete set.
  const program = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import fs from 'node:fs';
    import promises from 'node:fs/promises';
    const [tag, output, release, builder] = process.argv.slice(1);
    const require = createRequire(import.meta.url);
    const writeFile = promises.writeFile;
    promises.writeFile = async (...args) => {
      await writeFile(...args);
      if (String(args[0]).endsWith('/manifest.json')) console.log('compiled');
    };
    const published = to => {
      if (!String(to).endsWith('/integration')) return;
      fs.writeSync(1, 'publishing\\n');
      if (tag === 'A') {
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(release)) {
          if (Date.now() > deadline) throw new Error('release timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    };
    const addon = ${JSON.stringify(ensureNativeStateLockAddon())};
    const native = require(addon);
    require.cache[addon].exports = Object.create(native, { exchangePaths: { value: (from, to) => {
      native.exchangePaths(from, to); published(to);
    }}});
    syncBuiltinESMExports();
    const { buildPiExtension } = await import(builder);
    await buildPiExtension(output);
  `;
  const launch = (tag: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program,
      tag, tag === "B" ? join(dir, "alias", "extension.js") : output, release,
      new URL("../scripts/build-pi-extension.ts", import.meta.url).href], { cwd: join(dir, tag), stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [], outputLines = createInterface({ input: child.stdout });
    outputLines.on("line", line => lines.push(line));
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
    const completed = once(child, "exit").then(([code]) => ({ code, errors }));
    return { child, lines, outputLines, completed };
  };
  const first = launch("A");
  let second: ReturnType<typeof launch> | undefined;
  const waitFor = async (run: ReturnType<typeof launch>, line: string) => {
    const deadline = Date.now() + 10_000;
    while (!run.lines.includes(line)) {
      if (run.child.exitCode !== null || run.child.signalCode !== null) assert.fail(JSON.stringify(await run.completed));
      assert.ok(Date.now() < deadline, `child did not reach ${line}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await waitFor(first, "publishing");
    verifyPiIntegration(join(dir, "integration"));
    second = launch("B"); await waitFor(second, "compiled");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(second.lines.includes("publishing"), false, "B cannot publish while A holds the output lock");
    await writeFile(release, "");
    for (const run of [first, second]) assert.deepEqual(await run.completed, { code: 0, errors: "" });
    verifyPiIntegration(join(dir, "integration"));
    for (const file of [output, join(dir, "integration", "mcp-server.mjs")]) {
      assert.match(await readFile(file, "utf8"), /buildRaceTag = "B"/);
    }
  } finally {
    await writeFile(release, "");
    for (const run of [first, second]) if (run) { run.child.kill(); await run.completed; run.outputLines.close(); }
    await rm(dir, { recursive: true, force: true });
  }
});
