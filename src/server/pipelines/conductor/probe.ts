import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  PIPELINE_PROVIDER_INFO,
  type PipelineProbe,
  type PipelineProject,
} from "@shared/pipeline.ts";
import { envVar } from "../../config.ts";
import { resolveBinPath, run } from "../../util/exec.ts";

// Is ai-conductor installed, what version, and which repositories does it say it manages?
//
// Everything here is a READ. The one subprocess it spawns is `conduct-ts engineer projects`,
// which prints the engine's own registry and mutates nothing - and even that has a
// file-based fallback, so an operator whose engine cannot start still gets a repository
// list to consent from.
//
// Nothing calls this on a cadence. It runs when the Settings panel asks, behind the TTL
// cache in `../index.ts`, because a probe is a subprocess and the panel polls. The watch
// loop never calls it at all: the projection is built from files, so an engine that is not
// on `PATH` costs a fleet with an enabled repository exactly nothing.

const INFO = PIPELINE_PROVIDER_INFO["ai-conductor"];
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ENGINE_SOURCE_SHA_SIDECAR = ".engine-source-sha";
const MAX_VERSION_BYTES = 512;
const MAX_SOURCE_SHA_BYTES = 128;

/** How long one probe subprocess gets before it is killed and reported as unreachable. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Where the engine binary is, honouring the operator's override.
 *
 * `MISSION_CONDUCTOR_BIN` (then `FLEET_`, then `HARNESS_`) is the same chain every agent
 * binary resolves through, which is what lets the e2e suite point this at a fake without
 * a second mechanism - and what lets an operator who installed the engine somewhere other
 * than `~/.local/bin` be found.
 */
export function conductorBin(): string {
  return envVar("CONDUCTOR_BIN") || INFO.bin;
}

/**
 * Where the engine's project registry lives.
 *
 * `$AI_CONDUCTOR_REGISTRY` names the FILE, not its directory - that is the engine's own
 * contract (`resolveRegistryPath`), and it treats a whitespace-only value as unset. Read
 * bare, without a `MISSION_` prefix, because it is the variable the engine itself reads:
 * a machine already configured for conductor needs nothing new.
 */
export function conductorRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AI_CONDUCTOR_REGISTRY;
  if (override && override.trim() !== "") return override;
  return join(env.HOME ?? homedir(), ".ai-conductor", "registry.json");
}

/**
 * The engine's version, derived from the published bundle the resolved binary will execute.
 *
 * There is no `--version` flag - verified against the engine's own CLI, which never calls
 * Commander's `.version()`. Published bundles stamp their source commit beside the executable,
 * and that commit owns the VERSION that describes the bytes. A legacy installation without the
 * stamp falls back to the VERSION at the harness root. Two possible roots are checked because an
 * installation may nest the shim one directory deeper.
 *
 * Null is an ordinary answer meaning "this build could not tell", and the panel says so rather
 * than inventing one. When both versions are known but differ, the probe names the mismatch and
 * the lifecycle gate refuses before an older CLI can interpret the capability name as an idea.
 */
function versionMarker(path: string): string | null {
  try {
    const file = statSync(path);
    if (!file.isFile() || file.size > MAX_VERSION_BYTES) return null;
    const text = readFileSync(path, "utf8").trim();
    return VERSION_PATTERN.test(text) ? text : null;
  } catch {
    return null;
  }
}

export interface ConductorInstallationVersion {
  version: string | null;
  checkoutVersion: string | null;
  checkoutRoot: string | null;
  stale: boolean;
}

/**
 * Read the version of the bundle `conduct-ts` will actually execute.
 *
 * A source checkout can advance while its gitignored `dist` link still names an older
 * published bundle. The checkout VERSION is not executable identity in that state. Published
 * Conductor bundles carry the source commit in `.engine-source-sha`, so resolve that commit's
 * VERSION through the same checkout and use the current marker only as a legacy fallback.
 */
export async function conductorInstallationVersion(
  binPath: string | null,
): Promise<ConductorInstallationVersion> {
  const unknown: ConductorInstallationVersion = {
    version: null,
    checkoutVersion: null,
    checkoutRoot: null,
    stale: false,
  };
  if (!binPath) return unknown;
  let real: string;
  try {
    real = realpathSync(binPath);
  } catch {
    return unknown;
  }

  // `<root>/bin/conduct-ts` -> `<root>`, then one more level for a deeper shim.
  const roots = [dirname(dirname(real)), dirname(dirname(dirname(real)))];
  for (const root of roots) {
    const checkoutVersion = versionMarker(join(root, "VERSION"));
    if (checkoutVersion === null) continue;

    let sourceSha: string | null = null;
    try {
      const entry = realpathSync(join(root, "src", "conductor", "dist", "index.js"));
      const sidecar = join(dirname(entry), ENGINE_SOURCE_SHA_SIDECAR);
      const file = statSync(sidecar);
      if (file.isFile() && file.size <= MAX_SOURCE_SHA_BYTES) {
        const text = readFileSync(sidecar, "utf8").trim();
        if (SOURCE_SHA_PATTERN.test(text)) sourceSha = text;
      }
    } catch {
      // Legacy and non-standard installations have no published-source sidecar.
    }

    if (sourceSha === null) {
      return { version: checkoutVersion, checkoutVersion, checkoutRoot: root, stale: false };
    }

    const published = await run("git", ["-C", root, "show", `${sourceSha}:VERSION`], {
      cwd: root,
      timeoutMs: 2_000,
      maxBuffer: MAX_VERSION_BYTES,
    });
    const version =
      published.code === 0 && !published.outcomeUnknown && !published.overflowed
        ? VERSION_PATTERN.test(published.stdout.trim())
          ? published.stdout.trim()
          : null
        : null;
    if (version === null) {
      return { version: null, checkoutVersion, checkoutRoot: root, stale: false };
    }
    return {
      version,
      checkoutVersion,
      checkoutRoot: root,
      stale: version !== checkoutVersion,
    };
  }
  return unknown;
}

