// A failed/concurrent build may never truncate the machine-wide load target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiExtension } from "../scripts/build-pi-extension.ts";
import { piExtensionPath } from "../src/server/config.ts";

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
    process.env.MISSION_PI_EXTENSION = join(dir, "custom.js");
    assert.equal(piExtensionPath(), process.env.MISSION_PI_EXTENSION);
    await buildPiExtension();
    assert.match(await readFile(process.env.MISSION_PI_EXTENSION, "utf8"), /missionControlBuild/);
    assert.deepEqual(await readdir(dir), ["custom.js"]);
  } finally {
    if (prior === undefined) delete process.env.MISSION_PI_EXTENSION; else process.env.MISSION_PI_EXTENSION = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent publishers expose only the old or complete .js bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-publish-"));
  const output = join(dir, "index.js");
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
    assert.deepEqual(await readdir(dir), ["index.js"]);
    // Failed resolution leaves the existing artifact untouched.
    const cwd = process.cwd();
    try { process.chdir(dir); await assert.rejects(buildPiExtension(output)); }
    finally { process.chdir(cwd); }
    assert.equal(await readFile(output, "utf8"), final);
  } finally { clearInterval(poll); await rm(dir, { recursive: true, force: true }); }
});
