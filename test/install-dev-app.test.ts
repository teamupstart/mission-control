import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { replaceAppBundle } from "../scripts/app-bundle-swap.mjs";
import { installDevApp, parseArgs } from "../scripts/install-dev-app.mjs";
import { PACKAGED_APP_RELATIVE_PATH } from "../scripts/install-app.mjs";

const HOME = "/Users/someone";
const REPO = "/work/mission-control";
const BUNDLE = join(REPO, PACKAGED_APP_RELATIVE_PATH);

/** A destination that is present, a directory, owned by this account, and writable. */
function goodDirectory(appsDir: string, home: string) {
  return {
    appsDir,
    home,
    exists: true,
    isDirectory: true,
    resolvedPath: appsDir,
    realHome: home,
    ownedByUser: true,
    writable: true,
  };
}

function run(over: Parameters<typeof installDevApp>[0] extends infer T ? Partial<T> : never = {}) {
  const log: string[] = [];
  const swaps: unknown[] = [];
  const created: string[] = [];
  const present = new Set([BUNDLE, join(HOME, "Applications")]);
  const result = installDevApp({
    repoRoot: REPO,
    home: HOME,
    exists: (path: string) => present.has(path),
    makeDirectory: (path: string) => {
      created.push(path);
      present.add(path);
    },
    inspect: (appsDir: string, home = HOME) =>
      present.has(appsDir) ? goodDirectory(appsDir, home) : { ...goodDirectory(appsDir, home), exists: false },
    swap: (input: unknown) => {
      swaps.push(input);
      return { problem: null, elevated: false, stranded: [] };
    },
    pid: 4242,
    log: (line: string) => log.push(line),
    ...over,
  } as Parameters<typeof installDevApp>[0]);
  return { result, log, swaps, created, present };
}

test("the developer install goes to this account's own Applications folder", () => {
  const { result, swaps } = run();
  assert.equal(result.problem, null);
  assert.equal(result.appPath, "/Users/someone/Applications/Mission Control.app");
  assert.deepEqual(swaps, [
    {
      sourceBundle: BUNDLE,
      appPath: "/Users/someone/Applications/Mission Control.app",
      appsDir: "/Users/someone/Applications",
      pid: 4242,
    },
  ]);
});

test("the developer install creates the personal folder but never an arbitrary one", () => {
  const missing = run({
    exists: (path: string) => path === BUNDLE,
    inspect: (appsDir: string, home = HOME) => ({ ...goodDirectory(appsDir, home), exists: false }),
  });
  assert.equal(missing.result.problem, null);
  assert.deepEqual(missing.created, ["/Users/someone/Applications"]);

  // An explicit destination keeps the long-standing rule that it has to exist already: `cp -R`
  // would otherwise invent an app named after a typo.
  const typo = run({
    appsDir: "/opt/aplications",
    exists: (path: string) => path === BUNDLE,
    inspect: (appsDir: string, home = HOME) => ({
      ...goodDirectory(appsDir, home),
      exists: false,
    }),
  });
  assert.match(String(typo.result.problem), /does not exist/);
  assert.deepEqual(typo.created, []);
});

test("the developer install never removes a working app before a replacement is staged", () => {
  // The regression this pins: `make install-app` used to `rm -rf` the installed bundle and only
  // then `cp -R` the new one, so a full disk or an interrupted copy left the account with no
  // Mission Control at all. Routing through the real sibling-staging swap is what removes that
  // window, and the evidence is the ORDER: the new bundle is copied to a hidden sibling first,
  // and the installed app is only ever renamed aside, never deleted, and only after that copy.
  const appPath = "/Users/someone/Applications/Mission Control.app";
  const present = new Set([BUNDLE, appPath, "/Users/someone/Applications"]);
  const operations: string[] = [];
  const { result } = run({
    swap: (input: { sourceBundle: string; appPath: string; appsDir: string; pid: string | number }) =>
      replaceAppBundle({
        ...input,
        platform: "darwin",
        appsDirWritable: true,
        owner: null,
        sweep: () => [],
        ops: {
          copy: (from: string, to: string) => {
            operations.push(`copy ${from} -> ${to}`);
            present.add(to);
          },
          move: (from: string, to: string) => {
            operations.push(`move ${from} -> ${to}`);
            present.delete(from);
            present.add(to);
          },
          remove: (path: string) => {
            operations.push(`remove ${path}`);
            present.delete(path);
          },
          exists: (path: string) => present.has(path),
        },
      }),
  });
  assert.equal(result.problem, null);
  const copied = operations.findIndex((line) => line.startsWith(`copy ${BUNDLE}`));
  const displaced = operations.findIndex((line) => line.startsWith(`move ${appPath}`));
  assert.ok(copied >= 0 && displaced > copied);
  // The installed app is renamed, never deleted, and the app is at its path when the run ends.
  assert.ok(!operations.includes(`remove ${appPath}`));
  assert.ok(present.has(appPath));
});

test("a failed developer copy reports the failure and installs nothing", () => {
  const { result } = run({
    swap: () => ({
      problem: "could not stage the new app: No space left on device. The app is unchanged.",
      elevated: false,
      stranded: [],
    }),
  });
  assert.match(String(result.problem), /No space left on device/);
  assert.equal(result.appPath, null);
});

test("a developer install with nothing packaged says so instead of installing air", () => {
  const { result, swaps } = run({ exists: () => false });
  assert.match(String(result.problem), /there is no packaged app at/);
  assert.match(String(result.problem), /make app/);
  assert.deepEqual(swaps, []);
});

test("the developer install writes no receipt, so the updater stays off for a WIP build", async () => {
  // Proved by absence at the source level rather than by a filesystem check: a work-in-progress
  // build that wrote a receipt would be offered as something to update FROM, and the updater
  // would then rebuild whatever ref that receipt happened to name.
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(new URL("../scripts/install-dev-app.mjs", import.meta.url), "utf8"),
  );
  assert.ok(!source.includes("writeReceipt"));
  assert.ok(!source.includes("install-receipt"));
});

test("developer install arguments parse, and an unknown one stops it", () => {
  assert.deepEqual(parseArgs([]), { options: { appsDir: null }, help: false, problem: null });
  assert.equal(parseArgs(["--apps-dir", "/opt/apps"]).options.appsDir, "/opt/apps");
  assert.equal(parseArgs(["--apps-dir"]).problem, "--apps-dir needs a value");
  assert.equal(parseArgs(["--wat"]).problem, "unknown argument: --wat");
  assert.equal(parseArgs(["--help"]).help, true);
});
