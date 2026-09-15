import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN_BUNDLE = join(REPO_ROOT, "dist", "main", "index.cjs");
const HARNESS = join(REPO_ROOT, "test", "helpers", "electron-entry-harness.cjs");

/**
 * Build the entry point's bundle from the CURRENT source, every run, before anything reads it.
 *
 * Unconditional on purpose. `npm test` builds nothing and a single-file invocation runs no npm
 * lifecycle, so an artifact left by an earlier build is whatever `src/main/index.ts` used to
 * be. Skipping the build when one merely EXISTS is the failure this guards: a wiring regression
 * in the source would be tested against the previous bundle and pass, which turns the whole
 * file into a test of history rather than of the change in front of it.
 *
 * `npm run build:main` rather than an esbuild command spelled out here, so the bundle under
 * test is produced by the same command that produces the shipped one and cannot drift from it.
 */
function buildMainBundle(): void {
  const built = spawnSync("npm", ["run", "build:main"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  assert.equal(built.status, 0, `could not build the main bundle: ${built.stderr}`);
  assert.ok(existsSync(MAIN_BUNDLE), `the build did not produce ${MAIN_BUNDLE}`);
}
buildMainBundle();

const COMMIT = "a".repeat(40);
/** The one path `install-identity.ts` will ever redirect away FROM. */
const SYSTEM_BUNDLE = "/Applications/Mission Control.app";

interface Observed {
  app: string[];
  spawn: Array<{ command: string; args: string[] }>;
  logged: string[];
  loadError: string | null;
}

/**
 * A fixture home holding a real personal bundle, and a receipt that names it.
 *
 * The bundle has to exist on disk and carry a matching identity, because the classifier refuses
 * a redirect to anything it cannot confirm. That is the point: the entry point is being driven
 * over the real receipt read and the real classification, with only Electron and the subprocess
 * replaced.
 */
function fixture(): { home: string; state: string; personal: string } {
  const root = mkdtempSync(join(tmpdir(), "mission-entry-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const personal = join(home, "Applications", "Mission Control.app");
  mkdirSync(join(personal, "Contents", "Resources", "app"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(personal, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>`,
  );
  writeFileSync(
    join(personal, "Contents", "Resources", "app", "package.json"),
    JSON.stringify({ name: "mission-control", version: "1.2.3", missionCommit: COMMIT }),
  );
  writeFileSync(
    join(state, "install-receipt.json"),
    JSON.stringify({
      schema: 1,
      repo: CANONICAL_REPO,
      releaseTag: "v1.2.3",
      installedVersion: "1.2.3",
      installedCommit: COMMIT,
      sourceClone: join(state, "app-src"),
      appPath: personal,
      installedAt: "2026-09-14T00:00:00.000Z",
    }),
  );
  return { home, state, personal };
}

/** Load the built entry point under a given running bundle, and report what it did. */
function runEntry(
  runningBundle: string,
  env: Record<string, string> = {},
): { observed: Observed; fixture: ReturnType<typeof fixture> } {
  const paths = fixture();
  const result = spawnSync(process.execPath, [HARNESS], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: paths.home,
      MISSION_HOME: paths.state,
      HARNESS_MAIN_BUNDLE: MAIN_BUNDLE,
      HARNESS_APP_PATH: join(runningBundle, "Contents", "Resources", "app"),
      ...env,
    },
  });
  assert.equal(result.status, 0, `harness failed: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const observed = JSON.parse(line) as Observed;
  assert.equal(observed.loadError, null, `the entry point threw: ${observed.loadError}`);
  return { observed, fixture: paths };
}

test("the entry point hands a system launch to the personal app before taking any lock", () => {
  // The real `src/main/index.ts`, loaded as the built bundle, with only Electron and the child
  // process replaced. Everything between - reading the receipt, classifying the running bundle,
  // choosing the executable, building the argv, and the ordering against the single-instance
  // lock - is production code. This is what the seam tests cannot assert: the entry point could
  // stop calling `startPackagedShell`, or hand it the wrong identity, and they would still pass.
  const { observed, fixture: paths } = runEntry(SYSTEM_BUNDLE);

  assert.deepEqual(observed.spawn, [{ command: "/usr/bin/open", args: [paths.personal] }]);
  // Never asks for the lock. The app it just opened would lose it, quit, and hand the person
  // straight back to the copy they were being moved off.
  assert.ok(!observed.app.includes("requestSingleInstanceLock"));
  assert.deepEqual(observed.app, ["exit(0)", "quit"]);
});

test("a failed hand-over leaves the entry point running and asking for the lock", () => {
  // Not fatal, on purpose: the alternative is leaving somebody with no Mission Control at all.
  const { observed, fixture: paths } = runEntry(SYSTEM_BUNDLE, {
    HARNESS_OPEN_STATUS: "1",
    HARNESS_OPEN_STDERR: "The application cannot be opened.\n",
  });

  assert.deepEqual(observed.spawn, [{ command: "/usr/bin/open", args: [paths.personal] }]);
  assert.ok(observed.app.includes("requestSingleInstanceLock"));
  assert.ok(!observed.app.some((call) => call.startsWith("exit")));
  assert.equal(observed.logged.length, 1);
  assert.match(observed.logged[0]!, /could not open the installed app at/);
  assert.match(observed.logged[0]!, /The application cannot be opened\./);
});

test("a hand-over the subprocess could not even start is survived the same way", () => {
  // `spawnSync` reports a missing binary or a timeout through `error`, never through `status`.
  const { observed } = runEntry(SYSTEM_BUNDLE, {
    HARNESS_OPEN_ERROR: "spawnSync /usr/bin/open ETIMEDOUT",
  });

  assert.ok(observed.app.includes("requestSingleInstanceLock"));
  assert.ok(!observed.app.some((call) => call.startsWith("exit")));
  assert.match(observed.logged[0]!, /ETIMEDOUT/);
});

test("the entry point launches nothing when it is already the installed app", () => {
  // Running FROM the personal bundle the receipt names. An ordinary managed launch, and the one
  // that must never invoke Launch Services: doing so would reopen itself on every start.
  const paths = fixture();
  const result = spawnSync(process.execPath, [HARNESS], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: paths.home,
      MISSION_HOME: paths.state,
      HARNESS_MAIN_BUNDLE: MAIN_BUNDLE,
      HARNESS_APP_PATH: join(paths.personal, "Contents", "Resources", "app"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Observed;

  assert.equal(observed.loadError, null);
  assert.deepEqual(observed.spawn, []);
  assert.deepEqual(observed.app, ["requestSingleInstanceLock"]);
  rmSync(paths.home, { recursive: true, force: true });
});

test("an unmanaged entry point is untouched by any of this", () => {
  // No receipt at all, which is every install made outside the managed path.
  const root = mkdtempSync(join(tmpdir(), "mission-entry-bare-"));
  const result = spawnSync(process.execPath, [HARNESS], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      MISSION_HOME: join(root, "state"),
      HARNESS_MAIN_BUNDLE: MAIN_BUNDLE,
      HARNESS_APP_PATH: join(SYSTEM_BUNDLE, "Contents", "Resources", "app"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Observed;

  assert.equal(observed.loadError, null);
  assert.deepEqual(observed.spawn, []);
  assert.deepEqual(observed.app, ["requestSingleInstanceLock"]);
  rmSync(root, { recursive: true, force: true });
});
