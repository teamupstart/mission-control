import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { ENVIRONMENT_CHECK_INFO } from "@shared/environment-checks.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import { piExtensionPath } from "../config.ts";
import { getPiExtensionConfig } from "../extensions/config.ts";
import { inspectPiCandidate } from "../extensions/pi-candidate.ts";
import { canReconcileExtensionLink, extensionsDirFor } from "../skills/reconcile.ts";
import type { EnvironmentCheckImpl, EnvironmentCheckResult } from "./types.ts";

const MAX_PATH = 512;
const short = (path: string) => path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…` : path;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const remedy = "Open Settings > Setup > Agent extensions to install or repair Pi integration. Foreign entries must be moved by their owner.";
export interface PiExtensionReading extends EnvironmentCheckResult {
  /** Silence also describes never installed, so it is not availability. */
  healthy: boolean;
  /** The generic environment-check projection of `healthy`. */
  ready: boolean;
}

export function piExtensionLinkPath(): string {
  const spec = capabilitiesFor("pi").extensions;
  if (!spec) throw new Error("Pi has no extension directory capability");
  return join(extensionsDirFor(spec), spec.linkName);
}

/** Both first install and owned repair are available; foreign entries remain untouched. */
export function canInstallPiExtension(): boolean {
  try { getPiExtensionConfig(); return canReconcileExtensionLink(); } catch { return false; }
}

/** Report only: a background read must never repoint a machine-wide executable link. */
export async function inspectPiExtension(bundleToInstall?: string): Promise<PiExtensionReading> {
  invalidatePiExtensionAvailability();
  return inspect(bundleToInstall);
}

let cached: { key: string; paths: Map<string, string>; healthy: boolean; expires: number; sequence: number } | undefined;
let cacheGeneration = 0;
let probeSequence = 0;
export function invalidatePiExtensionAvailability(): void { cached = undefined; cacheGeneration += 1; }

function pathIdentity(path: string): string {
  try {
    const entry = lstatSync(path);
    const target = realpathSync(path);
    const file = statSync(target);
    return JSON.stringify([target, ...[entry, file].map(s => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs])]);
  } catch (error) { return String((error as NodeJS.ErrnoException).code); }
}
function availabilityKey(): string {
  // Hash, never retain or report credentials. Runtime/environment changes invalidate too.
  return createHash("sha256").update(JSON.stringify([
    piExtensionLinkPath(), piExtensionPath(), getPiExtensionConfig(),
    Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest("hex");
}

/** Dispatch reuses only completed, unchanged readings, for at most thirty seconds.
 * Setup always calls inspectPiExtension directly, invalidating this bounded cache. */
export async function piExtensionHealthyForDispatch(): Promise<boolean> {
  let key: string;
  try { key = availabilityKey(); } catch { return (await inspectPiExtension()).healthy; }
  if (cached?.key === key && cached.expires > Date.now()
    && [...cached.paths].every(([path, identity]) => pathIdentity(path) === identity)) return cached.healthy;
  // Earlier completions may prime the cache, but cannot replace newer published readings.
  const generation = cacheGeneration;
  const sequence = ++probeSequence;
  const paths = new Map<string, string>();
  const reading = await inspect(undefined, path => { if (!paths.has(path)) paths.set(path, pathIdentity(path)); });
  try {
    if (generation === cacheGeneration && (!cached || sequence > cached.sequence) && key === availabilityKey() && [...paths].every(([path, identity]) => pathIdentity(path) === identity)) {
      cached = { key, paths, healthy: reading.healthy, expires: Date.now() + 30_000, sequence };
    }
  } catch { invalidatePiExtensionAvailability(); }
  return reading.healthy;
}

async function inspect(bundleToInstall?: string, observe: (path: string) => void = () => {}): Promise<PiExtensionReading> {
  const silent: PiExtensionReading = { healthy: false, ready: false, warning: null, detail: null };
  const warn = (warning: string, detail: string): PiExtensionReading => ({ healthy: false, ready: false, warning: `${warning} ${remedy}`, detail: short(detail) });
  try {
    const link = bundleToInstall ?? piExtensionLinkPath();
    observe(link);
    let entry;
    try { entry = lstatSync(link); }
    catch (error) {
      if (!missing(error)) return warn(`The Pi extension entry at ${short(link)} cannot be inspected; its Mission Control integration is unavailable. Check the extension directory and entry permissions.`, link);
      return getPiExtensionConfig().enabled
        ? warn(`The Pi integration is enabled, but ${short(link)} is missing. Pi reports nothing; sessions silently lose Mission Control tools and lifecycle reports.`, link)
        : silent;
    }
    let target: string;
    try { target = realpathSync(link); }
    catch (error) {
      if (!missing(error)) return warn(`The Pi extension at ${short(link)} cannot be resolved; its Mission Control integration is unavailable. Check for a symlink cycle or inaccessible target and inspect its permissions.`, link);
      const intended = entry.isSymbolicLink() ? resolve(dirname(link), readlinkSync(link)) : link;
      return warn(`Pi reports nothing when its extension link is dangling. ${short(link)} points to missing ${short(intended)}; sessions silently lose Mission Control tools and lifecycle reports.`, `${link} -> ${intended}`);
    }
    const result = await inspectPiCandidate(target, piExtensionPath(), {
      candidate: !!bundleToInstall,
      bridgeOverride: bundleToInstall ? undefined : envVar("MCP_SERVER"),
      observe,
    });
    return result.healthy ? { ...result, ready: true }
      : warn(result.warning!, result.detail ?? target);
  } catch (error) {
    // Do not log file contents, subprocess output, or arbitrary error messages.
    const diagnostic = error instanceof Error ? error.name : typeof error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    console.warn("[pi-extension] Health inspection failed", { kind: short(diagnostic), code: typeof code === "string" ? short(code) : null });
    return { healthy: false, ready: false, warning: `The Pi extension check could not establish a healthy installation. ${remedy}`, detail: null };
  }
}

export const piExtensionCheck: EnvironmentCheckImpl = {
  ...ENVIRONMENT_CHECK_INFO["pi-extension"],
  check: () => inspectPiExtension(),
};
