import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, normalize, resolve as resolvePath } from "node:path";
import type {
  ExecutableDiagnostic,
  ExecutableId,
  ExecutableSourceId,
} from "@shared/executables.ts";
import {
  executableCandidateContext,
  executableSpec,
  executableSpecForCommand,
  type ExecutableSpec,
} from "./catalog.ts";

export const EXECUTABLE_REFRESH_COOLDOWN_MS = 30_000;
export const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const PATH_MARKER = "__MISSION_PATH__";

interface PathEntry {
  directory: string;
  source: ExecutableSourceId;
  detail: string;
}

export interface ExecutableEnvironmentSnapshot {
  generation: number;
  path: string;
  entries: readonly PathEntry[];
  refreshedAtMs: number;
  loginShellProblem: string | null;
}

export interface ResolvedExecutable extends Omit<ExecutableDiagnostic, "id"> {
  /** Null means an operator-authored command rather than a built-in catalog entry. */
  id: ExecutableId | null;
  path: string;
  source: ExecutableSourceId;
  sourceDetail: string;
  env: NodeJS.ProcessEnv;
}

export interface LoginShellResult {
  path: string | null;
  problem: string | null;
}

export interface ExecutableLocatorDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  probeLoginShell?: (env: NodeJS.ProcessEnv) => Promise<LoginShellResult>;
  executable?: (path: string) => boolean;
}

function prefixedEnv(
  env: NodeJS.ProcessEnv,
  suffix: string,
): { name: string; value: string } | null {
  for (const prefix of ["MISSION", "FLEET", "HARNESS"] as const) {
    const name = `${prefix}_${suffix}`;
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function absoluteDirectory(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return normalize(trimmed);
}

function splitPath(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function isPathCommand(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

export async function probeLoginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
): Promise<LoginShellResult> {
  const shell = env.SHELL?.trim() || "/bin/zsh";
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: LoginShellResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      // `execFile` deliberately omits process-group ownership from its public options.
      // Spawn directly so startup-file grandchildren cannot outlive the discovery bound.
      const child = spawn(
        shell,
        ["-ilc", `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`],
        {
          detached: process.platform !== "win32",
          env,
          // Login startup files may emit substantial diagnostics. The probe does not
          // consume them, so discard stderr instead of allowing pipe backpressure to
          // turn a healthy shell into a timeout.
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let stdout = "";
      const terminate = (): void => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // The group already exited between observation and signalling.
          }
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length <= 1024 * 1024) return;
        terminate();
        finish({ path: null, problem: "login shell failed" });
      });
      child.once("error", () => finish({ path: null, problem: "login shell failed" }));
      child.once("close", (code) => {
        if (code !== 0) {
          finish({ path: null, problem: "login shell failed" });
          return;
        }
        const start = stdout.indexOf(PATH_MARKER);
        const end = start < 0 ? -1 : stdout.indexOf(PATH_MARKER, start + PATH_MARKER.length);
        const path = start >= 0 && end >= 0
          ? stdout.slice(start + PATH_MARKER.length, end).trim()
          : "";
        finish(path
          ? { path, problem: null }
          : { path: null, problem: "login shell returned no PATH" });
      });
      timer = setTimeout(() => {
        // Signalling only the direct shell leaves startup-file grandchildren alive. A
        // grandchild that keeps stdout or stderr open would make daemon initialization
        // unbounded, so kill the detached group and settle independently of `close`.
        terminate();
        finish({ path: null, problem: "login shell timed out" });
      }, timeoutMs);
      timer.unref?.();
    } catch {
      finish({ path: null, problem: "login shell failed" });
    }
  });
}

export class ExecutableLocator {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly probe: (env: NodeJS.ProcessEnv) => Promise<LoginShellResult>;
  private readonly isExecutable: (path: string) => boolean;
  private inheritedPath: string | null = null;
  private initialized = false;
  private snapshotValue: ExecutableEnvironmentSnapshot | null = null;
  private refreshInFlight: Promise<ExecutableEnvironmentSnapshot> | null = null;
  private readonly positive = new Map<string, ResolvedExecutable>();
  private readonly negative = new Map<string, { generation: number; at: number }>();

