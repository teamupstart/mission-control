#!/usr/bin/env node

import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { platform as processPlatform } from "node:process";

/**
 * How a freshly built native addon reaches `dist/native`, and why it is never a plain copy.
 *
 * A `copyFile` onto the published path truncates and rewrites the file that is already there,
 * keeping its inode. On macOS that is destructive in a way no JavaScript error reports: if any
 * live process has that addon mapped, rewriting the bytes underneath it invalidates the
 * kernel's code-signature bookkeeping for that vnode, and from then on EVERY process that
 * loads it is `SIGKILL`ed. Not an exception, not a load error - the process is gone before it
 * can print anything, and a `require` of the byte-identical file at a fresh inode still works,
 * so the file looks perfectly healthy to `codesign`, `shasum`, and a reader.
 *
 * That is not hypothetical. `npm run build:native` runs on every `make start`, and a developer
 * restarting the stack has a daemon or an Electron shell holding the previous addon open. One
 * such restart poisons the published inode, and afterwards every daemon spawned from that
 * worktree dies during startup with an empty stderr and exit code 137 - including the daemons
 * that `test/daemon-state-ownership.test.ts` spawns, which is how this was found.
 *
 * A rename cannot do that. It publishes a NEW inode and leaves the old one alone, so a process
 * that already mapped the previous addon keeps reading the bytes it validated, and the next
 * process to load resolves the name to an untouched file. The staging copy lives beside the
 * destination so the rename stays within one filesystem, which is what makes it atomic.
 *
 * Both native builders publish through here rather than each spelling it out. The rule is one
 * line of code and several paragraphs of reason, and it was already written down correctly in
 * one of the two builders while the other quietly copied over its output.
 */

/**
 * Remove download provenance inherited by a freshly copied local addon on macOS.
 *
 * The linker gives the bundle a valid ad-hoc signature, but a worktree can itself carry
 * `com.apple.provenance`. `copyFile` preserves that attribute on this host, and macOS then kills
 * Node while it loads the addon. Listing first distinguishes an already-clean file without
 * interpreting platform-specific error text. Every listing or deletion failure stays fatal
 * because shipping an addon the daemon cannot load would make both ordinary startup and
 * database recovery fail without a JavaScript diagnostic.
 */
export function clearDarwinProvenance(
  path,
  platform = processPlatform,
  execute = execFileSync,
) {
  if (platform !== "darwin") return false;
  const attributes = String(
    execute("/usr/bin/xattr", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (!attributes.split(/\r?\n/).includes("com.apple.provenance")) return false;
  execute("/usr/bin/xattr", ["-d", "com.apple.provenance", path], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  return true;
}

/**
 * Move a built addon to its published path without ever writing through that path.
 *
 * `built` is the artifact node-gyp just produced; `output` is the name the daemon loads. The
 * staging directory is created beside `output` and removed on every exit path, so a failed
 * build leaves the previously published addon exactly as it was rather than a half-written one.
 */
export async function publishNativeAddon(built, output) {
  const workspace = await mkdtemp(join(dirname(output), ".publish-"));
  try {
    const staged = join(workspace, "addon.node");
    await copyFile(built, staged);
    clearDarwinProvenance(staged);
    await rename(staged, output);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
