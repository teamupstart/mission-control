#!/usr/bin/env node
// Rank the processes a traced `node --test` run started, by command and by test file.
//
// Input is the directory `test/spawn-trace.mjs` wrote (one `<pid>.jsonl` per test worker),
// plus git's own trace2 events in `<trace-dir>/trace2` - the complete git count, and the one
// to compare runs by. `docs/runbooks/test-process-churn.md` has the command.
//
// Optionally also `git-shim.log`, from a `git` placed first on PATH that logs each exec,
// attributed to its test file, before running the real one. It sees what trace2 cannot name
// as a top-level command (git run by a shell script or a spawned daemon), at the cost of an
// extra exec per git, and because it sits in front of `/usr/bin/git` it also turns off the
// workers' xcrun shim bypass (`test/git-environment.mjs`) - so never compare a shimmed run's
// totals with an unshimmed one. A shim that does this:
//
//   #!/bin/sh
//   printf '@@G\t%s\t%s\n' "${MISSION_TEST_SPAWN_TRACE_FILE:-(outside a test)}" "$*" \
//     >> /tmp/trace/git-shim.log
//   exec /usr/bin/git "$@"
//
// Usage: node scripts/test-spawn-report.mjs <trace-dir> [--top N] [--json]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const topIndex = args.indexOf("--top");
const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 25;
const asJson = args.includes("--json");
if (!dir || !existsSync(dir)) {
  console.error("usage: node scripts/test-spawn-report.mjs <trace-dir> [--top N] [--json]");
  process.exit(2);
}

/** The git subcommand, past the global options that may precede it. */
function gitSubcommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return "(none)";
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const ranked = (map, n = top) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const byCmd = new Map();
const byFile = new Map();
const gitByFile = new Map();
const gitBySub = new Map();
const gitByOrigin = new Map();
const gitByCaller = new Map();
const files = new Set();
let direct = 0;
let shellSpawns = 0;
// Every traced process writes one `start` line: test workers, and the node processes
// descended from them (the tracer rides `NODE_OPTIONS`). Traces from before that existed
// have none, and their whole-run total below is reported as unknown.
const starts = [];

for (const name of readdirSync(dir)) {
  if (!name.endsWith(".jsonl")) continue;
  for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.event === "start") {
      starts.push(entry);
      continue;
    }
    direct++;
    if (entry.shell) shellSpawns++;
    files.add(entry.file);
    bump(byCmd, entry.cmd);
    bump(byFile, entry.file);
    if (entry.cmd === "git") {
      bump(gitByFile, entry.file);
      bump(gitBySub, gitSubcommand(entry.argv));
      const caller = entry.caller ?? "(not recorded)";
      bump(gitByOrigin, caller.split("/")[0].split(":")[0]);
      bump(gitByCaller, caller);
    }
  }
}

// The shim's count is the total; the in-process tracer's git rows are a subset of it.
const shimPath = join(dir, "git-shim.log");
const shimByFile = new Map();
const shimBySub = new Map();
let shimTotal = 0;
if (existsSync(shimPath)) {
  for (const line of readFileSync(shimPath, "utf8").split("\n")) {
    if (!line.startsWith("@@G\t")) continue; // a continuation of a multi-line argument
    const [, file, rest = ""] = line.split("\t");
    shimTotal++;
    bump(shimByFile, file);
    bump(shimBySub, gitSubcommand(rest.split(" ")));
  }
}

// Git's own trace2 event stream counts every git process - including the ones git starts
// itself by absolute path (`git maintenance run --auto` after a commit, `upload-pack` and
// `receive-pack` behind a local clone or push), which neither a PATH shim nor the
// in-process tracer can see - and every non-git child git starts (`sh -c`, hooks).
// Captured with `GIT_TRACE2_EVENT=<trace-dir>/trace2` and
// `GIT_TRACE2_ENV_VARS=MISSION_TEST_SPAWN_TRACE_FILE`.
const trace2Dir = join(dir, "trace2");
const t2ByFile = new Map();
const t2ByCommand = new Map();
const t2Children = new Map();
let t2Processes = 0;
// On macOS `/usr/bin/git` is Apple's xcrun shim, which execs the real binary by its developer
// directory path - so a git whose argv[0] is that path cost one more exec, the shim's.
const SHIMMED = /\/(?:Developer|CommandLineTools)\/usr\/bin\/git$/;
let t2ViaShim = 0;
if (existsSync(trace2Dir)) {
  for (const name of readdirSync(trace2Dir)) {
    let sawStart = false;
    let file = "(outside a test)";
    let command = null;
    for (const line of readFileSync(join(trace2Dir, name), "utf8").split("\n")) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event === "start") {
        sawStart = true;
        if (SHIMMED.test(String((event.argv ?? [])[0] ?? ""))) t2ViaShim++;
        command = gitSubcommand((event.argv ?? []).slice(1));
      } else if (event.event === "cmd_name") command = event.name;
      else if (event.event === "def_param" && event.param === "MISSION_TEST_SPAWN_TRACE_FILE") file = event.value;
      // A child git runs through a shell costs a `sh` exec on top of the child itself, and
      // the child's own trace2 file counts only the second of the two.
      else if (event.event === "child_start" && event.use_shell) {
        bump(t2Children, String((event.argv ?? [])[0] ?? "?").split(" ")[0]);
      }
    }
    if (!sawStart) continue;
    t2Processes++;
    bump(t2ByFile, file);
    bump(t2ByCommand, command ?? "(unknown)");
  }
}