  constructor(deps: ExecutableLocatorDeps = {}) {
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.probe = deps.probeLoginShell ?? probeLoginShellPath;
    this.isExecutable = deps.executable ?? executableFile;
  }

  snapshot(): ExecutableEnvironmentSnapshot {
    return this.snapshotValue ?? this.installFallbackSnapshot();
  }

  async initialize(): Promise<ExecutableEnvironmentSnapshot> {
    if (this.initialized && this.snapshotValue) return this.snapshotValue;
    return await this.refresh({ force: true });
  }

  async refresh(
    options: { force?: boolean } = {},
  ): Promise<ExecutableEnvironmentSnapshot> {
    const current = this.snapshotValue;
    const now = this.now();
    if (
      !options.force &&
      current &&
      now - current.refreshedAtMs < EXECUTABLE_REFRESH_COOLDOWN_MS
    ) {
      return current;
    }
    if (this.refreshInFlight) return await this.refreshInFlight;
    this.inheritedPath ??= this.env.PATH ?? "";
    const pending = this.probe({ ...this.env, PATH: this.inheritedPath })
      .catch((): LoginShellResult => ({ path: null, problem: "login shell failed" }))
      .then((shell) => this.installSnapshot(shell));
    this.refreshInFlight = pending;
    try {
      const snapshot = await pending;
      this.initialized = true;
      return snapshot;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    }
  }

  environment(
    base: NodeJS.ProcessEnv = this.env,
    dropEnv: readonly string[] = [],
  ): NodeJS.ProcessEnv {
    // The snapshot is authoritative regardless of how the caller constructed its overlay.
    // Object identity and an earlier process.env mutation must never decide child lookup.
    return this.environmentAtPath(base, this.snapshot().path, dropEnv);
  }

  resolveSync(spec: ExecutableSpec): ResolvedExecutable | null {
    const snapshot = this.snapshot();
    const key = this.cacheKey(spec);
    const cached = this.positive.get(key);
    if (cached && cached.generation === snapshot.generation && this.isExecutable(cached.path)) {
      return { ...cached, env: this.environment(this.env, spec.dropEnv) };
    }
    this.positive.delete(key);
    const resolved = this.resolveFromSnapshot(spec, snapshot);
    if (resolved) this.positive.set(key, resolved);
    return resolved;
  }

  async resolve(
    spec: ExecutableSpec,
    options: { refreshOnMiss?: boolean } = {},
  ): Promise<ResolvedExecutable | null> {
    await this.initialize();
    const first = this.resolveSync(spec);
    if (first || options.refreshOnMiss === false) return first;
    const key = this.cacheKey(spec);
    const snapshot = this.snapshot();
    const negative = this.negative.get(key);
    const now = this.now();
    if (
      negative?.generation === snapshot.generation &&
      now - negative.at < EXECUTABLE_REFRESH_COOLDOWN_MS
    ) {
      return null;
    }
    this.negative.set(key, { generation: snapshot.generation, at: now });
    const refreshed = await this.refresh();
    if (refreshed.generation === snapshot.generation) return null;
    const resolved = this.resolveSync(spec);
    if (!resolved) this.negative.set(key, { generation: refreshed.generation, at: this.now() });
    return resolved;
  }

  async resolveCommand(
    command: string,
    options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ): Promise<ResolvedExecutable | null> {
    const spec = this.commandSpec(command, options.cwd);
    const base = options.env;
    if (!base) return await this.resolve(spec);

    await this.initialize();
    const snapshot = this.snapshot();
    // `run(..., { env })` historically allowed a caller to select an exact executable with
    // PATH. Treat that PATH as one bounded snapshot so lookup and spawn cannot disagree.
    if (base.PATH !== undefined && base.PATH !== snapshot.path) {
      const scoped = this.explicitChildPathSnapshot(base.PATH, snapshot);
      return this.resolveFromSnapshot(spec, scoped, base);
    }

    const resolved = await this.resolve(spec);
    return resolved
      ? { ...resolved, env: this.environment(base, spec.dropEnv) }
      : null;
  }

