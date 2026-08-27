import type { Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  MAX_PIPELINE_INSTALLER_CANDIDATES,
  PIPELINE_INSTALLER_CHANGE_IDS,
  type PipelineInstallerCandidate,
  type PipelineInstallerRuntime,
} from "@shared/pipeline.ts";

import { mainRepoRoot } from "../../util/git.ts";
import { run, type RunResult } from "../../util/exec.ts";

const UPSTREAM_REMOTE = "github.com/mancej/ai-conductor";
const EXPECTED_PACKAGE = "@james-stoup-agents/conductor";
const MAX_REPO_ROOTS = 500;
const MAX_GIT_OUTPUT = 16 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_VERSION_BYTES = 512;
const MAX_NODE_VERSION_BYTES = 256;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const NODE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const CONDUCTOR_NODE_REQUIREMENT = ">=26.0.0";
const CONDUCTOR_MIN_NODE = [26, 0, 0] as const;

export interface ConductorInstallerDeps {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  readFile(path: string, maxBytes: number): Promise<string>;
  mainRepoRoot(path: string): string | null;
  gitConfig(checkout: string): Promise<RunResult>;
}

export interface ConductorInstallerRuntimeDeps {
  nodeVersion(): Promise<RunResult>;
}

const DEFAULT_DEPS: ConductorInstallerDeps = {
  realpath,
  stat,
  readFile: async (path, maxBytes) => {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  },
  mainRepoRoot,
  gitConfig: (checkout) =>
    run("git", ["-C", checkout, "config", "--get-regexp", "^remote\\..*\\.url$"], {
      cwd: checkout,
      timeoutMs: 2_000,
      maxBuffer: MAX_GIT_OUTPUT,
    }),
};

const DEFAULT_RUNTIME_DEPS: ConductorInstallerRuntimeDeps = {
  nodeVersion: () =>
    run("node", ["--version"], {
      timeoutMs: 2_000,
      maxBuffer: MAX_NODE_VERSION_BYTES,
    }),
};

export type ConductorInstallerVerification =
  | { ok: true; candidate: PipelineInstallerCandidate }
  | { ok: false; reason: string };

/** Normalize the exact runtime answer `bin/install` itself reads from `node --version`. */
export function conductorInstallerRuntimeReading(version: string | null): PipelineInstallerRuntime {
  const match = version ? NODE_VERSION_PATTERN.exec(version.trim()) : null;
  const current = match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  const parts = match ? ([Number(match[1]), Number(match[2]), Number(match[3])] as const) : null;
  const supported =
    parts !== null &&
    (parts[0] > CONDUCTOR_MIN_NODE[0] ||
      (parts[0] === CONDUCTOR_MIN_NODE[0] &&
        (parts[1] > CONDUCTOR_MIN_NODE[1] ||
          (parts[1] === CONDUCTOR_MIN_NODE[1] && parts[2] >= CONDUCTOR_MIN_NODE[2]))));

  return {
    id: "node",
    label: "Node.js",
    current,
    requirement: CONDUCTOR_NODE_REQUIREMENT,
    supported,
    detail: supported
      ? `Node.js ${current} satisfies Conductor's ${CONDUCTOR_NODE_REQUIREMENT} requirement.`
      : current
        ? `Conductor requires Node.js 26 or newer, but this installer would use Node.js ${current}. Activate Node.js 26+ before installing.`
        : "Conductor requires Node.js 26 or newer, but Mission Control could not determine the Node.js version this installer would use. Activate Node.js 26+ before installing.",
  };
}

