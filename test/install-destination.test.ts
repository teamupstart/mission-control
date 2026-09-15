import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SYSTEM_APPS_DIR } from "../scripts/app-bundle-swap.mjs";
import {
  classifyAppsDir,
  describeInstallScope,
  inspectInstallDirectory,
  installDirectoryProblem,
  mayCreateAppsDir,
  receiptAppsDir,
  resolveInstallDestination,
  userAppsDir,
} from "../scripts/install-destination.mjs";

const HOME = "/Users/someone";
const USER_DIR = join(HOME, "Applications");

test("a fresh install with no arguments goes to this account's own Applications folder", () => {
  assert.deepEqual(resolveInstallDestination({ home: HOME }), {
    appsDir: USER_DIR,
    installScope: "user",
    problem: null,
  });
  // Plural, and derived from the account's home rather than spelled with a literal tilde that
  // nothing expands.
  assert.equal(userAppsDir(HOME), "/Users/someone/Applications");
});

test("the fixed system destination is never the personal default", () => {
  // Two constants that used to be one. Widening the default must not widen what an
  // administrator prompt is allowed to write to.
  assert.equal(SYSTEM_APPS_DIR, "/Applications");
  assert.notEqual(userAppsDir(HOME), SYSTEM_APPS_DIR);
  assert.deepEqual(resolveInstallDestination({ scope: "system", home: HOME }), {
    appsDir: "/Applications",
    installScope: "system",
    problem: null,
  });
  assert.deepEqual(resolveInstallDestination({ scope: "user", home: HOME }), {
    appsDir: USER_DIR,
    installScope: "user",
    problem: null,
  });
});

test("--apps-dir stays a transport override and never becomes a system opt-out", () => {
  // Every update helper ever shipped forwards the receipt's own directory through --apps-dir.
  // Reading that as consent would convert every legacy install into a deliberate system one
  // during the very update that is supposed to leave it eligible to move.
  const legacy = { appPath: "/Applications/Mission Control.app" };
  assert.deepEqual(
    resolveInstallDestination({ appsDir: "/Applications", receipt: legacy, home: HOME }),
    { appsDir: "/Applications", installScope: null, problem: null },
  );
  // Even with no receipt at all, the system directory alone records nothing: absent reads as
  // legacy, which is the eligible state, and only `--scope system` says otherwise.
  assert.deepEqual(resolveInstallDestination({ appsDir: "/Applications", home: HOME }), {
    appsDir: "/Applications",
    installScope: null,
    problem: null,
  });
  assert.equal(classifyAppsDir("/Applications", HOME), null);
});

test("an explicit policy already in the receipt survives the next update", () => {
  const system = { appPath: "/Applications/Mission Control.app", installScope: "system" as const };
  assert.deepEqual(
    resolveInstallDestination({ appsDir: "/Applications", receipt: system, home: HOME }),
    { appsDir: "/Applications", installScope: "system", problem: null },
  );
  const personal = { appPath: join(USER_DIR, "Mission Control.app"), installScope: "user" as const };
  assert.deepEqual(resolveInstallDestination({ appsDir: USER_DIR, receipt: personal, home: HOME }), {
    appsDir: USER_DIR,
    installScope: "user",
    problem: null,
  });
});

test("an ordinary reinstall stays where the receipt says, and an unknown override is custom", () => {
  // Relocation is an update-time decision. A repeated `make install` must not move an app out
  // from under somebody who never asked it to.
  const legacy = { appPath: "/Applications/Mission Control.app" };
  assert.deepEqual(resolveInstallDestination({ receipt: legacy, home: HOME }), {
    appsDir: "/Applications",
    installScope: null,
    problem: null,
  });
  assert.deepEqual(resolveInstallDestination({ appsDir: "/opt/apps", home: HOME }), {
    appsDir: "/opt/apps",
    installScope: "custom",
    problem: null,
  });
  assert.equal(receiptAppsDir(legacy), "/Applications");
  assert.equal(receiptAppsDir({ appPath: "relative/Mission Control.app" }), null);
  assert.equal(receiptAppsDir(null), null);
});

