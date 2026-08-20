#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_SOURCE = 'process.stdout.write(process.versions.electron || "")';
const MAX_FAILURE_DETAIL = 2_000;

function defaultElectronPackageDir() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("electron/package.json"));
}

function failureDetail(result) {
  const detail = [
    result.error instanceof Error ? result.error.message : null,
    result.signal ? `killed by ${result.signal}` : null,
    typeof result.status === "number" ? `exited ${result.status}` : null,
    typeof result.stderr === "string" ? result.stderr.trim() : null,
  ]
    .filter(Boolean)
    .join(": ");
  return detail.slice(-MAX_FAILURE_DETAIL) || "the runtime did not report a result";
}

/**
 * Load Electron in its supported Node mode and prove the dynamic runtime matches the package.
 *
 * Electron's installer checks only the version marker, path file, and launcher. A partially
 * written framework therefore looks installed until macOS dyld tries to load it. Executing
 * the runtime catches that corruption before the concurrent geometry tests start.
 */
export function probeElectronRuntime(
  electronPackageDir,
  { env = process.env, spawn = spawnSync } = {},
) {
  let expectedVersion;
  let relativeExecutable;
  try {
    expectedVersion = JSON.parse(
      readFileSync(join(electronPackageDir, "package.json"), "utf8"),
    ).version;
    relativeExecutable = readFileSync(join(electronPackageDir, "path.txt"), "utf8").trim();
  } catch (error) {
    return {
      ok: false,
      reason: `Electron installation metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (typeof expectedVersion !== "string" || !expectedVersion || !relativeExecutable) {
    return { ok: false, reason: "Electron installation metadata is incomplete" };
  }

  const distDir = env.ELECTRON_OVERRIDE_DIST_PATH || join(electronPackageDir, "dist");
  const executable = join(distDir, relativeExecutable);
  if (!existsSync(executable)) {
    return { ok: false, reason: `Electron executable is missing at ${executable}` };
  }

  const result = spawn(executable, ["-e", PROBE_SOURCE], {
    encoding: "utf8",
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const reportedVersion = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.status === 0 && reportedVersion === expectedVersion) {
    return { ok: true, version: expectedVersion, executable };
  }

  return {
    ok: false,
    reason:
      result.status === 0
        ? `Electron reported version ${JSON.stringify(reportedVersion)} instead of ${expectedVersion}`
        : `Electron could not load: ${failureDetail(result)}`,
  };
}

/**
 * Ensure Electron's generated runtime is executable, repairing only a broken package runtime.
 */
export function ensureElectronRuntime(
  electronPackageDir = defaultElectronPackageDir(),
  { env = process.env, logger = console } = {},
) {
  const first = probeElectronRuntime(electronPackageDir, { env });
  if (first.ok) {
    logger.log(`[electron-preflight] runtime ${first.version} is ready`);
    return { repaired: false, probe: first };
  }

  if (env.ELECTRON_OVERRIDE_DIST_PATH) {
    throw new Error(
      `[electron-preflight] the overridden runtime failed its integrity probe: ${first.reason}`,
    );
  }

  logger.warn(`[electron-preflight] ${first.reason}; reinstalling the generated runtime`);
  const distDir = join(electronPackageDir, "dist");
  const pathFile = join(electronPackageDir, "path.txt");
  rmSync(distDir, { recursive: true, force: true });
  rmSync(pathFile, { force: true });

  const installed = spawnSync(process.execPath, [join(electronPackageDir, "install.js")], {
    cwd: electronPackageDir,
    env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (installed.status !== 0) {
    throw new Error(
      `[electron-preflight] Electron runtime reinstall failed: ${failureDetail(installed)}`,
    );
  }

  const repaired = probeElectronRuntime(electronPackageDir, { env });
  if (!repaired.ok) {
    throw new Error(
      `[electron-preflight] Electron runtime still fails after reinstall: ${repaired.reason}`,
    );
  }
  logger.log(`[electron-preflight] repaired runtime ${repaired.version}`);
  return { repaired: true, probe: repaired };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    ensureElectronRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
