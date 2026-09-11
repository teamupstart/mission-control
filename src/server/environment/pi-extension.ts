import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { ENVIRONMENT_CHECK_INFO } from "@shared/environment-checks.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import { agentSubprocessEnv, cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { piExtensionPath } from "../config.ts";
import { getPiExtensionConfig } from "../extensions/config.ts";
import { inspectMissionMcpTools, resolveMissionMcpRuntime } from "../mission-mcp.ts";
import { extensionsDirFor } from "../skills/reconcile.ts";
import type { EnvironmentCheckImpl, EnvironmentCheckResult } from "./types.ts";

const MAX_PATH = 512;
const short = (path: string) => path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…` : path;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const remedy = "Run `npm run build` then `npm run install-pi-extension` from a durable Mission Control clone. For a desktop install, update or reinstall the app's integration from a durable installation.";
const metadataSchema = z.object({ version: z.string().min(1).max(128), mcpServerPath: z.string().min(1).max(4096) });
type Metadata = z.infer<typeof metadataSchema>;
type LoadReading = { loaded: false } | { loaded: true; metadata: Metadata | null };
export interface PiExtensionReading extends EnvironmentCheckResult {
  /** Silence also describes never installed, so it is not availability. */
  healthy: boolean;
}

export function piExtensionLinkPath(): string {
  const spec = capabilitiesFor("pi").extensions;
  if (!spec) throw new Error("Pi has no extension directory capability");
  return join(extensionsDirFor(spec), spec.linkName);
}

/** Only proven absence permits a first install. A dangling or unreadable link never does. */
export function canInstallPiExtension(): boolean {
  try {
    if (getPiExtensionConfig().enabled) return false;
    try { lstatSync(piExtensionLinkPath()); return false; }
    catch (error) { return missing(error); }
  } catch { return false; }
}

/** No bundle code enters the daemon. Canonical paths, bounded output, hard timeout, no bearer. */
export async function loadPiExtensionMetadata(path: string, timeoutMs = 3000): Promise<LoadReading> {
  const descriptor = await resolveMissionMcpRuntime(process.execPath);
  const env = agentSubprocessEnv({ ...process.env, ...descriptor.env });
  try {
    return await new Promise((done) => {
      execFile(descriptor.command, ["--input-type=module", "-e",
        'const m = await import(process.argv[1]); if (typeof m.default !== "function") process.exit(2); process.stdout.write("\\nMISSION_PI_METADATA=" + JSON.stringify(m.missionControlBuild));',
        pathToFileURL(path).href], { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 }, (error, stdout) => {
        if (error) { done({ loaded: false }); return; }
        try {
          const parsed = metadataSchema.safeParse(JSON.parse(stdout.slice(stdout.lastIndexOf("\nMISSION_PI_METADATA=") + "\nMISSION_PI_METADATA=".length)));
          done({ loaded: true, metadata: parsed.success ? parsed.data : null });
        } catch { done({ loaded: true, metadata: null }); }
      });
    });
  } finally { cleanupAgentSubprocessEnv(env); }
}

/** Report only: a background read must never repoint a machine-wide executable link. */
export async function inspectPiExtension(bundleToInstall?: string): Promise<PiExtensionReading> {
  invalidatePiExtensionAvailability();
  return inspect(bundleToInstall);
}

let cached: { key: string; paths: Map<string, string>; healthy: boolean; expires: number } | undefined;
let cacheGeneration = 0;
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
  // Only the newest-started probe may publish, regardless of completion order.
  const generation = ++cacheGeneration;
  const paths = new Map<string, string>();
  const reading = await inspect(undefined, path => { if (!paths.has(path)) paths.set(path, pathIdentity(path)); });
  try {
    if (generation === cacheGeneration && key === availabilityKey() && [...paths].every(([path, identity]) => pathIdentity(path) === identity)) {
      cached = { key, paths, healthy: reading.healthy, expires: Date.now() + 30_000 };
    }
  } catch { invalidatePiExtensionAvailability(); }
  return reading.healthy;
}

async function inspect(bundleToInstall?: string, observe: (path: string) => void = () => {}): Promise<PiExtensionReading> {
  const silent: PiExtensionReading = { healthy: false, warning: null, detail: null };
  const warn = (warning: string, detail: string): PiExtensionReading => ({ healthy: false, warning: `${warning} ${remedy}`, detail: short(detail) });
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
    if (!statSync(target).isFile()) return warn(`Pi's extension at ${short(target)} is not a regular bundle file. Mission Control integration is unavailable.`, target);
    const load = await loadPiExtensionMetadata(target);
    if (!load.loaded && bundleToInstall) return warn(`The candidate Pi extension at ${short(target)} failed to load within the bounded child check. Installing it could prevent Pi sessions from starting.`, target);
    if (!load.loaded) return warn(`Every Pi session on this machine may refuse to start: the extension at ${short(target)} failed to load within the bounded child check. Pi can be started without extensions using pi -ne.`, target);
    const installed = load.metadata;
    if (!installed) return warn("The installed Pi extension has no valid build marker and is out of date.", target);
    const baked = installed.mcpServerPath;
    if (!isAbsolute(baked)) return warn("The Pi extension has an invalid baked MCP path; its Mission Control tools are unavailable.", target);
    observe(baked);
    try {
      if (!statSync(baked).isFile()) return warn(`The Pi extension's baked MCP bundle at ${short(baked)} is not a file. Lifecycle reports may still work, but its tools do not.`, baked);
    } catch (error) {
      if (!missing(error)) return warn(`The Pi extension's baked MCP bundle at ${short(baked)} cannot be inspected. Lifecycle reports may still work, but its Mission Control tools are unavailable. Check the bundle and parent directory permissions.`, baked);
      return warn(`The Pi extension's baked MCP bundle is missing at ${short(baked)}. Lifecycle reports may still work, but its tools do not.`, baked);
    }
    const expectedPath = piExtensionPath();
    observe(expectedPath);
    let expectedTarget: string;
    try { expectedTarget = realpathSync(expectedPath); }
    catch { return warn(`This Mission Control build cannot read its reference Pi extension at ${short(expectedPath)}, so freshness cannot be established.`, expectedPath); }
    const expectedLoad = expectedTarget === target ? load : await loadPiExtensionMetadata(expectedTarget);
    const current = expectedLoad.loaded ? expectedLoad.metadata : null;
    if (!current) return warn("This Mission Control build could not establish its Pi extension version.", expectedTarget);
    if (installed.version !== current.version) return warn("The installed Pi extension is out of date for this Mission Control build.", target);
    // The extension itself honors this override. Check the baked path too so removing an
    // override cannot conceal a moved checkout, then ask the bridge Pi will actually use.
    const bridgePath = envVar("MCP_SERVER") ?? baked;
    observe(bridgePath);
    let bridge: string;
    try { bridge = realpathSync(bridgePath); }
    catch { return warn(`The Pi extension's configured MCP bridge at ${short(bridgePath)} cannot be resolved. Lifecycle reports may still work, but its tools do not.`, bridgePath); }
    if (!await inspectMissionMcpTools(bridge)) return warn(`The Pi extension's MCP bridge at ${short(bridge)} is stale or cannot answer tools/list. Lifecycle reports may still work, but the required Mission Control tools are unavailable.`, bridge);
    return { healthy: true, warning: null, detail: null };
  } catch (error) {
    // Do not log file contents, subprocess output, or arbitrary error messages.
    const diagnostic = error instanceof Error ? error.name : typeof error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    console.warn("[pi-extension] Health inspection failed", { kind: short(diagnostic), code: typeof code === "string" ? short(code) : null });
    return { healthy: false, warning: `The Pi extension check could not establish a healthy installation. ${remedy}`, detail: null };
  }
}

export const piExtensionCheck: EnvironmentCheckImpl = {
  ...ENVIRONMENT_CHECK_INFO["pi-extension"],
  check: () => inspectPiExtension(),
};