test("conflicting or unknown destination arguments are refused before any mutation", () => {
  const both = resolveInstallDestination({ scope: "user", appsDir: "/opt/apps", home: HOME });
  assert.equal(both.appsDir, null);
  assert.match(String(both.problem), /--scope and --apps-dir cannot be combined/);
  const unknown = resolveInstallDestination({ scope: "everyone", home: HOME });
  assert.equal(unknown.appsDir, null);
  assert.match(String(unknown.problem), /--scope must be user or system/);
});

test("only the canonical personal folder is created for the person installing", () => {
  assert.equal(mayCreateAppsDir({ appsDir: USER_DIR, home: HOME }), true);
  assert.equal(mayCreateAppsDir({ appsDir: "/Applications", home: HOME }), false);
  assert.equal(mayCreateAppsDir({ appsDir: "/opt/apps", home: HOME }), false);
  // Absence of the personal folder is not a problem to report: the install makes one. Absence
  // of any other destination still is, because `cp -R` would invent an app named after a typo.
  assert.equal(
    installDirectoryProblem({ appsDir: USER_DIR, home: HOME, exists: false, isDirectory: false }),
    null,
  );
  assert.match(
    String(
      installDirectoryProblem({
        appsDir: "/opt/apps",
        home: HOME,
        exists: false,
        isDirectory: false,
      }),
    ),
    /does not exist/,
  );
});

test("a personal destination that is not really a personal destination is refused", () => {
  // The case that matters: `~/Applications` symlinked at `/Applications` would turn every
  // "personal" install into a system install, silently, and hand the privileged path a
  // destination nobody opted into.
  const aliased = installDirectoryProblem({
    appsDir: USER_DIR,
    home: HOME,
    realHome: HOME,
    exists: true,
    isDirectory: true,
    resolvedPath: "/Applications",
  });
  assert.match(String(aliased), /resolves to \/Applications/);
  assert.match(String(aliased), /--scope system/);
  // Another account's folder resolves outside this home too.
  assert.match(
    String(
      installDirectoryProblem({
        appsDir: USER_DIR,
        home: HOME,
        realHome: HOME,
        exists: true,
        isDirectory: true,
        resolvedPath: "/Users/someone-else/Applications",
      }),
    ),
    /outside this account's home/,
  );
  // A home that is itself a symlink - which is every temp-directory home on macOS, where /var
  // is served as /private/var - is ordinary and must still be accepted.
  assert.equal(
    installDirectoryProblem({
      appsDir: "/var/folders/x/home/Applications",
      home: "/var/folders/x/home",
      realHome: "/private/var/folders/x/home",
      exists: true,
      isDirectory: true,
      resolvedPath: "/private/var/folders/x/home/Applications",
    }),
    null,
  );
});

test("the shared system folder is accepted as macOS actually ships it", () => {
  // `/Applications` is root-owned on every Mac and is not writable by a non-administrator
  // account. Both of those are the ORDINARY case there, and refusing either one broke the two
  // paths that matter most: `--scope system`, and every managed install that has always lived
  // there and is updated through the old helper's `--apps-dir /Applications`. The swap owns
  // this decision - it attempts the plain rename and asks for administrator authorization only
  // once that has proved it was needed - so the destination check must not pre-empt it.
  assert.equal(
    installDirectoryProblem({
      appsDir: SYSTEM_APPS_DIR,
      home: HOME,
      exists: true,
      isDirectory: true,
      ownedByUser: false,
      writable: false,
    }),
    null,
  );
  // And it is still a directory that has to be there and be one.
  assert.match(
    String(
      installDirectoryProblem({
        appsDir: SYSTEM_APPS_DIR,
        home: HOME,
        exists: true,
        isDirectory: false,
        ownedByUser: false,
      }),
    ),
    /is not a directory/,
  );
});

