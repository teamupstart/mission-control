#!/usr/bin/env node
// Rank the processes a traced `node --test` run started, by command and by test file.
//
// Input is the directory `test/spawn-trace.mjs` wrote (one `<pid>.jsonl` per traced process),
// plus git's own trace2 events in `<trace-dir>/trace2` - the complete git count, and the one
// to compare runs by. `docs/runbooks/test-process-churn.md` has the command.
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
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(a)) {
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
let failedLaunches = 0;
// Child pids the traced processes recorded, so a node child that loads the tracer itself is
// recognised as already counted even when its parent exited first and it was reparented.
const spawnedPids = new Set();
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
    // A missing or unrunnable executable is recorded, but started no process.
    if (entry.launched === false) {
      failedLaunches++;
      continue;
    }
    direct++;
    if (typeof entry.pid === "number" && entry.pid > 0) spawnedPids.add(`${entry.pid}`);
    if (entry.shell) shellSpawns++;
    files.add(entry.file);
    bump(byCmd, entry.cmd);
    bump(byFile, entry.file);
    if (entry.cmd === "git") {
      bump(gitByFile, entry.file);
      // Traces from before the tracer stopped storing arguments carry `argv` instead.
      bump(gitBySub, entry.sub ?? gitSubcommand(entry.argv ?? []));
      const caller = entry.caller ?? "(not recorded)";
      bump(gitByOrigin, caller.split("/")[0].split(":")[0]);
      bump(gitByCaller, caller);
    }
  }
}

// Git's own trace2 event stream counts every git process - including the ones git starts
// itself by absolute path (`git maintenance run --auto` after a commit, `upload-pack` and
// `receive-pack` behind a local clone or push), which the in-process tracer cannot see - and
// the shells git starts for a child. Captured with `GIT_TRACE2_EVENT=<trace-dir>/trace2` and
// `GIT_TRACE2_ENV_VARS=MISSION_TEST_SPAWN_TRACE_FILE`.
const trace2Dir = join(dir, "trace2");
const t2ByFile = new Map();
const t2ByCommand = new Map();
const t2Shells = new Map();
let t2Processes = 0;
// On macOS `/usr/bin/git` is Apple's xcrun shim, which execs the real binary by its developer
// directory path - so a git whose argv[0] is that path cost one more exec, the shim's.
const SHIMMED = /\/(?:Developer|CommandLineTools)\/usr\/bin\/git$/;
let t2ViaShim = 0;
// Git's own rule (run-command.c, `prepare_shell_cmd`): a `use_shell` child goes through
// `sh -c` only when its command contains a shell metacharacter. Otherwise git execs it
// directly, and there is no shell to count.
const SHELL_METACHARACTERS = /[|&;<>()$`\\"' \t\n*?[#~=%]/;
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
      else if (event.event === "child_start" && event.use_shell) {
        const child = String((event.argv ?? [])[0] ?? "");
        if (SHELL_METACHARACTERS.test(child)) bump(t2Shells, child.split(/\s/)[0] || "?");
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
// + every non-git spawn a traced process recorded that actually started. A shell-mode spawn
//   (`exec`, `execSync`, `shell: true`) counts once: the shell runs a builtin itself and execs
//   a lone program in its own place, so one recorded spawn is one process
// + node processes no traced spawn line accounts for - neither a recorded child pid nor the
//   child of a traced process (a shell script's node child)
// + every git process (trace2), every xcrun shim exec in front of one, and every shell git
//   inserted in front of a child.
// Git spawn lines are left out of the second term because the git terms count them.
// Still invisible, so this is a lower bound: what a non-node, non-git process starts (a shell
// script's `ps`, `sed`, `date`), Electron's own helper processes, and the test runner itself.
const tracedPids = new Set(starts.map((start) => `${start.pid}`));
const workers = starts.filter((start) => start.role === "worker").length;
const nodeDescendants = starts.filter((start) => start.role === "descendant").length;
const unaccounted = starts.filter((start) =>
  start.role === "descendant" && !spawnedPids.has(`${start.pid}`) && !tracedPids.has(`${start.ppid}`)).length;
const shellsStartedByGit = [...t2Shells.values()].reduce((a, b) => a + b, 0);
const wholeRun = starts.length === 0 || !existsSync(trace2Dir) ? null : {
  testWorkers: workers,
  nonGitSpawns: direct - (byCmd.get("git") ?? 0),
  nodeDescendantsNoSpawnAccountsFor: unaccounted,
  gitProcesses: t2Processes,
  xcrunShimExecs: t2ViaShim,
  shellsStartedByGit,
};
const wholeRunTotal = wholeRun ? Object.values(wholeRun).reduce((a, b) => a + b, 0) : null;

const report = {
  processTotal: wholeRunTotal,
  processTotalParts: wholeRun,
  shellModeSpawns: shellSpawns,
  failedLaunches,
  tracedNodeDescendants: nodeDescendants,
  testWorkersThatSpawned: files.size,
  directSpawns: direct,
  directGit: byCmd.get("git") ?? 0,
  byCommand: ranked(byCmd, 40),
  byFile: ranked(byFile),
  gitByFile: ranked(gitByFile),
  gitBySubcommand: ranked(gitBySub, 30),
  gitByOrigin: ranked(gitByOrigin),
  gitByCaller: ranked(gitByCaller),
  gitProcesses: existsSync(trace2Dir) ? t2Processes : null,
  gitStartedThroughXcrunShim: existsSync(trace2Dir) ? t2ViaShim : null,
  shellsStartedByGit,
  gitProcessesByFile: ranked(t2ByFile),
  gitProcessesByCommand: ranked(t2ByCommand, 30),
  shellsStartedByGitFor: ranked(t2Shells, 15),
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
  console.log(`  not counted: ${report.failedLaunches} recorded launches that started no process`);
  console.log(`direct git spawns: ${report.directGit}`);
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
}
