import { execFile } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { agentSubprocessEnv, cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { inspectMissionMcpTools, resolveMissionMcpRuntime } from "../mission-mcp.ts";
import { verifyPiIntegration, PI_INTEGRATION_FILES } from "./pi-artifact.ts";

const short = (path: string) => path.length > 512 ? `${path.slice(0, 512)}…` : path;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const metadataSchema = z.object({ version: z.string().min(1).max(128), mcpServerPath: z.string().min(1).max(4096) });
type Metadata = z.infer<typeof metadataSchema>;
type LoadReading = { loaded: false } | { loaded: true; metadata: Metadata | null };

export interface PiCandidateReading { healthy: boolean; warning: string | null; detail: string | null }

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

/** Validate artifact bytes, load metadata in a bounded child and probe the actual bridge.
 * Callers supply the reference and override policy; this layer knows no enabled intent or UI. */
export async function inspectPiCandidate(target: string, expectedPath: string, options: {
  candidate?: boolean;
  bridgeOverride?: string;
  observe?: (path: string) => void;
} = {}): Promise<PiCandidateReading> {
  const observe = options.observe ?? (() => {});
  const warn = (warning: string, detail: string): PiCandidateReading => ({ healthy: false, warning, detail: short(detail) });
  if (!statSync(target).isFile()) return warn(`Pi's extension at ${short(target)} is not a regular bundle file. Mission Control integration is unavailable.`, target);
  const manifestPath = join(dirname(target), "manifest.json");
  for (const name of PI_INTEGRATION_FILES) observe(join(dirname(target), name));
  if (lstatSync(manifestPath, { throwIfNoEntry: false })) {
    try { verifyPiIntegration(dirname(target)); }
    catch { return warn("The Pi integration manifest or artifact hashes are invalid. Repair the damaged installation from Setup.", target); }
  }
  const load = await loadPiExtensionMetadata(target);
  if (!load.loaded && options.candidate) return warn(`The candidate Pi extension at ${short(target)} failed to load within the bounded child check. Installing it could prevent Pi sessions from starting.`, target);
  if (!load.loaded) return warn(`Every Pi session on this machine may refuse to start: the extension at ${short(target)} failed to load within the bounded child check. Pi can be started without extensions using pi -ne.`, target);
  const installed = load.metadata;
  if (!installed) return warn("The installed Pi extension has no valid build marker and is out of date.", target);
  const bundled = installed.mcpServerPath;
  if (!isAbsolute(bundled)) return warn("The Pi extension has an invalid bundled MCP path; its Mission Control tools are unavailable.", target);
  observe(bundled);
  try {
    if (!statSync(bundled).isFile()) return warn(`The Pi extension's bundled MCP bundle at ${short(bundled)} is not a file. Lifecycle reports may still work, but its tools do not.`, bundled);
  } catch (error) {
    if (!missing(error)) return warn(`The Pi extension's bundled MCP bundle at ${short(bundled)} cannot be inspected. Lifecycle reports may still work, but its Mission Control tools are unavailable. Check the bundle and parent directory permissions.`, bundled);
    return warn(`The Pi extension's bundled MCP bundle is missing at ${short(bundled)}. Lifecycle reports may still work, but its tools do not.`, bundled);
  }
  observe(expectedPath);
  for (const dir of [dirname(target), dirname(expectedPath)]) {
    for (const name of PI_INTEGRATION_FILES) observe(join(dir, name));
  }
  try {
    const installedManifest = verifyPiIntegration(dirname(target));
    const expectedManifest = verifyPiIntegration(dirname(expectedPath));
    if (installedManifest.buildId !== expectedManifest.buildId || installed.version !== installedManifest.buildId) {
      return warn("The installed Pi extension is out of date for this Mission Control build.", target);
    }
    if (realpathSync(bundled) !== realpathSync(join(dirname(target), "mcp-server.mjs"))) {
      return warn("The Pi extension does not resolve its matching MCP bridge beside the canonical extension.", target);
    }
  } catch {
    return warn("The Pi integration manifest or artifact hashes are invalid. This installation is out of date or damaged.", target);
  }
  // The extension itself honors this override. Check the bundled path too so removing an
  // override cannot conceal a damaged generation, then ask the bridge Pi will actually use.
  const bridgePath = options.bridgeOverride ?? bundled;
  observe(bridgePath);
  let bridge: string;
  try { bridge = realpathSync(bridgePath); }
  catch { return warn(`The Pi extension's configured MCP bridge at ${short(bridgePath)} cannot be resolved. Lifecycle reports may still work, but its tools do not.`, bridgePath); }
  if (!await inspectMissionMcpTools(bridge)) return warn(`The Pi extension's MCP bridge at ${short(bridge)} is stale or cannot answer tools/list. Lifecycle reports may still work, but the required Mission Control tools are unavailable.`, bridge);
  return { healthy: true, warning: null, detail: null };
}