test("everywhere but the system folder, an unwritable destination is a dead end", () => {
  // There is no elevation to fall back on: `privilegedBundleSwapCommand` authorizes the exact
  // system product bundle and nothing else. So an unwritable personal or custom destination
  // fails however long you wait, and saying so before the copy is the whole improvement.
  for (const appsDir of [USER_DIR, "/opt/apps"]) {
    const problem = String(
      installDirectoryProblem({ appsDir, home: HOME, exists: true, isDirectory: true, writable: false }),
    );
    assert.match(problem, /is not writable by this account/);
    assert.ok(!problem.includes("administrator"));
  }
  // A custom directory somebody else owns was named deliberately by whoever ran the command,
  // so ownership alone is not this check's business outside the personal folder.
  assert.equal(
    installDirectoryProblem({
      appsDir: "/opt/apps",
      home: HOME,
      exists: true,
      isDirectory: true,
      ownedByUser: false,
    }),
    null,
  );
});

test("a file, a foreign owner, and an unwritable folder each stop the install with a reason", () => {
  assert.match(
    String(
      installDirectoryProblem({ appsDir: USER_DIR, home: HOME, exists: true, isDirectory: false }),
    ),
    /is not a directory/,
  );
  assert.match(
    String(
      installDirectoryProblem({
        appsDir: USER_DIR,
        home: HOME,
        exists: true,
        isDirectory: true,
        ownedByUser: false,
      }),
    ),
    /owned by another account/,
  );
  // Never a reason to elevate or to fall back to the system folder: an unwritable personal
  // destination is an actionable error and nothing else.
  const unwritable = String(
    installDirectoryProblem({
      appsDir: USER_DIR,
      home: HOME,
      exists: true,
      isDirectory: true,
      writable: false,
    }),
  );
  assert.match(unwritable, /is not writable by this account/);
  assert.ok(!unwritable.includes("administrator"));
});

test("the destination inspector reads the real filesystem, spaces and symlinks included", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-destination-"));
  try {
    const home = join(root, "a home with spaces");
    mkdirSync(join(home, "Applications", "nested"), { recursive: true });
    const facts = inspectInstallDirectory(join(home, "Applications"), home);
    assert.equal(facts.exists, true);
    assert.equal(facts.isDirectory, true);
    assert.equal(facts.ownedByUser, true);
    assert.equal(facts.writable, true);
    assert.equal(installDirectoryProblem(facts), null);

    // A file standing where the folder should be.
    const fileHome = join(root, "file-home");
    mkdirSync(fileHome);
    writeFileSync(join(fileHome, "Applications"), "not a folder");
    assert.match(
      String(installDirectoryProblem(inspectInstallDirectory(join(fileHome, "Applications"), fileHome))),
      /is not a directory/,
    );

    // A personal folder symlinked somewhere outside the home.
    const linkHome = join(root, "link-home");
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    mkdirSync(linkHome);
    symlinkSync(join(root, "elsewhere"), join(linkHome, "Applications"));
    assert.match(
      String(installDirectoryProblem(inspectInstallDirectory(join(linkHome, "Applications"), linkHome))),
      /outside this account's home/,
    );

    // Absent, which the personal path creates rather than refuses.
    const freshHome = join(root, "fresh-home");
    mkdirSync(freshHome);
    const fresh = inspectInstallDirectory(join(freshHome, "Applications"), freshHome);
    assert.equal(fresh.exists, false);
    assert.equal(installDirectoryProblem(fresh), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the summary names which of the three destinations an install got", () => {
  assert.equal(describeInstallScope("user"), "personal");
  assert.equal(describeInstallScope("system"), "system");
  assert.equal(describeInstallScope("custom"), "custom");
  // A legacy install has no recorded choice, and saying "system" for it would state a
  // preference nobody expressed.
  assert.equal(describeInstallScope(null), "existing");
});
