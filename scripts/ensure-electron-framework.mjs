#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRAMEWORK_RELATIVE_PATH = join(
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
);
const FRAMEWORK_LINK = "Electron Framework";
const FRAMEWORK_TARGET = "Versions/Current/Electron Framework";

/**
 * The one fault, worded once.
 *
 * Both arms below reach it - a canonical link over a missing payload, and no link and no
 * payload - and they are the same fact about the tree, so they must not describe it in two
 * ways. They already did: the two sites drifted the moment one of them was corrected, which
 * is exactly how the wrong repair instruction survived in half the cases.
 *
 * The instruction is load-bearing and is asserted by a test. `npm install` does NOT clear
 * this: npm resolves `electron` against the lockfile, finds the package directory present
 * and matching, and never re-runs the postinstall that fetches the payload.
 */
function incompletePayload(targetPath) {
  return new Error(
    `Electron's macOS framework payload is incomplete at ${targetPath}; ` +
      `restore it with \`node node_modules/electron/install.js\` (npm install will NOT ` +
      `fix this - it sees the package as installed and skips its postinstall)`,
  );
}

/**
 * Repair the one macOS Electron bundle defect a copied dependency tree can acquire.
 *
 * The 192 MB framework payload can be complete while its standard top-level symlink is
 * absent. Electron's executable still exists, so npm's package installer and our dependency
 * stamp both consider the package installed, but dyld aborts before a GUI test can start.
 * Restore only the canonical link and only when the payload it names is already present.
 */
export function ensureElectronFramework(repoRoot, platform = process.platform) {
  if (platform !== "darwin") return "not-applicable";

  const frameworkDir = join(repoRoot, FRAMEWORK_RELATIVE_PATH);
  const linkPath = join(frameworkDir, FRAMEWORK_LINK);
  const targetPath = join(frameworkDir, FRAMEWORK_TARGET);

  const entry = lstatSync(linkPath, { throwIfNoEntry: false });
  if (entry) {
    const canonicalLink =
      entry.isSymbolicLink() && readlinkSync(linkPath) === FRAMEWORK_TARGET;
    if (!canonicalLink) {
      throw new Error(`refusing to replace unexpected Electron framework entry at ${linkPath}`);
    }
    if (!existsSync(targetPath)) throw incompletePayload(targetPath);
    return "present";
  }

  if (!existsSync(targetPath)) throw incompletePayload(targetPath);

  symlinkSync(FRAMEWORK_TARGET, linkPath);
  return "repaired";
}

/**
 * Whether the framework payload this preflight guards is on disk at all.
 *
 * Separate from `ensureElectronFramework` because that function's contract is to REPORT the
 * defect and never to manufacture a payload - the difference between restoring a missing
 * symlink over 192 MB that is already there, which it does, and fetching the 192 MB, which
 * it must not. Callers that are allowed to heal ask this first.
 */
export function electronPayloadPresent(repoRoot, platform = process.platform) {
  if (platform !== "darwin") return true;
  return existsSync(join(repoRoot, FRAMEWORK_RELATIVE_PATH, FRAMEWORK_TARGET));
}

/**
 * Re-run Electron's own installer to restore a package whose `dist/` never landed.
 *
 * This exists because the advice the error above USED to give was wrong, and provably so:
 * `npm install` completes, reports "changed 1 package", and leaves `dist/` missing. npm
 * resolves `electron` against the lockfile, finds the package directory already present and
 * matching, and therefore never re-runs the postinstall that downloads the payload. So the
 * one state this preflight exists to catch was also the one state its own instructions could
 * not clear, and a checkout could sit broken through any number of `npm install` runs.
 *
 * A fresh worktree-pool slot reaches that state routinely - the package is seeded, the
 * postinstall's download is not - which is why this is worth healing automatically rather
 * than printing at somebody. `install.js` is the exact script npm's postinstall would have
 * run: it is idempotent, it extracts from `~/Library/Caches/electron` when the versioned zip
 * is already there (the common case, and offline), and it downloads only when it is not.
 *
 * Deliberately NOT wired into `ensureElectronFramework`. That function is pure enough to
 * unit test against a temp directory and is asserted to never invent a payload; this spawns
 * a subprocess and can touch the network, so it stays a separate, explicit step that only
 * the command-line entry point below takes.
 */
export function restoreElectronPayload(repoRoot, platform = process.platform) {
  if (platform !== "darwin") return "not-applicable";

  const packageDir = join(repoRoot, "node_modules", "electron");
  const installer = join(packageDir, "install.js");
  // No package at all is a genuinely different fault from a package missing its payload, and
  // running the installer is not the answer to it. Say which one happened.
  if (!existsSync(installer)) {
    throw new Error(
      `Electron is not installed at ${packageDir}; run npm install`,
    );
  }

  const result = spawnSync(process.execPath, [installer], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Electron's installer exited ${result.status}; the framework payload is still incomplete`,
    );
  }
  return "restored";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Heal before asserting, so the check below reports on the tree as it now stands. A
  // present payload makes this a single `existsSync` and nothing is spawned.
  if (!electronPayloadPresent(repoRoot)) {
    console.log("[electron] framework payload is missing - re-running Electron's installer");
    restoreElectronPayload(repoRoot);
  }
  const result = ensureElectronFramework(repoRoot);
  if (result === "repaired") {
    console.log("[electron] restored the macOS Electron Framework symlink");
  }
}
