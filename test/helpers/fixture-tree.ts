import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { processesUnder, reapProcessesUnder } from "../temp-root.mjs";

/** `pid command` for each listed process, for an assertion message a person can act on. */
export const processLines = (processes: readonly { pid: number; args: string }[]): string[] =>
  processes.map((entry) => `${entry.pid} ${entry.args}`);

/**
 * Tear down a fixture tree that launched processes this test may not know the pids of.
 *
 * LaunchServices starts a copied app, its helper and a relaunched target outside the test's
 * process tree, and a failure before a handoff is read leaves their pids unknown. Every one of
 * them runs from, or names, the tree, so they are reaped by path before the tree is removed:
 * an app whose bundle was deleted under it otherwise keeps running. Throws, failing the test,
 * if any process or the tree itself survives.
 */
export function teardownFixtureTree(root: string, label = root): void {
  const survivors = reapProcessesUnder([root], { anywhere: true, timeoutMs: 15_000 });
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(processLines(survivors), [], `[${label}] fixture processes survived SIGKILL`);
  assert.deepEqual(processLines(processesUnder([root], { anywhere: true })), [], `[${label}] fixture processes outlived teardown`);
  assert.equal(existsSync(root), false, `[${label}] the fixture tree outlived teardown`);
}
