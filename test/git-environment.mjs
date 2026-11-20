// How git runs under the test suite: the same git, started fewer times.
//
// Endpoint security agents on developer Macs inspect every exec, so the suite's cost to a
// laptop is its process count. Git is most of it, and two things multiply every git the
// suite runs without being anything a test asserts on. Both are removed here, for test
// workers only, and neither changes which git binary answers or how it behaves.
//
// Loaded by `test/setup-state.mjs`, so it rides the one preload every test command carries.
// Plain `.mjs` with only Node built-ins, for the same reason that file is.

import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * `git maintenance run --auto` is a second git process that every `commit`, `merge`, `fetch`,
 * `rebase` and `am` starts on its way out, to decide whether the repository needs packing. A
 * test repository never does, so here it is one wasted exec per commit, thousands per run.
 *
 * Through `GIT_CONFIG_COUNT` so it reaches every git a worker starts - directly or through the
 * code under test - without touching any repository's config or the operator's global one.
 * Appended to whatever the environment already carries, never replacing it.
 */
export function disableAutoMaintenance(env = process.env) {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env[`GIT_CONFIG_KEY_${count}`] = "maintenance.auto";
  env[`GIT_CONFIG_VALUE_${count}`] = "false";
  env.GIT_CONFIG_COUNT = String(count + 1);
}

/** The first `name` on `path` that is executable, or null. Looked up without a process. */
function onPath(name, path) {
  for (const directory of (path ?? "").split(delimiter)) {
    // An empty component is the current directory, which is where a shell would look.
    const candidate = join(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/**
 * The developer directory `/usr/bin` shims dispatch into, in `xcode-select`'s own order:
 * `DEVELOPER_DIR`, then the selection `xcode-select --switch` records as
 * `/var/db/xcode_select_link`, then Xcode.app, then the Command Line Tools.
 *
 * Read from the filesystem because the one command that answers it, `xcrun`, is itself a
 * process - and this runs once in every test worker.
 */
export function developerDirectory(env = process.env, exists = existsSync, readlink = readlinkSync) {
  if (env.DEVELOPER_DIR) return env.DEVELOPER_DIR;
  try {
    return resolve("/var/db", readlink("/var/db/xcode_select_link"));
  } catch {
    // Nothing selected explicitly.
  }
  for (const candidate of ["/Applications/Xcode.app/Contents/Developer", "/Library/Developer/CommandLineTools"]) {
    if (exists(join(candidate, "usr", "bin", "git"))) return candidate;
  }
  return null;
}

/**
 * On macOS `/usr/bin/git` is not git. It is Apple's `xcrun` shim, which finds the selected
 * developer directory and then execs the real binary: two execs for every git the suite runs.
 * This puts the real binary first on the worker's `PATH`, so each git is one exec.
 *
 * A private prefix rather than a lone symlink, because git finds its helpers, templates and
 * system config relative to the path it was started from. A bare `bin/git` link elsewhere
 * would find none of them, and `git init` would quietly make repositories without the default
 * template. So the prefix mirrors the real `usr` entry for entry - `libexec`, `share`, `lib`
 * are links to the real directories - and its `bin` holds `git` alone, so no other tool on
 * `PATH` moves.
 *
 * In its own temp directory, removed when the worker exits - never under the state home,
 * where a test measuring that directory would follow the links into Xcode. Does nothing on
 * Linux, when a Homebrew or mise git comes first on `PATH`, or when no developer directory
 * has a git.
 */
export function bypassXcrunGitShim(env = process.env) {
  if (process.platform !== "darwin" || onPath("git", env.PATH) !== "/usr/bin/git") return;
  const developer = developerDirectory(env);
  if (!developer) return;
  const usr = join(developer, "usr");
  const real = join(usr, "bin", "git");
  if (!existsSync(real)) return;
  const prefix = mkdtempSync(join(tmpdir(), "mission-test-git-"));
  process.on("exit", () => rmSync(prefix, { recursive: true, force: true }));
  try {
    mkdirSync(join(prefix, "bin"), { recursive: true });
    for (const entry of readdirSync(usr)) {
      if (entry !== "bin") symlinkSync(join(usr, entry), join(prefix, entry));
    }
    symlinkSync(real, join(prefix, "bin", "git"));
  } catch {
    return;
  }
  env.PATH = `${join(prefix, "bin")}${delimiter}${env.PATH}`;
}
