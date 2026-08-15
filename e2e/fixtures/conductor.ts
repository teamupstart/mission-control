import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in ai-conductor installation, and the canned state trees it would have written.
 *
 * Two things live here, and they are used by two different layers:
 *
 *  - `writeFakeConductor` installs a fake `conduct-ts` plus the `VERSION` file the version
 *    derivation reads. `e2e/fixtures/daemon.ts` points every daemon at it. That override is
 *    not only about determinism: without it, a suite run on a machine where the operator
 *    actually uses conductor would probe THEIR engine and list THEIR repositories in the
 *    Settings panel - the same class of hazard `MISSION_GH_BIN` closes.
 *  - `seedConductorRun` writes the files a real engine writes, so a run can be arranged
 *    without one. The daemon's readers are file readers, so this is the whole input.
 *
 * The seeding half is deliberately free of `@playwright/test` and of everything else in
 * this directory, so `test/` can import it too. There is one description of what a
 * conductor tree looks like, and both layers read it - a second copy under `test/` is how
 * a unit test comes to pass against a shape the browser test never meets.
 *
 * No spec ever spends a model token through any of this: nothing here launches an agent,
 * and the fake CLI prints JSON and exits.
 */

/** Where a spec scripts what the fake `conduct-ts` reports, for one daemon. */
export function conductorProjectsPath(home: string): string {
  return join(home, "conductor-projects.json");
}

/** One record in the engine's own project registry. */
export interface FakeConductorProject {
  name: string;
  path: string;
  remote?: string | null;
  status?: string;
}

/** Script which repositories the fake engine says it manages, from now on. Re-read per call. */
export function writeConductorProjects(
  home: string,
  projects: readonly FakeConductorProject[],
): void {
  writeFileSync(
    conductorProjectsPath(home),
    JSON.stringify(
      projects.map((p) => ({
        schemaVersion: 1,
        name: p.name,
        path: p.path,
        remote: p.remote ?? null,
        status: p.status ?? "registered",
        registeredAt: "2026-01-01T00:00:00.000Z",
      })),
      null,
      2,
    ),
  );
}

/** The version the fake installation reports, through its `VERSION` file. */
export const FAKE_CONDUCTOR_VERSION = "0.101.1-e2e";

/**
 * The stand-in engine CLI.
 *
 * It answers exactly one verb, `engineer projects`, with the compact JSON array the real
 * one prints - and nothing else, because nothing else is probed in this phase. Anything
 * unrecognised exits 0 having printed nothing, which is the real engine's own posture
 * (its `engineer` verbs exit 0 even on a malformed invocation) and therefore the case the
 * probe's "parse the stdout, never trust the exit code" rule has to survive.
 *
 * CommonJS `require`, deliberately: the file is extension-less, which Node treats as CJS,
 * and an `import` here would crash at spawn time in a way that reads as a missing engine
 * rather than as a broken fixture.
 */
const FAKE_CONDUCT_TS = `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "engineer" && argv[1] === "projects") {
  let projects = [];
  const path = process.env.MC_E2E_CONDUCTOR_PROJECTS;
  if (path) {
    try {
      projects = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      projects = [];
    }
  }
  process.stdout.write(JSON.stringify(projects) + "\\n");
}
`;

export interface FakeConductor {
  /** Absolute path of the fake CLI - what `MISSION_CONDUCTOR_BIN` points at. */
  bin: string;
  /** The installation root, holding `VERSION` and `bin/`. */
  root: string;
  /** Where the fake reads its scripted project list from. */
  projectsPath: string;
  /** A registry file inside the throwaway home, so the fallback cannot read a real one. */
  registryPath: string;
}

/**
 * Install the fake engine under `home` and return its paths.
 *
 * Laid out as `<root>/bin/conduct-ts` beside `<root>/VERSION` because that IS the layout
 * the version derivation reads - `bin/install` symlinks `~/.local/bin/conduct-ts` at the
 * harness's own `bin/`, and the harness root is where `VERSION` lives. A fake that put the
 * binary anywhere else would pass every assertion about detection while proving nothing
 * about the one derivation that has no CLI flag behind it.
 */
export function writeFakeConductor(home: string): FakeConductor {
  const root = join(home, "fake-conductor");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(root, "VERSION"), `${FAKE_CONDUCTOR_VERSION}\n`);
  const bin = join(binDir, "conduct-ts");
  writeFileSync(bin, FAKE_CONDUCT_TS);
  chmodSync(bin, 0o755);
  const projectsPath = conductorProjectsPath(home);
  writeConductorProjects(home, []);
  return {
    bin,
    root,
    projectsPath,
    registryPath: join(home, "fake-ai-conductor-registry.json"),
  };
}

// ---- canned state trees ------------------------------------------------------------------

/** What one seeded run's `conduct-state.json` should say. */
export interface SeedRunOptions {
  /**
   * Step name to status. Written as FLAT TOP-LEVEL KEYS beside the metadata, which is the
   * engine's own shape - a nested map here would make every parser test pass against a
   * file the real engine never writes.
   */
  steps?: Record<string, string>;
  lastStep?: string;
  tier?: "S" | "M" | "L";
  track?: "product" | "technical";
  prUrl?: string;
  /** The engine's `feature_status: 'complete'`. */
  complete?: boolean;
  worktreeBranch?: string;
  /** Gate verdicts, keyed by step. */
  gates?: Record<string, { satisfied: boolean; reason?: string; checkedAt?: number; kickbackFrom?: string }>;
  /** The `.pipeline/HALT` body. Its first non-empty line is the reason. */
  halt?: string;
  /** The `.pipeline/HALT.class` sidecar. Omit for an unclassified halt. */
  haltClass?: string;
  /** Write `.pipeline/DONE`. */
  done?: boolean;
  /** Lines to append to `.pipeline/events.jsonl`, each an engine event object. */
  events?: Record<string, unknown>[];
}