export function staleConductorBundleError(
  reading: ConductorInstallationVersion,
): string | null {
  if (
    !reading.stale ||
    reading.version === null ||
    reading.checkoutVersion === null ||
    reading.checkoutRoot === null
  ) {
    return null;
  }
  return (
    `installed conduct-ts bundle is ${reading.version}, but its checkout is ${reading.checkoutVersion}; ` +
    `rerun ${join(reading.checkoutRoot, "bin", "install")} before dispatch`
  );
}

export async function conductorVersion(binPath: string | null): Promise<string | null> {
  return (await conductorInstallationVersion(binPath)).version;
}

/**
 * Coerce whatever the engine handed back into the project list this build understands.
 *
 * Total by construction: anything unrecognisable yields `[]`, and a record missing the one
 * field that matters is dropped rather than defaulted. `path` is the only required field -
 * it is what an operator consents to, and a record without one names nothing.
 *
 * `schemaVersion` is PER RECORD in the engine's registry, not an envelope, and it is
 * deliberately not checked: this reads two strings out of a record whose shape has been
 * stable since v1, and refusing a record for carrying a higher number would hide a
 * repository from the consent list over a field this does not read.
 */
export function readConductorProjects(parsed: unknown): PipelineProject[] {
  if (!Array.isArray(parsed)) return [];
  const out: PipelineProject[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : null;
    if (!path) continue;
    out.push({
      name: typeof record.name === "string" && record.name !== "" ? record.name : path,
      path,
      remote: typeof record.remote === "string" ? record.remote : null,
      status: typeof record.status === "string" ? record.status : null,
    });
  }
  return out;
}

/** The registry file, read directly. The fallback when the CLI cannot answer. */
function projectsFromRegistryFile(path: string): PipelineProject[] | null {
  try {
    if (!existsSync(path)) return [];
    return readConductorProjects(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Malformed is not the same as absent, and the caller says which it met.
    return null;
  }
}

/**
 * Ask the engine what it is and what it manages.
 *
 * The project list is taken from `engineer projects` when that verb answers with a JSON
 * array, and from the registry file otherwise. Preferring the CLI is not ceremony: the
 * engine canonicalizes and redacts records on the way out, and an operator who moved their
 * registry with `$AI_CONDUCTOR_REGISTRY` has told the engine, not us.
 *
 * The verb's EXIT CODE is not consulted. The engine's `engineer` verbs exit 0 on malformed
 * invocations, so a zero says nothing; what is checked is that stdout parses as an array,
 * which is the only evidence that the verb this build asked for is the verb that ran.
 */
export async function probeConductor(): Promise<PipelineProbe> {
  const bin = conductorBin();
  const registryPath = conductorRegistryPath();
  const binPath = await resolveBinPath(bin);
  if (!binPath) {
    return {
      provider: "ai-conductor",
      found: false,
      bin,
      binPath: null,
      version: null,
      registryPath,
      projects: [],
      error: `${bin} is not on this daemon's PATH`,
      checkedAt: Date.now(),
    };
  }

  const installation = await conductorInstallationVersion(binPath);
  const version = installation.version;
  let projects: PipelineProject[] | null = null;
  let error: string | null = staleConductorBundleError(installation);

  const result = await run(binPath, ["engineer", "projects"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (!result.outcomeUnknown && result.stdout.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (Array.isArray(parsed)) projects = readConductorProjects(parsed);
    } catch {
      // Fall through to the file. A CLI that printed prose is a CLI we cannot read, not
      // an engine that is absent.
    }
  }

  if (projects === null) {
    const fromFile = projectsFromRegistryFile(registryPath);
    if (fromFile === null) {
      projects = [];
      const detail = `could not read ${registryPath}, and ${bin} engineer projects did not answer with JSON`;
      error = error ? `${error}; ${detail}` : detail;
    } else {
      projects = fromFile;
      const detail = `${bin} engineer projects did not answer with JSON; read ${registryPath} instead`;
      error = error ? `${error}; ${detail}` : detail;
    }
  }

  return {
    provider: "ai-conductor",
    found: true,
    bin,
    binPath,
    version,
    registryPath,
    projects,
    error,
    checkedAt: Date.now(),
  };
}