  resolveCommandSync(command: string): ResolvedExecutable | null {
    return this.resolveSync(this.commandSpec(command));
  }

  private commandSpec(command: string, cwd = process.cwd()): ExecutableSpec {
    const registered = executableSpecForCommand(command);
    if (registered) return registered;
    return {
      id: null,
      label: command,
      command: isPathCommand(command) ? resolvePath(cwd, command) : command,
      overrideEnv: null,
      legacyEnv: [],
      candidates: () => [],
      searchPath: true,
      dropEnv: [],
    };
  }

  async diagnostic(id: Parameters<typeof executableSpec>[0]): Promise<ExecutableDiagnostic> {
    const resolved = await this.resolve(executableSpec(id));
    if (resolved) {
      const { env: _env, ...diagnostic } = resolved;
      return { ...diagnostic, id };
    }
    const snapshot = this.snapshot();
    return {
      id,
      path: null,
      source: null,
      sourceDetail: snapshot.loginShellProblem,
      generation: snapshot.generation,
      refreshedAt: new Date(snapshot.refreshedAtMs).toISOString(),
    };
  }

  private cacheKey(spec: ExecutableSpec): string {
    const override = this.override(spec);
    return `${spec.id ?? "operator-command"}\0${spec.command}\0${override?.name ?? ""}\0${override?.value ?? ""}`;
  }

  private override(spec: ExecutableSpec): { name: string; value: string } | null {
    if (spec.overrideEnv) {
      const current = prefixedEnv(this.env, spec.overrideEnv);
      if (current) return current;
    }
    for (const name of spec.legacyEnv) {
      const value = this.env[name]?.trim();
      if (value) return { name, value };
    }
    return null;
  }

  private resolveFromSnapshot(
    spec: ExecutableSpec,
    snapshot: ExecutableEnvironmentSnapshot,
    baseEnv: NodeJS.ProcessEnv = this.env,
  ): ResolvedExecutable | null {
    const override = this.override(spec);
    if (override) {
      const found = this.find(override.value, snapshot.entries);
      if (found) {
        return this.result(spec, found.path, "operator-override", override.name, snapshot, baseEnv);
      }
      return null;
    }
    const context = executableCandidateContext(this.env);
    for (const candidate of spec.candidates({ ...context, platform: this.platform })) {
      if (!isAbsolute(candidate) || !this.isExecutable(candidate)) continue;
      return this.result(spec, candidate, "supported-location", candidate, snapshot, baseEnv);
    }
    const found = spec.searchPath ? this.find(spec.command, snapshot.entries) : null;
    return found
      ? this.result(spec, found.path, found.entry.source, found.entry.detail, snapshot, baseEnv)
      : null;
  }

  private explicitChildPathSnapshot(
    path: string,
    snapshot: ExecutableEnvironmentSnapshot,
  ): ExecutableEnvironmentSnapshot {
    const entries: PathEntry[] = [];
    const seen = new Set<string>();
    for (const value of splitPath(path)) {
      const directory = absoluteDirectory(value);
      if (!directory || seen.has(directory)) continue;
      seen.add(directory);
      entries.push({ directory, source: "runtime", detail: "explicit child PATH" });
    }
    return {
      ...snapshot,
      path: entries.map((entry) => entry.directory).join(delimiter),
      entries,
    };
  }

  private find(
    command: string,
    entries: readonly PathEntry[],
  ): { path: string; entry: PathEntry } | null {
    if (isAbsolute(command) || isPathCommand(command)) {
      const path = normalize(isAbsolute(command) ? command : resolvePath(command));
      if (!this.isExecutable(path)) return null;
      return {
        path,
        entry: { directory: path, source: "operator-override", detail: command },
      };
    }
    for (const entry of entries) {
      const path = join(entry.directory, command);
      if (this.isExecutable(path)) return { path: normalize(path), entry };
    }
    return null;
  }