/** Read-only runtime preflight. Never executes checkout code and never throws. */
export async function conductorInstallerRuntime(
  overrides: Partial<ConductorInstallerRuntimeDeps> = {},
): Promise<PipelineInstallerRuntime> {
  const deps = { ...DEFAULT_RUNTIME_DEPS, ...overrides };
  try {
    const result = await deps.nodeVersion();
    if (
      result.code !== 0 ||
      result.outcomeUnknown ||
      result.overflowed ||
      Buffer.byteLength(result.stdout, "utf8") > MAX_NODE_VERSION_BYTES
    ) {
      return conductorInstallerRuntimeReading(null);
    }
    return conductorInstallerRuntimeReading(result.stdout);
  } catch {
    return conductorInstallerRuntimeReading(null);
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function regularFileInside(
  root: string,
  relativePath: string,
  deps: ConductorInstallerDeps,
): Promise<{ path: string; stat: Stats } | null> {
  try {
    const path = await deps.realpath(join(root, relativePath));
    if (!inside(root, path)) return null;
    const file = await deps.stat(path);
    return file.isFile() ? { path, stat: file } : null;
  } catch {
    return null;
  }
}

/**
 * Normalize only the recognized GitHub upstream identity.
 *
 * Raw remotes never cross the wire: they may contain credentials. Common HTTPS, SCP-style SSH,
 * and ssh:// spellings converge on one label; every other host, owner, suffix, port, query, or
 * fragment is refused rather than heuristically trimmed into trust.
 */
export function recognizedConductorRemote(remote: string): string | null {
  const value = remote.trim();
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/.exec(value);
  if (scp) {
    const repo = scp[2]!.endsWith(".git") ? scp[2]!.slice(0, -4) : scp[2]!;
    return scp[1] === "mancej" && repo === "ai-conductor" ? UPSTREAM_REMOTE : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
  if (parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.search || parsed.hash) {
    return null;
  }
  if (parsed.password || (parsed.protocol === "https:" && parsed.username)) return null;
  if (parsed.protocol === "ssh:" && parsed.username !== "git") return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const repo = parts[1]!.endsWith(".git") ? parts[1]!.slice(0, -4) : parts[1]!;
  return parts[0] === "mancej" && repo === "ai-conductor" ? UPSTREAM_REMOTE : null;
}

function recognizedRemoteFrom(result: RunResult): string | null {
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT) return null;
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  if (lines.length === 0) return null;
  let recognized: string | null = null;
  for (const line of lines) {
    const match = /^remote\.[^\s]+\.url[\t ]+(\S+)$/.exec(line);
    if (!match) return null;
    recognized ??= recognizedConductorRemote(match[1]!);
  }
  return recognized;
}

async function readBounded(
  file: { path: string; stat: Stats },
  maxBytes: number,
  deps: ConductorInstallerDeps,
): Promise<string | null> {
  if (file.stat.size > maxBytes) return null;
  const text = await deps.readFile(file.path, maxBytes);
  return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
}

/** Verify one checkout entirely through filesystem reads and a fixed git-config query. */
export async function verifyConductorInstallerCheckout(
  checkout: string,
  overrides: Partial<ConductorInstallerDeps> = {},
): Promise<ConductorInstallerVerification> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  let physical: string;
  try {
    physical = await deps.realpath(checkout);
  } catch {
    return { ok: false, reason: "checkout path could not be resolved" };
  }
  if (deps.mainRepoRoot(physical) !== physical) {
    return { ok: false, reason: "checkout is not an attributable main git checkout" };
  }

  const remote = recognizedRemoteFrom(await deps.gitConfig(physical));
  if (!remote) return { ok: false, reason: "checkout has no recognized upstream remote" };

  const installer = await regularFileInside(physical, "bin/install", deps);
  if (!installer || (installer.stat.mode & 0o111) === 0) {
    return { ok: false, reason: "bin/install is missing, outside the checkout, or not executable" };
  }

  const packageFile = await regularFileInside(physical, "src/conductor/package.json", deps);
  if (!packageFile) return { ok: false, reason: "the conductor package marker is missing" };
  let packageText: string | null;
  try {
    packageText = await readBounded(packageFile, MAX_PACKAGE_BYTES, deps);
  } catch {
    packageText = null;
  }
  if (!packageText) return { ok: false, reason: "the conductor package marker is unreadable" };
  try {
    const parsed = JSON.parse(packageText) as { name?: unknown };
    if (parsed.name !== EXPECTED_PACKAGE) {
      return { ok: false, reason: "the conductor package marker names another package" };
    }
  } catch {
    return { ok: false, reason: "the conductor package marker is malformed" };
  }

  const versionFile = await regularFileInside(physical, "VERSION", deps);
  if (!versionFile) return { ok: false, reason: "the VERSION marker is missing" };
  if (versionFile.stat.size > MAX_VERSION_BYTES) {
    return { ok: false, reason: "the VERSION marker is too large" };
  }
  let version: string | null = null;
  try {
    const text = await readBounded(versionFile, MAX_VERSION_BYTES, deps);
    if (text === null) return { ok: false, reason: "the VERSION marker is too large" };
    const trimmed = text.trim();
    if (!VERSION_PATTERN.test(trimmed) || text.includes("\0")) {
      return { ok: false, reason: "the VERSION marker is malformed" };
    }
    version = trimmed;
  } catch {
    // The marker was a bounded regular file when checked. A read racing a permissions or
    // filesystem change makes the version unknown, but does not invent a missing marker.
  }

  return {
    ok: true,
    candidate: {
      provider: "ai-conductor",
      checkout: physical,
      remote,
      version,
      changes: [...PIPELINE_INSTALLER_CHANGE_IDS],
    },
  };
}

/** Verify the bounded workspace catalog without walking another directory tree. */
export async function conductorInstallerCandidates(
  repoRoots: readonly string[],
): Promise<PipelineInstallerCandidate[]> {
  const candidates: PipelineInstallerCandidate[] = [];
  const seenInputs = new Set<string>();
  const seenPhysical = new Set<string>();
  for (const checkout of repoRoots.slice(0, MAX_REPO_ROOTS)) {
    if (seenInputs.has(checkout)) continue;
    seenInputs.add(checkout);
    const result = await verifyConductorInstallerCheckout(checkout);
    if (!result.ok) continue;
    if (seenPhysical.has(result.candidate.checkout)) continue;
    seenPhysical.add(result.candidate.checkout);
    candidates.push(result.candidate);
    if (candidates.length === MAX_PIPELINE_INSTALLER_CANDIDATES) break;
  }
  return candidates;
}

/** Reverify at click time, then return the exact upstream installer with no flags. */
export async function conductorInstallerTerminalArgv(
  checkout: string,
): Promise<
  | {
      candidate: PipelineInstallerCandidate;
      argv: string[];
      cwd: string;
      title: string;
    }
  | { refused: string }
> {
  const verified = await verifyConductorInstallerCheckout(checkout);
  if (!verified.ok) {
    return { refused: "That checkout is no longer a verified ai-conductor main checkout." };
  }
  return {
    candidate: verified.candidate,
    argv: [join(verified.candidate.checkout, "bin/install")],
    cwd: verified.candidate.checkout,
    title: "ai-conductor installer",
  };
}
