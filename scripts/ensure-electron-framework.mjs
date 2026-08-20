#!/usr/bin/env node

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
    if (!existsSync(targetPath)) {
      throw new Error(
        `Electron's macOS framework payload is incomplete at ${targetPath}; run npm install again`,
      );
    }
    return "present";
  }

  if (!existsSync(targetPath)) {
    throw new Error(
      `Electron's macOS framework payload is incomplete at ${targetPath}; run npm install again`,
    );
  }

  symlinkSync(FRAMEWORK_TARGET, linkPath);
  return "repaired";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = ensureElectronFramework(repoRoot);
  if (result === "repaired") {
    console.log("[electron] restored the macOS Electron Framework symlink");
  }
}
