import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
// @ts-expect-error The bundle smoke is a dependency-free JavaScript entrypoint.
import { smokeRepositoryMcp } from "../scripts/smoke-repository-mcp.mjs";

test(
  "standalone repository MCP initialize, exact tools, query and teardown",
  { timeout: 45000 },
  async () => {
    await smokeRepositoryMcp([
      "--import",
      "tsx",
      resolve("src/repository-mcp/server.ts"),
    ]);
  },
);

test("repository MCP bundle dependency graph has no Mission API, Registry or credential path", async () => {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: ["src/repository-mcp/server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const serverInputs = Object.keys(result.metafile!.inputs).filter(
    (path) => path.startsWith("src/") && !path.startsWith("src/shared/"),
  );
  assert.deepEqual(serverInputs.sort(), [
    "src/repository-mcp/server.ts",
    "src/server/inspector/scrub.ts",
    "src/server/workflows/persona-workload/git.ts",
    "src/server/workflows/persona-workload/policy.ts",
    "src/server/workflows/persona-workload/reader.ts",
  ]);
});