/** Where one seeded run's worktree lives. */
export function conductorWorktree(repoRoot: string, slug: string): string {
  return join(repoRoot, ".worktrees", slug);
}

/**
 * Write one feature's worktree exactly as the engine would.
 *
 * Returns the worktree path. Every file is optional: a run with no state file, no gates and
 * no halt is a legitimate arrangement (a worktree the engine has only just cut), and the
 * readers have to survive it.
 */
export function seedConductorRun(
  repoRoot: string,
  slug: string,
  options: SeedRunOptions = {},
): string {
  const worktree = conductorWorktree(repoRoot, slug);
  const pipeline = join(worktree, ".pipeline");
  mkdirSync(pipeline, { recursive: true });

  const state: Record<string, unknown> = { ...options.steps };
  if (options.lastStep !== undefined) state.last_step = options.lastStep;
  if (options.tier !== undefined) state.complexity_tier = options.tier;
  if (options.track !== undefined) state.track = options.track;
  if (options.prUrl !== undefined) state.pr_url = options.prUrl;
  if (options.complete) state.feature_status = "complete";
  if (options.worktreeBranch !== undefined) state.worktree_branch = options.worktreeBranch;
  state.worktree_dir = worktree;
  // Two-space pretty JSON with a trailing newline, which is what the engine's own atomic
  // writer produces.
  writeFileSync(join(pipeline, "conduct-state.json"), `${JSON.stringify(state, null, 2)}\n`);

  if (options.gates) {
    const gates = join(pipeline, "gates");
    mkdirSync(gates, { recursive: true });
    for (const [step, verdict] of Object.entries(options.gates)) {
      const body: Record<string, unknown> = {
        satisfied: verdict.satisfied,
        checkedAt: verdict.checkedAt ?? 1_700_000_000_000,
      };
      if (verdict.reason !== undefined) body.reason = verdict.reason;
      if (verdict.kickbackFrom !== undefined) {
        body.kickback = { from: verdict.kickbackFrom, evidence: "seeded" };
      }
      writeFileSync(join(gates, `${step}.json`), `${JSON.stringify(body, null, 2)}\n`);
    }
  }

  if (options.halt !== undefined) {
    writeFileSync(join(pipeline, "HALT"), `${options.halt}\n`);
    if (options.haltClass !== undefined) {
      writeFileSync(join(pipeline, "HALT.class"), options.haltClass);
    }
  }
  if (options.done) writeFileSync(join(pipeline, "DONE"), "gate-driven loop converged\n");
  if (options.events) {
    writeFileSync(
      join(pipeline, "events.jsonl"),
      `${options.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
  }
  return worktree;
}

/** What one seeded repository's `.daemon/` should say. */
export interface SeedDaemonOptions {
  /** A pidfile naming this process, so the reader's liveness probe says "running". */
  pid?: number;
  /** Write `.daemon/PAUSED`. */
  paused?: boolean;
  /** Slugs to park. */
  parked?: readonly string[];
  /** Slugs with a pending operator grant. */
  granted?: readonly string[];
  /** Slugs the daemon recorded as shipped, with the pull request it noted. */
  processed?: Record<string, { prUrl?: string | null }>;
}

/**
 * Write one repository's `.daemon/` directory.
 *
 * At the REPOSITORY root, not inside a worktree: the engine resolves this against the main
 * checkout through `git rev-parse --git-common-dir`, so one park namespace is shared by
 * every feature. Getting that wrong in a fixture is how a reader that looked in the wrong
 * place passes its own test.
 */
export function seedConductorDaemon(repoRoot: string, options: SeedDaemonOptions = {}): string {
  const dir = join(repoRoot, ".daemon");
  mkdirSync(dir, { recursive: true });
  if (options.pid !== undefined) {
    writeFileSync(
      join(dir, "daemon.pid"),
      JSON.stringify({
        pid: options.pid,
        uuid: "00000000-0000-4000-8000-000000000000",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  }
  if (options.paused) {
    writeFileSync(join(dir, "PAUSED"), JSON.stringify({ pausedAt: "2026-01-01T00:00:00.000Z" }));
  }
  if (options.parked?.length) {
    const parked = join(dir, "parked");
    mkdirSync(parked, { recursive: true });
    for (const slug of options.parked) {
      writeFileSync(join(parked, slug), "2026-01-01T00:00:00.000Z\nparked by operator\n");
    }
  }
  if (options.granted?.length) {
    const grants = join(dir, "grants");
    mkdirSync(grants, { recursive: true });
    for (const slug of options.granted) {
      writeFileSync(
        join(grants, `${slug}.json`),
        `${JSON.stringify({ version: 1, step: "build", grantedBy: "operator" })}\n`,
      );
    }
  }
  for (const [slug, entry] of Object.entries(options.processed ?? {})) {
    const processed = join(dir, "processed");
    mkdirSync(processed, { recursive: true });
    writeFileSync(
      join(processed, `${slug}.json`),
      `${JSON.stringify({ status: "shipped", prUrl: entry.prUrl ?? null })}\n`,
    );
  }
  return dir;
}
