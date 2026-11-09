import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mcpServerPath } from "../src/server/config.ts";
import { OPERATOR_SATELLITES } from "../src/shared/owned-runtime.mjs";

// The updater lets an operator-started satellite keep running through a bundle swap
// (`waitForBundleExit` in `scripts/mac-app-lifecycle.mjs`). That holds only while the list is
// complete and each satellite stays a single self-contained bundle, so both are checked against
// the build `npm run build` actually runs, not against prose. The unit suite runs before any
// build, so each satellite is rebuilt here from its own `package.json` command.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ESBUILD = join(REPO_ROOT, "node_modules", "esbuild", "bin", "esbuild");

/**
 * Bundles the build emits beside the satellites that only Mission Control itself launches, so
 * the updater waits on them like any other owned work. A new entry point here needs a reason;
 * one an operator's own agent configuration runs belongs in `OPERATOR_SATELLITES` instead.
 */
const DAEMON_LAUNCHED: Record<string, string> = {
  "dist/satellites/codex-hook.mjs": "dispatched Codex sessions' -c hooks.* overrides (codexHookPath)",
  "dist/satellites/resume-guard.mjs": "the terminal resume guard of sessions the daemon launched",
  "dist/satellites/resident-mcp-launcher.mjs": "resident MCP servers the daemon launches",
};

/** Every `esbuild ... --outfile=dist/{satellites,mcp}/*.mjs` command in the build scripts. */
function satelliteBuilds(): Map<string, string[]> {
  const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {scripts: Record<string, string>}).scripts;
  const builds = new Map<string, string[]>();
  for (const [name, script] of Object.entries(scripts)) {
    if (!name.startsWith("build")) continue;
    for (const command of script.split("&&").map((part) => part.trim())) {
      const outfile = /--outfile=(dist\/(?:satellites|mcp)\/[^\s]+\.mjs)/.exec(command)?.[1];
      if (!command.startsWith("esbuild ") || !outfile) continue;
      assert.doesNotMatch(command, /["']/, `${outfile} is built with plain arguments this test can replay`);
      assert.ok(!builds.has(outfile), `${outfile} is built once`);
      builds.set(outfile, command.split(/\s+/).slice(1));
    }
  }
  return builds;
}

test("every satellite entry point the build emits is either operator-registered or daemon-launched", () => {
  const emitted = [...satelliteBuilds().keys()].sort();
  const operator = Object.values(OPERATOR_SATELLITES);
  for (const path of operator) assert.ok(emitted.includes(path), `${path} is an emitted build output`);
  for (const path of Object.keys(DAEMON_LAUNCHED)) assert.ok(emitted.includes(path), `${path} is an emitted build output`);
  for (const path of operator) assert.ok(!(path in DAEMON_LAUNCHED), `${path} is not also daemon-only`);
  assert.deepEqual(emitted, [...operator, ...Object.keys(DAEMON_LAUNCHED)].sort(),
    "a new satellite must be classified: add it to OPERATOR_SATELLITES or to DAEMON_LAUNCHED with its reason");
});

test("the daemon points sessions at the same MCP server the operator list names", () => {
  // `mcpServerPath` keeps a literal specifier so `scripts/smoke-bundles.mjs` can resolve it from
  // the built daemon bundle; this pins that literal to the list instead of keeping a second one.
  for (const prefix of ["MISSION_", "FLEET_", "HARNESS_"]) delete process.env[`${prefix}MCP_SERVER`];
  assert.equal(mcpServerPath(), join(REPO_ROOT, OPERATOR_SATELLITES.mcpServer));
});

test("each operator satellite bundles to one file that imports only Node builtins and never opens the database", async (t) => {
  const builds = satelliteBuilds();
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const root = mkdtempSync(join(tmpdir(), "operator-satellites-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const [name, path] of Object.entries(OPERATOR_SATELLITES)) {
    await t.test(path, () => {
      const outfile = join(root, `${name}.mjs`);
      const metafile = join(root, `${name}.json`);
      const args = builds.get(path)!.filter((arg) => !arg.startsWith("--outfile="));
      // The installed `esbuild` bin is either the native binary or a Node shim; both execute directly.
      execFileSync(ESBUILD, [...args, `--outfile=${outfile}`, `--metafile=${metafile}`, "--log-level=error"], {cwd: REPO_ROOT, stdio: "pipe"});
      const meta = JSON.parse(readFileSync(metafile, "utf8")) as {outputs: Record<string, {imports: Array<{path: string; kind: string; external?: boolean}>}>};
      const outputs = Object.keys(meta.outputs);
      assert.equal(outputs.length, 1, "a single output file, so no chunk is loaded from the bundle later");
      for (const imported of meta.outputs[outputs[0]!]!.imports) {
        // A relative or dynamic import would read the bundle after a swap renamed it away.
        assert.notEqual(imported.kind, "dynamic-import", `${path} has no dynamic import (${imported.path})`);
        assert.ok(imported.external && builtins.has(imported.path), `${path} imports only Node builtins, not ${imported.path}`);
        assert.notEqual(imported.path, "node:sqlite", `${path} never opens the state database`);
      }
      const text = readFileSync(outfile, "utf8");
      // The metafile records only imports esbuild resolves statically; `import(variable)` and a
      // created `require` never appear there, and either could load a file from the bundle.
      // Matched against code, not the comment lines esbuild carries over from dependencies:
      // Zod 4 ships one that describes an `import()` in its type declarations.
      const code = text.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join("\n");
      assert.doesNotMatch(code, /\bimport\s*\(/, `${path} has no dynamic import of any kind`);
      assert.doesNotMatch(text, /\bcreateRequire\b/, `${path} creates no require that could load a sibling module`);
      // A path resolved from the bundle's own location would read a sibling file the same way.
      assert.doesNotMatch(text, /import\.meta\.(?:url|dirname|filename)/, `${path} resolves nothing beside itself`);
      assert.doesNotMatch(text, /state-lock\.node|harness\.db/, `${path} never opens the state database`);
    });
  }
});
