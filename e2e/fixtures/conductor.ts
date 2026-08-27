import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * Put a controllable `node --version` on the daemon's PATH without changing the runtime that
 * actually executes fixture scripts. Every invocation other than the read-only version probe
 * delegates to the real Node binary, so fake CLIs with `#!/usr/bin/env node` keep working.
 */
export function writeConductorNodeRuntime(home: string, version: string): string {
  const bin = join(home, "bin", "node");
  const nextBin = join(home, "bin", ".node-next");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(
    nextBin,
    [
      `#!${process.execPath}`,
      'const { spawnSync } = require("node:child_process");',
      `const reported = ${JSON.stringify(version)};`,
      'if (process.argv.length === 3 && process.argv[2] === "--version") {',
      '  process.stdout.write(`v${reported}\\n`);',
      "  process.exit(0);",
      "}",
      'if (process.argv.length === 4 && process.argv[2] === "-p" && process.argv[3] === "process.execPath") {',
      '  process.stdout.write(`${process.argv[1]}\\n`);',
      "  process.exit(0);",
      "}",
      "const child = spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit' });",
      "process.exit(child.status ?? 1);",
      "",
    ].join("\n"),
  );
  chmodSync(nextBin, 0o755);
  // Linux refuses an in-place write while an earlier probe still executes this shim.
  // Replacing the directory entry keeps the old inode alive for that process and gives
  // subsequent probes the newly selected version without an ETXTBSY race.
  renameSync(nextBin, bin);
  return bin;
}

/**
 * Give a disposable fixture repository the exact markers and upstream provenance the guided
 * installer verifier requires. The script is inert unless something actually executes it;
 * browser tests assert the fake terminal records it instead.
 */
export function seedConductorInstallerCheckout(repo: string): string {
  mkdirSync(join(repo, "bin"), { recursive: true });
  mkdirSync(join(repo, "src/conductor"), { recursive: true });
  writeFileSync(join(repo, "bin/install"), "#!/bin/sh\necho installer fixture must not execute >&2\nexit 91\n");
  chmodSync(join(repo, "bin/install"), 0o755);
  writeFileSync(
    join(repo, "src/conductor/package.json"),
    JSON.stringify({ name: "@james-stoup-agents/conductor" }, null, 2),
  );
  writeFileSync(join(repo, "VERSION"), `${FAKE_CONDUCTOR_VERSION}\n`);
  execFileSync("git", ["-C", repo, "remote", "set-url", "origin", "git@github.com:mancej/ai-conductor.git"]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@example.com",
      "commit",
      "-qm",
      "installer markers",
    ],
  );
  return repo;
}

/**
 * The stand-in engine CLI.
 *
 * It answers the verbs Mission Control actually spawns - `engineer projects` for detection,
 * and the control verbs - and NOTHING else. Anything unrecognised exits 0 having printed
 * nothing, which is the real engine's own posture (its `engineer` verbs exit 0 even on a
 * malformed invocation, and its argv detectors reject several others before the verb runs)
 * and therefore the exact case the "parse the stdout, never trust the exit code" rule exists
 * to survive.
 *
 * The control verbs WRITE the same marker files the real engine writes, and print the same
 * confirmation sentences. Both halves matter and they prove different things: the sentences
 * are what `control.ts`'s predicates read, and the markers are what the projection re-reads -
 * so a spec that presses Park watches the row become parked because a file moved, not because
 * a fixture told the dashboard what to think.
 *
 * `.daemon/` is resolved against the process's own working directory, which is what the real
 * `daemon park`, `decide-grant` and `reseal` do - none of them runs `git rev-parse` - and it
 * is why a verb spawned from the wrong directory is a bug this fake can actually reproduce.
 *
 * A live pidfile names the PARENT process, which is the Mission Control daemon that spawned
 * this. The projection's liveness check is `process.kill(pid, 0)`, so a pidfile naming this
 * short-lived fake would read as a dead daemon the moment it exited.
 *
 * CommonJS `require`, deliberately: the file is extension-less, which Node treats as CJS,
 * and an `import` here would crash at spawn time in a way that reads as a missing engine
 * rather than as a broken fixture.
 */
const FAKE_CONDUCT_TS = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const argv = process.argv.slice(2);

const log = process.env.MC_E2E_CONDUCTOR_LOG;
if (log) {
  appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
}

