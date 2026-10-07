import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What is at stake: every Mission Control tool call a packaged-app agent makes.
//
// The packaged daemon hands agents the Electron binary with `ELECTRON_RUN_AS_NODE=1` as the
// MCP server's runtime, and the agent starts it in its own checkout. That only works while
// Electron still honours run-as-node (a hardening fuse can switch it off) and while the Node
// inside Electron is at least what `build:mcp` compiles the bundle for. A checkout pinning an
// old Node must change neither.

const home = mkdtempSync(join(tmpdir(), "mission-mcp-runtime-electron-"));
process.env.HARNESS_HOME = join(home, "state");

const { resolveMissionMcpRuntime } = await import("../src/server/mission-mcp.ts");

const require = createRequire(import.meta.url);

test("the Electron binary runs the MCP runtime as Node, new enough for the bundle, in a pinned checkout", () => {
  const electron = require("electron") as string;
  const runtime = resolveMissionMcpRuntime(electron);
  assert.deepEqual(runtime.env, { ELECTRON_RUN_AS_NODE: "1" });

  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    scripts: Record<string, string>;
  };
  const target = /--target=node(\d+)/.exec(pkg.scripts["build:mcp"] ?? "");
  assert.ok(target, "build:mcp names a node target");

  const checkout = join(home, "upstart_web");
  mkdirSync(checkout);
  writeFileSync(join(checkout, ".tool-versions"), "nodejs 18.20.8\n");
  try {
    const out = execFileSync(
      runtime.command,
      [
        "-e",
        "process.stdout.write(JSON.stringify({ node: process.versions.node, electron: process.versions.electron, crypto: typeof globalThis.crypto?.randomUUID }))",
      ],
      { cwd: checkout, env: { ...process.env, ...runtime.env }, encoding: "utf8", timeout: 30_000 },
    );
    const reading = JSON.parse(out) as { node: string; electron?: string; crypto: string };
    assert.ok(reading.electron, "the child is Electron in node mode, not a node from PATH");
    assert.ok(
      Number.parseInt(reading.node, 10) >= Number(target[1]),
      `Electron's Node ${reading.node} is older than the bundle's node${target[1]} target`,
    );
    assert.equal(reading.crypto, "function");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
