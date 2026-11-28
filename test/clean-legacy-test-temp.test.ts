import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-root.mjs";

// scripts/clean-legacy-test-temp.mjs, driven end to end against a fixture temp dir and a
// fixture literal source, so its deletion safeguards are proven on paths this file owns.

const CLEANER = fileURLToPath(new URL("../scripts/clean-legacy-test-temp.mjs", import.meta.url));
const DAY = 24 * 60 * 60_000;
const lsofAvailable = spawnSync("lsof", ["-v"], { stdio: "ignore" }).error === undefined;

function age(path: string, days: number): void {
  const when = new Date(Date.now() - days * DAY);
  utimesSync(path, when, when);
}

/** A leaked fixture: a directory, a file and a subdirectory with a file, all `days` old. */
function fixture(tmp: string, name: string, days = 4): string {
  const root = join(tmp, name);
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(join(root, "state.json"), "{}");
  writeFileSync(join(root, "repo", "HEAD"), "ref: refs/heads/main\n");
  for (const path of [join(root, "repo", "HEAD"), join(root, "repo"), join(root, "state.json"), root]) age(path, days);
  return root;
}

function run(tmp: string, source: string, ...extra: string[]) {
  return spawnSync(process.execPath, [CLEANER, "--tmp", tmp, "--source", source, ...extra], { encoding: "utf8" });
}

test("the legacy cleaner removes only stale literal-named fixtures and keeps every protected entry", { skip: !lsofAvailable && "lsof is not installed", timeout: 120_000 }, async (t) => {
  const tmp = tempDir("legacy-cleaner-tmp-");
  const source = tempDir("legacy-cleaner-source-");
  writeFileSync(join(source, "fixtures.ts"), [
    '"mission-legacy-stale-"', '"mission-legacy-recent-"', '"mission-legacy-deep-"',
    '"mission-legacy-running-"', '"mission-legacy-open-"', '"mission-control-agent-"', '"mission-legacy-link-"',
  ].map((literal) => `export const x = mkdtempSync(join(tmpdir(), ${literal}));`).join("\n"));

  const stale = fixture(tmp, "mission-legacy-stale-AbC123");
  const recentTop = fixture(tmp, "mission-legacy-recent-AbC123");
  writeFileSync(join(recentTop, "state.json"), "{\"touched\":true}"); // level one changed today
  age(recentTop, 4);
  const recentDeep = fixture(tmp, "mission-legacy-deep-AbC123");
  writeFileSync(join(recentDeep, "repo", "HEAD"), "changed today\n"); // level two changed today
  const running = fixture(tmp, "mission-legacy-running-AbC123");
  const open = fixture(tmp, "mission-legacy-open-AbC123");
  const agent = fixture(tmp, "mission-control-agent-state1");
  const unrelated = fixture(tmp, "somebody-elses-AbC123");
  const notMkdtemp = fixture(tmp, "mission-legacy-stale-toolong1");
  const target = fixture(tempDir("legacy-cleaner-elsewhere-"), "target");
  symlinkSync(target, join(tmp, "mission-legacy-link-AbC123"));

  // A process whose command line names one entry, and one holding a file open inside another.
  // The second gets its path through the environment, so only lsof can see it.
  const holders: ChildProcess[] = [
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "mission-legacy-running-AbC123"], { stdio: "ignore" }),
    spawn(process.execPath, ["-e", "require('node:fs').openSync(process.env.HOLD, 'r'); process.stdout.write('open'); setTimeout(() => {}, 120000)"], {
      stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, HOLD: join(open, "state.json") },
    }),
  ];
  t.after(() => {
    for (const holder of holders) holder.kill("SIGKILL");
  });
  await new Promise((resolve) => holders[1]!.stdout!.once("data", resolve));
  age(open, 4);

  const caches = [join(tmp, "playwright-transform-cache-501"), join(tmp, "node-compile-cache")];
  for (const cache of caches) {
    mkdirSync(join(cache, "ab"), { recursive: true });
    writeFileSync(join(cache, "ab", "old.js"), "old");
    writeFileSync(join(cache, "ab", "fresh.js"), "fresh");
    age(join(cache, "ab", "old.js"), 10);
  }

  const dry = run(tmp, source);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would remove 1 leaked fixture dir\(s\)/);
  assert.match(dry.stdout, /mission-legacy-stale-XXXXXX {2}1 dir\(s\)/);
  assert.match(dry.stdout, /kept: 2 changed in the last 3 day\(s\), 1 named by a running process, 1 open in lsof/);
  assert.match(dry.stdout, /Nothing was deleted/);
  assert.ok(existsSync(stale), "a dry run deleted a fixture");
  for (const cache of caches) assert.ok(existsSync(join(cache, "ab", "old.js")), "a dry run pruned a cache");

  const real = run(tmp, source, "--delete");
  assert.equal(real.status, 0, real.stderr);
  assert.equal(existsSync(stale), false, "the stale literal-named fixture survived --delete");
  for (const kept of [recentTop, recentDeep, running, open, agent, unrelated, notMkdtemp, join(tmp, "mission-legacy-link-AbC123")]) {
    assert.ok(existsSync(kept), `${kept} was removed`);
  }
  assert.ok(existsSync(join(target, "repo", "HEAD")), "the symlink's target was touched");
  for (const cache of caches) {
    assert.equal(existsSync(join(cache, "ab", "old.js")), false, `${cache} kept a stale file`);
    assert.ok(existsSync(join(cache, "ab", "fresh.js")), `${cache} lost a fresh file`);
  }
  assert.deepEqual(readdirSync(tmp).sort(), [
    "mission-control-agent-state1", "mission-legacy-deep-AbC123", "mission-legacy-link-AbC123",
    "mission-legacy-open-AbC123", "mission-legacy-recent-AbC123", "mission-legacy-running-AbC123",
    "mission-legacy-stale-toolong1", "node-compile-cache", "playwright-transform-cache-501", "somebody-elses-AbC123",
  ]);
});
