import { join, resolve } from "node:path";
import { z } from "zod";

import { PI_OTEL_PACKAGE, type SetupStatus } from "@shared/setup-catalog.ts";
import type { EnvironmentDeps } from "../environment/types.ts";

const SettingsSchema = z.object({
  packages: z.array(z.union([
    z.string(),
    z.object({ source: z.string(), extensions: z.array(z.string()).optional(), autoload: z.boolean().optional() }),
  ])).default([]),
});
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ManifestSchema = z.object({
  name: z.literal(PI_OTEL_PACKAGE.name),
  version: z.string().max(80).regex(VERSION),
  pi: z.object({ extensions: z.array(z.string()) }),
});

type JsonRead<T> = { kind: "ok"; data: T } | { kind: "missing" | "unknown" };

async function readJson<T>(
  deps: EnvironmentDeps,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<JsonRead<T>> {
  const read = await deps.readText(path);
  if (!read.ok) return { kind: read.missing ? "missing" : "unknown" };
  if (read.truncated) return { kind: "unknown" };
  let value: unknown;
  try { value = JSON.parse(read.text.replace(/^\uFEFF/, "")); }
  catch { return { kind: "unknown" }; }
  const parsed = schema.safeParse(value);
  return parsed.success ? { kind: "ok", data: parsed.data } : { kind: "unknown" };
}

function namesPackage(source: string, name: string): boolean {
  return source === `npm:${name}` || source.startsWith(`npm:${name}@`);
}

/**
 * Expand a leading `~` exactly as Pi's `normalizePath` does (`~`, `~/`, and `~\` only on
 * Windows; `~user` stays literal), then resolve against the daemon's working directory, which
 * is where embedded Pi resolves a relative value too.
 */
export function expandPiAgentDir(
  value: string | undefined,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!value) return undefined;
  const tilde = platform === "win32" ? /^~(?=$|[/\\])/ : /^~(?=$|\/)/;
  return resolve(value.replace(tilde, homeDir));
}

/** Installation evidence only: never import extension code, change Pi settings or contact npm. */
export async function piOtelPackageStatus(deps: EnvironmentDeps, configuredDir?: string): Promise<SetupStatus> {
  const agentDir = configuredDir || join(deps.homeDir, ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");
  const settings = await readJson(deps, settingsPath, SettingsSchema);
  if (settings.kind === "missing") return { state: "missing" };
  if (settings.kind !== "ok") {
    return { state: "unknown", why: "Pi settings could not be read as complete package configuration. Their contents are not shown.", evidence: settingsPath };
  }
  const packages = settings.data.packages.map((entry) =>
    typeof entry === "string" ? { source: entry, extensions: undefined, autoload: undefined } : entry);
  if (packages.some((entry) => namesPackage(entry.source, "pi-otel"))) {
    return { state: "unknown", why: "A separate pi-otel package is registered. Check /otel status before switching; installing a second exporter can duplicate telemetry.", evidence: settingsPath };
  }
  const registered = packages.filter((entry) => namesPackage(entry.source, PI_OTEL_PACKAGE.name));
  if (registered.length === 0) return { state: "missing" };
  if (registered.length !== 1 || registered[0]!.extensions !== undefined || registered[0]!.autoload === false) {
    return { state: "unknown", why: "Pi package autoload is disabled, resource filters or duplicate declarations are configured. Use pi config and /otel status to verify that OTel is selected.", evidence: settingsPath };
  }
  const packageDir = join(agentDir, "npm", "node_modules", PI_OTEL_PACKAGE.name);
  const manifestPath = join(packageDir, "package.json");
  const manifest = await readJson(deps, manifestPath, ManifestSchema);
  if (manifest.kind === "missing") {
    return { state: "needs-setup", why: "The Pi telemetry package is registered but not installed in this Pi agent directory. Follow the CodeArtifact install guide, then Re-check.", evidence: manifestPath };
  }
  if (manifest.kind !== "ok") {
    return { state: "unknown", why: "The installed Pi telemetry package manifest is unreadable or not a supported package layout.", evidence: manifestPath };
  }
  const requestedVersion = registered[0]!.source.slice(`npm:${PI_OTEL_PACKAGE.name}`.length + 1);
  if (requestedVersion !== "" && !VERSION.test(requestedVersion)) {
    return { state: "unknown", why: "This installation check supports exact npm version pins or an unversioned package declaration. Use Pi to verify a tag or version range.", evidence: settingsPath };
  }
  if (requestedVersion !== "" && requestedVersion !== manifest.data.version) {
    return { state: "needs-setup", why: "The installed Pi telemetry version does not match its registered pin. Reinstall the pinned package using the CodeArtifact guide, then Re-check.", evidence: manifestPath };
  }
  if (!manifest.data.pi.extensions.some((path) => path === PI_OTEL_PACKAGE.entry || path === `./${PI_OTEL_PACKAGE.entry}`)) {
    return { state: "unknown", why: "The package manifest does not declare the supported OTel entry. Check its installation and /otel status.", evidence: manifestPath };
  }
  const entryPath = join(packageDir, PI_OTEL_PACKAGE.entry);
  const entry = await deps.readText(entryPath);
  if (!entry.ok) {
    return { state: entry.missing ? "needs-setup" : "unknown", why: entry.missing
      ? "The registered package's OTel entry is missing. Repair it using the CodeArtifact install guide, then Re-check."
      : "The registered package's OTel entry cannot be read. Check its permissions, then Re-check.", evidence: entryPath };
  }
  if (entry.text.trim() === "") {
    return { state: "needs-setup", why: "The registered package's OTel entry is empty. Repair the package, then Re-check.", evidence: entryPath };
  }
  return {
    state: "satisfied",
    evidence: `${PI_OTEL_PACKAGE.name}@${manifest.data.version} installed and registered in ${agentDir}; export health is not checked. Use /otel status in a fresh Pi session.`,
  };
}