const daemonDir = join(process.cwd(), ".daemon");
const refusal = "the inline SDLC pipeline now runs under the \`inline\` subcommand";
// Half a verb, on demand. With \`.daemon/HALFWAY\` present a verb DOES its work - the marker
// moves, the projection will see it - and then says the wrong thing about it, which is the
// shape conductor has whenever a verb's confirmation and its side effect are not one atomic
// act. Mission Control has to report that as unconfirmed and still re-read the repository,
// so this is the fixture for "the state moved and nobody was told".
const halfway = existsSync(join(daemonDir, "HALFWAY")) && argv[0] !== "engineer";
const say = (line) => process.stdout.write((halfway ? refusal : line) + "\\n");
const flag = (name) => {
  const at = argv.indexOf("--" + name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
};

// The documented misbehaviour, on demand. With \`.daemon/REFUSE\` present every verb answers
// the way the real engine answers an invocation its argv detectors rejected: the generic
// sentence about the inline subcommand, on stdout, behind EXIT CODE 0 - and it does none of
// the work. A spec that writes that file is exercising the case the whole stdout posture
// exists for, rather than a failure mode invented here.
if (existsSync(join(daemonDir, "REFUSE")) && argv[0] !== "engineer") {
  process.stdout.write(refusal + "\\n");
  process.stdout.write("run \`conduct-ts inline --help\` for the verbs it carries\\n");
} else if (argv[0] === "engineer" && flag("idea") !== null) {
  // The ENGINEER SESSION, and it has to stay up.
  //
  // Mission Control spawns an engineer --idea <intent> host and then waits for
  // Conductor to create that intent's pipeline run. The real engine holds an interactive
  // agent open for as long as that takes. This fake used to match no branch at all for the
  // verb, so it printed nothing and exited immediately - and a host that ends before the run
  // appears is a task the daemon correctly FAILS, with "the managed Agent SDK host ended
  // before Conductor created pipeline run".
  //
  // A spec asserting on that host therefore passed only by sampling it faster than the exit
  // could propagate, which is luck the machine grants or withholds. Idling instead makes the
  // host as durable as the thing it stands in for, so the assertion is about adoption rather
  // than about scheduling. Teardown is the same graceful stop every other fake honours:
  // closing stdin ends it.
  process.stdin.resume();
  process.stdin.on("close", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else if (argv[0] === "engineer" && argv[1] === "projects") {
  let projects = [];
  const path = process.env.MC_E2E_CONDUCTOR_PROJECTS;
  if (path) {
    try {
      projects = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      projects = [];
    }
  }
  say(JSON.stringify(projects));
} else if (argv[0] === "register" && argv.length === 2) {
  const repoRoot = argv[1];
  const mode = process.env.MC_E2E_CONDUCTOR_REGISTER_MODE || "confirm";
  if (mode === "nonzero") {
    process.stderr.write("registry is not writable\\n");
    process.exit(2);
  }
  if (mode === "unconfirmed") {
    process.stdout.write("registration command completed\\n");
  } else {
    const path = process.env.MC_E2E_CONDUCTOR_PROJECTS;
    let projects = [];
    if (path) {
      try {
        projects = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        projects = [];
      }
      if (!projects.some((project) => project.path === repoRoot)) {
        projects.push({
          schemaVersion: 1,
          name: basename(repoRoot),
          path: repoRoot,
          remote: null,
          status: "registered",
          registeredAt: new Date().toISOString(),
        });
        writeFileSync(path, JSON.stringify(projects, null, 2));
      }
    }
    process.stdout.write("Registered " + basename(repoRoot) + " (" + repoRoot + ").\\n");
  }
} else if (argv[0] === "daemon" && argv[1] === "start") {
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(
    join(daemonDir, "daemon.pid"),
    JSON.stringify({ pid: process.ppid, uuid: "00000000-0000-4000-8000-000000000000", startedAt: new Date().toISOString() }),
  );
  say("daemon started (session conductor-fake)");
} else if (argv[0] === "daemon" && argv[1] === "stop") {
  rmSync(join(daemonDir, "daemon.pid"), { force: true });
  // Prints NOTHING when it works, and prints its failures to stdout. Silence is the success.
} else if (argv[0] === "daemon" && argv[1] === "pause") {
  const at = join(daemonDir, "PAUSED");
  if (existsSync(at)) {
    say("already paused");
  } else {
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(at, JSON.stringify({ pausedAt: new Date().toISOString() }));
    say("daemon paused");
  }
} else if (argv[0] === "daemon" && argv[1] === "resume") {
  const at = join(daemonDir, "PAUSED");
  if (existsSync(at)) {
    rmSync(at, { force: true });
    say("daemon resumed");
  } else {
    say("not paused");
  }
} else if (argv[0] === "daemon" && (argv[1] === "park" || argv[1] === "unpark")) {
  // A BARE POSITIONAL. The real verb has no --slug, and its detector returns null without
  // one - which falls through to a refusal that never mentions parking.
  const slug = argv[2];
  if (!slug || slug.startsWith("--")) {
    say("the inline SDLC pipeline now runs under the \`inline\` subcommand");
  } else {
    const marker = join(daemonDir, "parked", slug);
    if (argv[1] === "park") {
      if (existsSync(marker)) {
        say("'" + slug + "' is already parked");
      } else {
        mkdirSync(join(daemonDir, "parked"), { recursive: true });
        writeFileSync(marker, new Date().toISOString() + "\\nparked by operator\\n");
        say("Parked '" + slug + "' - no dispatch or re-kick until unparked");
      }
    } else if (existsSync(marker)) {
      rmSync(marker, { force: true });
      say("Unparked '" + slug + "'");
    } else {
      say("'" + slug + "' was not operator-parked");
    }
  }
} else if (argv[0] === "decide-grant") {
  const slug = flag("slug");
  const step = flag("step");
  const reason = flag("reason");
  if (!slug || !step || !reason) {
    say("the inline SDLC pipeline now runs under the \`inline\` subcommand");
  } else if (step === "plan") {
    process.stderr.write("re-entry to 'plan' is never granted\\n");
    process.exit(2);
  } else {
    mkdirSync(join(daemonDir, "grants"), { recursive: true });
    writeFileSync(
      join(daemonDir, "grants", slug + ".json"),
      JSON.stringify({ version: 1, step, reason, grantedBy: "operator" }) + "\\n",
    );
    say("DECIDE grant recorded for '" + step + "' in '" + slug + "'.");
  }
} else if (argv[0] === "reseal") {
  // The ceremony a person watches. It prints what it did and returns; the terminal it runs
  // in is held open by the daemon's own wrapper, not by this.
  const slug = flag("slug");
  say("Re-sealed " + argv.filter((a, i) => argv[i - 1] === "--path").length + " artifact(s) in '" + slug + "'.");
} else if (argv[0] === "daemon" && argv[1] === "connect") {
  say("attached to conductor-fake (read-only)");
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
  /**
   * Where the fake appends one JSON line per invocation.
   *
   * The assertion surface for a control verb: a spec that presses Park can read the argv the
   * daemon actually spawned and the directory it spawned it in, which is where the two
   * mistakes this integration can make - the wrong flag shape, and the wrong working
   * directory - are visible.
   */
  logPath: string;
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
    logPath: conductorLogPath(home),
  };
}

/** Where the fake engine records what it was asked to do, for one daemon. */
export function conductorLogPath(home: string): string {
  return join(home, "conductor-invocations.jsonl");
}

/** One thing the fake engine was asked to do. */
export interface ConductorInvocation {
  argv: string[];
  cwd: string;
}

/** Every verb the fake engine has been asked for, oldest first. Empty before the first. */
export function readConductorInvocations(home: string): ConductorInvocation[] {
  try {
    return readFileSync(conductorLogPath(home), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ConductorInvocation);
  } catch {
    return [];
  }
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
  /**
   * The engine's committed cost record, at `<worktree>/.docs/shipped/<slug>.md`.
   *
   * In the WORKTREE, because the engine writes and commits it on the feature branch just
   * before the pull request opens - it reaches the main checkout only when that request
   * merges, by which time the worktree is usually gone.
   */
  shipped?: SeedShippedCost;
}

/** The figures one shipped record carries, in the engine's own vocabulary. */
export interface SeedShippedCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /**
   * The price line, or `null` to leave it OUT of the record entirely.
   *
   * Omitting it is a real record rather than a broken one: an engine release that predates
   * the line, or a rollup that could price nothing, writes exactly this - token counts and
   * no dollars - and it is the case where a reader that defaults to zero reports somebody's
   * unpriced feature as having cost exactly nothing.
   */
  costUsd?: number | null;
  dispatches?: number;
  /** Dispatches with no usage record at all. */
  unmetered?: number;
  /** Dispatches that reported tokens but no price. */
  costUnmetered?: number;
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
  if (options.shipped) writeShippedRecord(worktree, slug, options.shipped);
  if (options.events) {
    writeFileSync(
      join(pipeline, "events.jsonl"),
      `${options.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
  }
  return worktree;
}

/**
 * Write one feature's shipped record, in the engine's own rendering of its cost block.
 *
 * The shape matters more than the numbers and it is copied rather than invented: bare
 * `key: value` lines under a `## Cost` heading, `unmetered` carrying two fields on one line,
 * an INDENTED per-provider breakdown that the reader must skip, and a following `## Time`
 * section whose own `key: value` lines must not leak into the cost block. A fixture that
 * omitted any of those would let a parser pass here and misread every real record.
 */
export function writeShippedRecord(
  worktree: string,
  slug: string,
  cost: SeedShippedCost,
): string {
  const dir = join(worktree, ".docs", "shipped");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  writeFileSync(
    path,
    [
      `# ${slug}`,
      "",
      "## Cost",
      "",
      `input: ${cost.input}`,
      `output: ${cost.output}`,
      `cache_read: ${cost.cacheRead ?? 0}`,
      `cache_creation: ${cost.cacheWrite ?? 0}`,
      // `null` leaves the line out, which is what an engine that could not price the feature
      // writes. `undefined` still means "priced at zero", so every existing caller is unmoved.
      ...(cost.costUsd === null ? [] : [`cost_usd: ${(cost.costUsd ?? 0).toFixed(4)}`]),
      `dispatches: ${cost.dispatches ?? 1}`,
      `unmetered: count: ${cost.unmetered ?? 0}, duration_ms: 0`,
      `cost_unmetered: count: ${cost.costUnmetered ?? 0}`,
      "  claude-sonnet: input: 1, output: 1, cost_usd: 0.0001",
      "",
      "## Time",
      "",
      "wall_ms: 1234",
      "input: not-a-cost-line",
      "",
    ].join("\n"),
  );
  return path;
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
