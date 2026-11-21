import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

/**
 * Leaving the conversation rail's Agents tab is remembered.
 *
 * Under Chip and popover the rail offers Agents only while the session has background agents,
 * and the operator can switch to Nested sub-cards while the conversation is open. Either way
 * the tab can be withdrawn while it is selected. The rail then reads Activity, and when Agents
 * is offered again it must STAY on Activity rather than jump back to a tab the reader left.
 *
 * That is a state transition across renders - a click, a withdrawal and a return - which a
 * static render cannot run and which the browser spec cannot reach, because no in-app route
 * changes the setting while a conversation stays mounted. So the real rail and the real
 * `useRailTab` its owner holds the tab in are bundled and mounted in Electron, the way
 * `workflow-builder-electron.test.ts` mounts the workflow canvas.
 */

const require = createRequire(import.meta.url);

/** Same backstop the other Electron tests use: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;

interface Step {
  selected: string | null;
  tabs: string[];
}

let result: { errors: string[]; steps: Record<string, Step>; clock: { before: string; after: string } | null };

before(() => {
  assertElectronGuiLaunchAllowed();
  const dir = mkdtempSync(join(tmpdir(), "mission-rail-tab-reset-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-rail-tab-reset-profile-"));
  try {
    const bundle = join(dir, "rail.js");
    execFileSync(require.resolve("esbuild/bin/esbuild"), [
      fileURLToPath(new URL("fixtures/rail-tab-reset-mount.tsx", import.meta.url)),
      "--bundle",
      "--platform=browser",
      "--format=iife",
      "--jsx=automatic",
      "--define:process.env.NODE_ENV=\"development\"",
      `--outfile=${bundle}`,
    ], { encoding: "utf8" });
    const html = join(dir, "index.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="root"></div><div id="folded"></div><script src="./rail.js"></script>');
    const electron = require("electron") as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/rail-tab-reset-browser.cjs", import.meta.url)),
      html,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
    result = JSON.parse(output.trim()) as typeof result;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

test("a withdrawn Agents tab leaves the rail on Activity, and its return does not pull the rail back", () => {
  assert.deepEqual(result.errors, []);
  const { mounted, chosen, withdrawn, reoffered } = result.steps;
  // Offered from the start, and the rail opens on Activity.
  assert.deepEqual(mounted, { selected: "Activity", tabs: ["Activity", "Yours", "Agents"] });
  // The reader picks Agents.
  assert.deepEqual(chosen, { selected: "Agents", tabs: ["Activity", "Yours", "Agents"] });
  // Withdrawn while selected: two tabs, on Activity.
  assert.deepEqual(withdrawn, { selected: "Activity", tabs: ["Activity", "Yours"] });
  // Offered again: the tab is back, and the rail is still on Activity.
  assert.deepEqual(reoffered, { selected: "Activity", tabs: ["Activity", "Yours", "Agents"] });
});

test("a running agent's elapsed time keeps counting on the Agents tab while the rail is folded wide", () => {
  // Folded wide, then narrowed: the stylesheet ignores the fold and shows the list, which React
  // cannot see. The clock must therefore not stop on `collapsed`, or the time freezes on screen.
  assert.deepEqual(result.errors, []);
  assert.ok(result.clock, "the folded rail was not measured");
  const { before, after } = result.clock;
  assert.match(before, /^(\d+m )?\d+s · Grep · 41k tokens$/);
  assert.match(after, /^(\d+m )?\d+s · Grep · 41k tokens$/);
  assert.notEqual(after, before, `the elapsed time stood still at "${before}"`);
});