  private result(
    spec: ExecutableSpec,
    path: string,
    source: ExecutableSourceId,
    sourceDetail: string,
    snapshot: ExecutableEnvironmentSnapshot,
    baseEnv: NodeJS.ProcessEnv = this.env,
  ): ResolvedExecutable {
    return {
      id: spec.id,
      path: normalize(path),
      source,
      sourceDetail,
      generation: snapshot.generation,
      refreshedAt: new Date(snapshot.refreshedAtMs).toISOString(),
      env: this.environmentAtPath(baseEnv, snapshot.path, spec.dropEnv),
    };
  }

  private environmentAtPath(
    base: NodeJS.ProcessEnv,
    path: string,
    dropEnv: readonly string[],
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, PATH: path };
    for (const name of dropEnv) delete env[name];
    return env;
  }

  private installFallbackSnapshot(): ExecutableEnvironmentSnapshot {
    this.inheritedPath ??= this.env.PATH ?? "";
    return this.installSnapshot({ path: null, problem: "login shell not read yet" });
  }

  private installSnapshot(shell: LoginShellResult): ExecutableEnvironmentSnapshot {
    const entries: PathEntry[] = [];
    const seen = new Set<string>();
    const add = (values: readonly string[], source: ExecutableSourceId, detail: string): void => {
      for (const value of values) {
        const directory = absoluteDirectory(value);
        if (!directory || seen.has(directory)) continue;
        seen.add(directory);
        entries.push({ directory, source, detail });
      }
    };
    const custom = prefixedEnv(this.env, "EXECUTABLE_PATHS");
    if (custom) add(splitPath(custom.value), "operator-directory", custom.name);
    add(splitPath(this.inheritedPath ?? this.env.PATH), "inherited-path", "PATH inherited by Mission Control");
    add(splitPath(shell.path ?? undefined), "login-shell", this.env.SHELL?.trim() || "/bin/zsh");

    const context = executableCandidateContext(this.env);
    const dataHome = this.env.XDG_DATA_HOME?.trim() || join(context.home, ".local", "share");
    const miseData = this.env.MISE_DATA_DIR?.trim() || join(dataHome, "mise");
    const miseShims = this.env.MISE_SHIMS_DIR?.trim() || join(miseData, "shims");
    const asdfData = this.env.ASDF_DATA_DIR?.trim() || join(context.home, ".asdf");
    const voltaHome = this.env.VOLTA_HOME?.trim() || join(context.home, ".volta");
    add(
      [
        join(context.home, ".local", "bin"),
        miseShims,
        join(asdfData, "shims"),
        join(voltaHome, "bin"),
        join(context.home, "go", "bin"),
      ],
      "version-manager",
      "supported per-user tool locations",
    );
    add(
      this.platform === "win32"
        ? []
        : ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"],
      "os-default",
      `${this.platform} supported defaults`,
    );
    const refreshedAtMs = this.now();
    const snapshot: ExecutableEnvironmentSnapshot = {
      generation: (this.snapshotValue?.generation ?? 0) + 1,
      path: entries.map((entry) => entry.directory).join(delimiter),
      entries,
      refreshedAtMs,
      loginShellProblem: shell.problem,
    };
    this.snapshotValue = snapshot;
    this.env.PATH = snapshot.path;
    this.positive.clear();
    this.negative.clear();
    return snapshot;
  }
}

export const executableLocator = new ExecutableLocator();

export async function initializeExecutableEnvironment(): Promise<ExecutableEnvironmentSnapshot> {
  return await executableLocator.initialize();
}

export async function refreshExecutableEnvironment(
  options: { force?: boolean } = {},
): Promise<ExecutableEnvironmentSnapshot> {
  return await executableLocator.refresh(options);
}

export function executableChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  dropEnv: readonly string[] = [],
): NodeJS.ProcessEnv {
  return executableLocator.environment(base, dropEnv);
}

export async function locateExecutable(
  id: Parameters<typeof executableSpec>[0],
): Promise<ResolvedExecutable | null> {
  return await executableLocator.resolve(executableSpec(id));
}

export function locateExecutableSync(
  id: Parameters<typeof executableSpec>[0],
): ResolvedExecutable | null {
  return executableLocator.resolveSync(executableSpec(id));
}

export function locateCommandSync(command: string): ResolvedExecutable | null {
  return executableLocator.resolveCommandSync(command);
}
