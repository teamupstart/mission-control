import { join, resolve } from "node:path";
import { z } from "zod";

import type { SetupStatus } from "@shared/setup-catalog.ts";
import type { EnvironmentDeps } from "../environment/types.ts";

const SettingsSchema = z.object({
  packages: z.array(z.union([
    z.string(),
    z.object({ source: z.string(), extensions: z.array(z.string()).max(4096).optional(), autoload: z.boolean().optional() }),
  ])).max(4096).default([]),
});
export const npmNamePattern = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";
export const npmVersionPattern = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const VERSION = new RegExp(`^${npmVersionPattern}$`);
const ManifestSchema = z.object({
  name: z.string(),
  version: z.string().max(300).regex(VERSION),
  pi: z.object({ extensions: z.array(z.string()).max(4096) }),
});

interface PiPackageCheck {
  name: string;
  version: string;
  entry: string;
  conflicts: readonly string[];
}

type JsonRead<T> = { kind: "ok"; data: T } | { kind: "missing" | "unknown" };

async function readJson<T>(
  deps: EnvironmentDeps,
  path: string,
  schema: z.ZodType<T>,
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
export async function piExtensionStatus(deps: EnvironmentDeps, pkg: PiPackageCheck, configuredDir?: string): Promise<SetupStatus> {
  const agentDir = configuredDir || join(deps.homeDir, ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");
  const settings = await readJson(deps, settingsPath, SettingsSchema);
  if (settings.kind === "missing") return { state: "missing" };
  if (settings.kind !== "ok") {
    return { state: "unknown", why: "Pi settings could not be read as complete package configuration. Their contents are not shown.", evidence: settingsPath };
  }
  const packages = settings.data.packages.map((entry) =>
    typeof entry === "string" ? { source: entry, extensions: undefined, autoload: undefined } : entry);
  const conflict = pkg.conflicts.find((name) => packages.some((entry) => namesPackage(entry.source, name)));
  if (conflict) {
    return { state: "unknown", why: `A conflicting package (${conflict}) is registered. Review the installation guide before switching.`, evidence: settingsPath };
  }
  const registered = packages.filter((entry) => namesPackage(entry.source, pkg.name));
  if (registered.length === 0) return { state: "missing" };
  if (registered.length !== 1 || registered[0]!.extensions !== undefined || registered[0]!.autoload === false) {
    return { state: "unknown", why: "Pi package autoload is disabled, resource filters or duplicate declarations are configured. Use pi config to verify which extensions are selected.", evidence: settingsPath };
  }
  if (registered[0]!.source.endsWith("@")) {
    return { state: "unknown", why: "The registered npm package declaration has an empty version suffix. Use an exact npm version pin or an unversioned package declaration.", evidence: settingsPath };
  }
  const requestedVersion = registered[0]!.source.slice(`npm:${pkg.name}`.length + 1);
  if (requestedVersion !== "" && !VERSION.test(requestedVersion)) {
    return { state: "unknown", why: "This installation check supports exact npm version pins or an unversioned package declaration. Use Pi to verify a tag or version range.", evidence: settingsPath };
  }
  const packageDir = join(agentDir, "npm", "node_modules", pkg.name);
  const manifestPath = join(packageDir, "package.json");
  const manifest = await readJson(deps, manifestPath, ManifestSchema);
  if (manifest.kind === "missing") {
    return { state: "needs-setup", why: "The package is registered but missing from this Pi agent directory.", evidence: manifestPath };
  }
  if (manifest.kind !== "ok" || manifest.data.name !== pkg.name) {
    return { state: "unknown", why: "The installed package manifest could not confirm the expected package and extensions.", evidence: manifestPath };
  }
  if (manifest.data.version !== pkg.version || (requestedVersion !== "" && requestedVersion !== pkg.version)) {
    return { state: "needs-setup", why: "The installed or registered version differs from the recommended pin.", evidence: manifestPath };
  }
  if (!manifest.data.pi.extensions.some((path) => path === pkg.entry || path === `./${pkg.entry}`)) {
    return { state: "unknown", why: "The manifest does not declare the configured extension entry.", evidence: manifestPath };
  }
  const entryPath = join(packageDir, pkg.entry);
  const entry = await deps.readText(entryPath);
  if (!entry.ok) {
    return { state: entry.missing ? "needs-setup" : "unknown", why: entry.missing
      ? "The configured extension entry is missing."
      : "The configured extension entry cannot be read.", evidence: entryPath };
  }
  if (entry.text.trim() === "") {
    return { state: "needs-setup", why: "The configured extension entry is empty.", evidence: entryPath };
  }
  return {
    state: "satisfied",
    evidence: `${pkg.name}@${manifest.data.version} installed and registered in ${agentDir}.`,
  };
}
