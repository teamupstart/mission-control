// A scriptable fake `claude` binary for headless-mode tests (P2). P13 uses it as it stands to
// assert a plain launch with no prompt, P14 extends it for install and upgrade, P16 reuses it.
//
// It is a real executable in a temporary directory, so code that spawns `claude` by path, by
// `MISSION_CLAUDE_BIN` or from `PATH` meets it unchanged. Its state is a JSON file beside it:
// the version it reports, the marketplaces and plugins it lists, scripted failures, and a log of
// every invocation with its argv and cwd. It spends no model tokens and never starts a session.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../temp-root.mjs";

export interface FakeClaudePlugin {
  /** `name@marketplace`, as `claude plugin install` takes it. */
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  errors?: string[];
}

/** A failure the fake plays for one `claude plugin` subcommand, then stops playing. */
export interface FakeClaudeFailure {
  exitCode: number;
  stderr: string;
  /** How many calls fail before the subcommand works again. Default 1. */
  times?: number;
}

export interface FakeClaudeState {
  /** What `claude --version` prints before ` (Claude Code)`. */
  version: string;
  /** When false, `claude plugin --help` lists no `marketplace` (an old Claude Code). */
  marketplaceSupported: boolean;
  marketplaces: string[];
  plugins: FakeClaudePlugin[];
  /** The version a `plugin install` records, standing for the staged `plugin.json` version. */
  stagedVersion: string;
  /** Keyed by `list`, `marketplace add`, `install`, `uninstall`, `validate` or `test`. */
  failures: Record<string, FakeClaudeFailure>;
}

export interface FakeClaudeInvocation {
  argv: string[];
  cwd: string;
  at: number;
}

export interface FakeClaude {
  /** The executable, for `MISSION_CLAUDE_BIN` or a `PATH` entry. */
  path: string;
  /** The directory that holds it, for a `PATH` entry. */
  dir: string;
  state: () => FakeClaudeState;
  update: (patch: Partial<FakeClaudeState>) => void;
  /** Sets the installed version of `mission-control@mission-control`, installing it when absent. */
  setInstalledVersion: (version: string, id?: string) => void;
  /** Every invocation, in order, including `--version` and `plugin` calls. */
  invocations: () => FakeClaudeInvocation[];
  /** Invocations that are not `--version` or `plugin ...`: what a person's `claude` run would be. */
  launches: () => FakeClaudeInvocation[];
  cleanup: () => void;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const statePath = path.join(dir, "state.json");
const logPath = path.join(dir, "invocations.jsonl");
const argv = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd(), at: Date.now() }) + "\\n");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (key) => {
  const f = state.failures[key];
  if (!f) return false;
  process.stderr.write(f.stderr + "\\n");
  const left = (f.times ?? 1) - 1;
  if (left <= 0) delete state.failures[key]; else f.times = left;
  save();
  process.exit(f.exitCode);
};
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const firstArg = (from) => { for (let i = from; i < argv.length; i++) { if (argv[i] === "--scope") { i++; continue; } if (!argv[i].startsWith("--")) return argv[i]; } return undefined; };

if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(state.version + " (Claude Code)\\n");
  process.exit(0);
}
if (argv[0] === "plugin") {
  const sub = argv[1];
  if (sub === "--help" || sub === "help" || sub === undefined) {
    process.stdout.write("Usage: claude plugin <command>\\n\\nCommands:\\n  list\\n" + (state.marketplaceSupported ? "  marketplace\\n" : "") + "  install\\n  uninstall\\n  validate\\n  test\\n");
    process.exit(0);
  }
  if (sub === "list") {
    fail("list");
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify(state.plugins.map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled, errors: p.errors }))) + "\\n");
    } else {
      process.stdout.write(state.plugins.map((p) => p.id + " (" + p.version + ", " + p.scope + ", " + (p.enabled ? "enabled" : "disabled") + ")").join("\\n") + (state.plugins.length ? "\\n" : ""));
    }
    process.exit(0);
  }
  if (sub === "marketplace" && argv[2] === "list") {
    fail("marketplace list");
    process.stdout.write(JSON.stringify(state.marketplaces.map((p) => ({ name: "mission-control", source: "directory", path: p }))) + "\\n");
    process.exit(0);
  }
  if (sub === "marketplace" && argv[2] === "add") {
    fail("marketplace add");
    const source = firstArg(3);
    if (source && !state.marketplaces.includes(source)) state.marketplaces.push(source);
    save();
    process.stdout.write("Added marketplace " + source + "\\n");
    process.exit(0);
  }
  if (sub === "install") {
    fail("install");
    const id = firstArg(2);
    const scope = flag("--scope") ?? "user";
    state.plugins = state.plugins.filter((p) => p.id !== id);
    state.plugins.push({ id, version: state.stagedVersion, scope, enabled: true });
    save();
    process.stdout.write("Installed " + id + "\\n");
    process.exit(0);
  }
  if (sub === "uninstall") {
    fail("uninstall");
    const id = firstArg(2);
    state.plugins = state.plugins.filter((p) => p.id !== id);
    save();
    process.stdout.write("Uninstalled " + id + "\\n");
    process.exit(0);
  }
  if (sub === "validate" || sub === "test") {
    fail(sub);
    process.stdout.write("Validation passed\\n");
    process.exit(0);
  }
  process.stderr.write("unknown plugin command " + sub + "\\n");
  process.exit(1);
}
// Anything else is a session launch: the fake records it above and exits at once.
process.exit(0);
`;

export function createFakeClaude(initial: Partial<FakeClaudeState> = {}): FakeClaude {
  const dir = tempDir("mission-fake-claude-");
  const bin = join(dir, "claude");
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "invocations.jsonl");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  mkdirSync(dir, { recursive: true });
  const base: FakeClaudeState = {
    version: "2.1.329",
    marketplaceSupported: true,
    marketplaces: [],
    plugins: [],
    stagedVersion: "2.2.0",
    failures: {},
    ...initial,
  };
  writeFileSync(statePath, JSON.stringify(base, null, 2));
  writeFileSync(logPath, "");

  const read = (): FakeClaudeState => JSON.parse(readFileSync(statePath, "utf8")) as FakeClaudeState;
  const write = (next: FakeClaudeState) => writeFileSync(statePath, JSON.stringify(next, null, 2));
  const invocations = (): FakeClaudeInvocation[] =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeClaudeInvocation)
      : [];

  return {
    path: bin,
    dir,
    state: read,
    update: (patch) => write({ ...read(), ...patch }),
    setInstalledVersion: (version, id = "mission-control@mission-control") => {
      const state = read();
      state.plugins = [...state.plugins.filter((p) => p.id !== id), { id, version, scope: "user", enabled: true }];
      write(state);
    },
    invocations,
    launches: () => invocations().filter((i) => i.argv[0] !== "--version" && i.argv[0] !== "-v" && i.argv[0] !== "plugin"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