// A whole-run process total, assembled so nothing is counted twice:
//   test workers (the runner starts one per file; no traced process recorded those spawns)
// + every non-git spawn a traced process recorded
// + one `/bin/sh` per shell-mode spawn (`exec`, `execSync`, `shell: true`)
// + node processes whose parent was not traced (a shell script's node child), which no
//   traced spawn line already counted
// + every git process (trace2), every xcrun shim exec in front of one, and every shell git
//   started for a child.
// Git spawn lines are left out of the second term because the git terms count them.
// Still invisible, so this is a lower bound: what a non-node, non-git process starts (a shell
// script's `ps`, `sed`, `date`), Electron's own helper processes, and the test runner itself.
const tracedPids = new Set(starts.map((start) => `${start.pid}`));
const workers = starts.filter((start) => start.role === "worker").length;
const nodeDescendants = starts.filter((start) => start.role === "descendant").length;
const untracedParents = starts.filter((start) => start.role === "descendant" && !tracedPids.has(`${start.ppid}`)).length;
const wholeRun = starts.length === 0 || !existsSync(trace2Dir) ? null : {
  testWorkers: workers,
  nonGitSpawns: direct - (byCmd.get("git") ?? 0),
  shellsForShellModeSpawns: shellSpawns,
  nodeDescendantsOfUntracedParents: untracedParents,
  gitProcesses: t2Processes,
  xcrunShimExecs: t2ViaShim,
  shellsStartedByGit: [...t2Children.values()].reduce((a, b) => a + b, 0),
};
const wholeRunTotal = wholeRun ? Object.values(wholeRun).reduce((a, b) => a + b, 0) : null;

const report = {
  processTotal: wholeRunTotal,
  processTotalParts: wholeRun,
  tracedNodeDescendants: nodeDescendants,
  testWorkersThatSpawned: files.size,
  directSpawns: direct,
  directGit: byCmd.get("git") ?? 0,
  gitIncludingIndirect: existsSync(shimPath) ? shimTotal : null,
  byCommand: ranked(byCmd, 40),
  byFile: ranked(byFile),
  gitByFile: ranked(gitByFile),
  gitBySubcommand: ranked(gitBySub, 30),
  gitByOrigin: ranked(gitByOrigin),
  gitByCaller: ranked(gitByCaller),
  gitProcesses: existsSync(trace2Dir) ? t2Processes : null,
  gitStartedThroughXcrunShim: existsSync(trace2Dir) ? t2ViaShim : null,
  shellsStartedByGit: [...t2Children.values()].reduce((a, b) => a + b, 0),
  gitProcessesByFile: ranked(t2ByFile),
  gitProcessesByCommand: ranked(t2ByCommand, 30),
  shellsStartedByGitFor: ranked(t2Children, 15),
  shimGitByFile: ranked(shimByFile),
  shimGitBySubcommand: ranked(shimBySub, 30),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const table = (title, rows) => {
    if (!rows.length) return;
    console.log(`\n## ${title}\n\n| count | key |\n| ---: | --- |`);
    for (const [key, count] of rows) console.log(`| ${count} | \`${key}\` |`);
  };
  if (report.processTotal !== null) {
    console.log(`whole-run process total (a lower bound; see the comment above it): ${report.processTotal}`);
    for (const [part, count] of Object.entries(report.processTotalParts)) console.log(`  ${part}: ${count}`);
  }
  console.log(`spawns recorded by traced node processes (workers and their node descendants): ${report.directSpawns}`);
  console.log(`direct git spawns: ${report.directGit}`);
  if (report.gitIncludingIndirect !== null) {
    console.log(`git execs including indirect (shim): ${report.gitIncludingIndirect}`);
  }
  if (report.gitProcesses !== null) {
    console.log(`git processes (trace2, every git exec incl. git's own children): ${report.gitProcesses}`);
    console.log(`  of which started through Apple's xcrun shim, one extra exec each: ${report.gitStartedThroughXcrunShim}`);
    console.log(`shells git started to run a child (trace2): ${report.shellsStartedByGit}`);
  }
  table("Direct spawns by command", report.byCommand);
  table("Direct spawns by test file", report.byFile);
  table("Direct git spawns by test file", report.gitByFile);
  table("Direct git spawns by subcommand", report.gitBySubcommand);
  table("Direct git spawns by origin (test fixture vs code under test)", report.gitByOrigin);
  table("Direct git spawns by call site", report.gitByCaller);
  table("git processes by test file (trace2)", report.gitProcessesByFile);
  table("git processes by command (trace2)", report.gitProcessesByCommand);
  table("Shells git started, by the child they ran (trace2)", report.shellsStartedByGitFor);
  table("All git execs by test file (shim)", report.shimGitByFile);
  table("All git execs by subcommand (shim)", report.shimGitBySubcommand);
}
