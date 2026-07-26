import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ENSEMBLE_STRATEGY_IDS } from "../src/shared/ensemble.ts";
import { ENSEMBLE_STRATEGIES } from "../src/server/ensembles/strategies/index.ts";

/**
 * What is at stake: a packaged build must launch Claude and Codex ensemble members that can reach
 * the `submit_ensemble_result` MCP tool, and it must do so without any of Phase 8's test-only
 * strategy fixtures reaching production. mission-mcp.test.ts pins the packaged resolver path and
 * scripts/smoke-bundles.mjs pins that the built bundle actually resolves it; this suite pins the
 * two ensemble-specific packaging invariants: the un-asared external-bundle shipping that lets an
 * external node read the MCP server, and that no test strategy id or fixture is on the production
 * path.
 */

function repoFile(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("electron-builder keeps asar off and ships the external MCP bundle, satellites and skills as plain files", () => {
  const yml = repoFile("electron-builder.yml");
  // asar MUST stay off: the agents launch dist/mcp/server.mjs and dist/satellites/*.mjs with an
  // external node that cannot read inside an archive, and skills/ is reached through a symlink.
  assert.match(yml, /^asar:\s*false\s*$/m, "asar must be false so the launched MCP bundle is a plain file");
  assert.match(yml, /-\s*dist\/\*\*\/\*/, "the built bundles (incl. dist/mcp/server.mjs) are shipped");
  assert.match(yml, /-\s*skills\/\*\*\/\*/, "skills ship as source for the symlink");
});

test("only production strategy ids are on the runtime path - no test fixture is required at runtime", () => {
  // The enabled production strategies, and nothing a Phase 8 fixture invented. If a test id ever
  // leaked into the shared tuple, a packaged build would offer an unrunnable strategy - which is
  // why this list is edited deliberately when a real strategy ships, not widened to a count.
  assert.deepEqual([...ENSEMBLE_STRATEGY_IDS], ["best_of_n", "consensus", "panel_vote"]);
  assert.deepEqual(Object.keys(ENSEMBLE_STRATEGIES).sort(), ["best_of_n", "consensus", "panel_vote"]);
  for (const id of ["fixed_matrix", "successive_halving", "pairwise", "panel", "synthesis"]) {
    assert.equal(
      (ENSEMBLE_STRATEGY_IDS as readonly string[]).includes(id),
      false,
      `test strategy ${id} must never be in the production tuple`,
    );
  }
});

test("no production source module imports a Phase 8 test strategy fixture", () => {
  // The test strategies live under test/ only. A src/ import of them would drag test-only code into
  // a packaged bundle, which is exactly what "no source-only/test fixture at runtime" forbids.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        if (repoFile(rel).includes("ensemble-strategy-fixtures")) offenders.push(rel);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, [], "test strategy fixtures must not be imported from src/");
});
