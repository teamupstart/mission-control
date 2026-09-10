import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_ISSUE_REQUIRED_LABELS,
  PRODUCT_ISSUE_STATUS_LABEL,
} from "../../src/shared/product-issues.ts";

/**
 * Stand-in `claude`, `codex` and `pi` binaries, so this suite spends nothing.
 *
 * This works because of a property of the daemon rather than a trick played on it: NOTHING
 * in `src/` talks to a model API directly. There is no `api.anthropic.com`, no
 * `ANTHROPIC_API_KEY`, and the only `BASE_URL` is the daemon's own loopback address. Every
 * model interaction is a spawned CLI subprocess whose path comes from ONE resolution chain,
 * `resolveBinSpec` in `src/server/harness/bin.ts`:
 *
 *     MISSION_<AGENT>_BIN ?? FLEET_<AGENT>_BIN ?? HARNESS_<AGENT>_BIN ?? <legacy> ?? "<agent>"
 *
 * The Agent SDK runtime goes through the same chain: `claude/sdk-deps.ts` deliberately pins
 * `pathToClaudeCodeExecutable` to the harness's own resolution rather than letting the
 * vendor package find its bundled CLI, precisely so an operator's `MISSION_CLAUDE_BIN`
 * wrapper is honoured. So there is no path - terminal or SDK - that reaches a real model
 * once these three are set.
 *
 * Each fake also RECORDS what it was handed, which turns the mock from a cost dam into an
 * assertion surface: a test can check the argv, the cwd, and the absence of inherited pane
 * env rather than only that the UI moved.
 */
export interface FakeAgents {
  /** Directory the fakes write their invocation records into. */
  recordDir: string;
  bins: {
    claude: string;
    codex: string;
    pi: string;
    cmux: string;
    herdr: string;
    wezterm: string;
    keepAwake: string;
    gh: string;
    jira: string;
  };
}

/**
 * `"signed-out"` is not a third flavour of failure: it is Pi answering successfully with
 * an empty model list, which is exactly what a real installation with no provider
 * credentials does. The daemon reads it as `unavailable`, which is the only outcome that
 * identifies a missing sign-in rather than a broken probe.
 */
export type FakePiCatalogMode = "success" | "failure" | "signed-out";

/** Where the Pi fake reads its per-invocation catalog behavior. */
export function piCatalogControlPath(home: string): string {
  return join(home, "fake-pi-catalog-mode.txt");
}

/** Switch the next and later Pi catalog probes without changing daemon environment. */
export function writePiCatalogMode(home: string, mode: FakePiCatalogMode): void {
  writeFileSync(piCatalogControlPath(home), `${mode}\n`);
}

/**
 * Where the managed Pi runtime's stand-in SDK lives, and the models it will accept.
 *
 * Pi is the only harness whose managed runtime has no subprocess, so `MISSION_PI_BIN`
 * cannot reach it: its SDK is imported into the daemon. `MISSION_PI_SDK_MODULE` is the same
 * redirection at the only seam that exists, and it is set for EVERY daemon this suite
 * starts - a run that forgot it would import the real package and could reach a provider.
 */
export function fakePiSdkModulePath(): string {
  return fileURLToPath(new URL("./fake-pi-sdk.mjs", import.meta.url));
}

/** The model ids the fake SDK will launch. Anything else fails the way an absent one does. */
export const FAKE_PI_SDK_MODELS = [
  "amazon-bedrock/deepseek.v3.2",
  "amazon-bedrock/anthropic.claude-sonnet-4-5",
  "openai/gpt-5.6-sol",
  "anthropic/claude-sonnet-5",
] as const;

export function piSdkModelsPath(home: string): string {
  return join(home, "fake-pi-sdk-models.json");
}

/** The two outcomes the Codex catalog probe drives, from its own control file. */
export type FakeCodexCatalogMode = "success" | "failure";

/** Where the Codex fake reads its per-request `model/list` behavior. */
export function codexCatalogControlPath(home: string): string {
  return join(home, "fake-codex-catalog-mode.txt");
}

/** Switch the next and later Codex catalog probes without changing daemon environment. */
export function writeCodexCatalogMode(home: string, mode: FakeCodexCatalogMode): void {
  writeFileSync(codexCatalogControlPath(home), `${mode}\n`);
}

/**
 * One pull request `FAKE_GH` will report, in the shape `gh pr list --json …` prints.
 *
 * `cwd` is not a `gh` field - it is which CHECKOUT this pull request belongs to, which is how
 * the fake decides who a `pr list` is answering for. See the fake's header.
 */
export interface FakePullRequest {
  /** Absolute path of the worktree whose `gh pr list` should report this pull request. */
  cwd: string;
  url: string;
  number: number;
  state: "OPEN" | "MERGED";
  /** ISO instant. Must be after the session's work episode started, or adoption refuses it. */
  createdAt: string;
  mergedAt: string | null;
  headRefOid: string;
}

/** Where a spec scripts `FAKE_GH`'s pull requests for one daemon. */
export function ghPullRequestsPath(home: string): string {
  return join(home, "gh-prs.json");
}

/** Script what `gh` reports, for this daemon, from now on. Re-read by the fake per call. */
export function writeGhPullRequests(home: string, prs: readonly FakePullRequest[]): void {
  writeFileSync(ghPullRequestsPath(home), JSON.stringify(prs, null, 2));
}

/** The issue `FAKE_GH` says it created, and the id the daemon derives from it. */
export const FAKE_GH_ISSUE_URL = "https://github.com/acme/demo-repo/issues/123";
export const FAKE_GH_ISSUE_ID = "acme/demo-repo#123";

/**
 * How `FAKE_GH` should behave for the public product-report path.
 *
 * The product reporter asks `gh` four read-only questions before it will publish anything -
 * `--version`, `auth status`, `repo view`, and the label listing - and only then runs
 * `issue create`. A spec that wants to see the form's "GitHub CLI is not authenticated"
 * copy has to be able to fail exactly one of those and leave the rest working, which is
 * what `preflight` selects. `issueCreate` then picks between the three terminal outcomes
 * the form draws differently: a created issue, a retry-safe refusal, and an unknown result
 * that must NOT invite a retry.
 *
 * Kept separate from the pull-request script above because they answer different verbs and
 * a spec should be able to set one without disturbing the other.
 */
export interface FakeGhProductScript {
  preflight: "ok" | "gh-unavailable" | "gh-version" | "gh-auth" | "repository" | "labels";
  issueCreate: "created" | "partial" | "partial-no-url" | "refused" | "unknown";
  /** The labels `repos/<target>/labels` reports. Defaults to the full required set. */
  labels?: readonly string[];
}

export const FAKE_GH_PRODUCT_ISSUE_URL = "https://github.com/acme/public-issues/issues/4242";

/** Where a spec scripts `FAKE_GH`'s product-report behavior for one daemon. */
export function ghProductScriptPath(home: string): string {
  return join(home, "gh-product-script.json");
}

export function productAuthorizationScriptPath(home: string): string {
  return join(home, "product-authorization-script.json");
}

export function productAuthorizationBinPath(home: string): string {
  return join(home, "bin", "product-authorization");
}

/**
 * Stand in for the Electron shell's private authorization channel.
 *
 * The shipped daemon asks its parent utility process. This fixture daemon has no Electron
 * parent, so the launch-time command seam supplies the same grant/refusal boundary without
 * making any real external call. A process that chooses the daemon environment has already
 * replaced the daemon, just as with the MISSION_GH_BIN blast dam below.
 */
export function writeProductAuthorizationBin(home: string): string {
  const bin = productAuthorizationBinPath(home);
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const { readFileSync, appendFileSync } = require('node:fs');",
      `const script = ${JSON.stringify(productAuthorizationScriptPath(home))};`,
      `const log = ${JSON.stringify(join(home, "product-authorization-asked.jsonl"))};`,
      "const [requestId, draftIdentity, target, title] = process.argv.slice(2);",
      "appendFileSync(log, JSON.stringify({ requestId, draftIdentity, target, title }) + String.fromCharCode(10));",
      "let answer = 'grant';",
      "try { answer = JSON.parse(readFileSync(script, 'utf8')).answer; } catch {}",
      "process.exit(answer === 'grant' ? 0 : 1);",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  writeProductAuthorizationScript(home, { answer: "grant" });
  return bin;
}

export interface FakeProductAuthorizationScript {
  answer: "grant" | "refuse";
}

export function writeProductAuthorizationScript(
  home: string,
  script: FakeProductAuthorizationScript,
): void {
  writeFileSync(productAuthorizationScriptPath(home), JSON.stringify(script, null, 2));
}

/**
 * Script the product-report path. Re-read by the fake per call, so a spec can move from a
 * blocked preflight to a working one without restarting the daemon.
 */
export function writeGhProductScript(home: string, script: FakeGhProductScript): void {
  writeFileSync(ghProductScriptPath(home), JSON.stringify(script, null, 2));
}

/**
 * How `FAKE_GH` should answer the two write-back verbs.
 *
 * These are the calls a task source makes ONTO an item somebody else is watching, and both
 * are why this fake is a blast dam rather than a cost dam: `gh issue comment` posts on a
 * real thread and `gh issue close` moves real work, and neither is undone by deleting a row
 * in the daemon's ledger. On a developer's machine, where `gh` is signed in, an unfaked run
 * would do both for real.
 *
 * `refused` is the shape a retry-safe refusal has - a non-zero exit with a message and no
 * effect - which is the state the panel's **Retry** exists to clear. Distinguished from the
 * default here rather than from the daemon's side, because the whole point of the failed /
 * unknown split is that it is read off what the process did.
 */
export interface FakeGhWritebackScript {
  comment?: "ok" | "refused";
  close?: "ok" | "refused";
}

/** Where a spec scripts `FAKE_GH`'s write-back behavior for one daemon. */
export function ghWritebackScriptPath(home: string): string {
  return join(home, "gh-writeback-script.json");
}

export function writeGhWritebackScript(home: string, script: FakeGhWritebackScript): void {
  writeFileSync(ghWritebackScriptPath(home), JSON.stringify(script, null, 2));
}

/**
 * The stand-in terminal backend, so a spec can watch what a click asks a terminal to run.
 *
 * cmux, not tmux, and the choice is structural. tmux availability is a question about a
 * PAIR - its sessions open detached, so `terminalTargetViews` reports it unavailable unless
 * an emulator exists to raise them, and CI has neither. cmux is the one backend whose
 * sessions need nobody's help to be seen (`attachArgv: null`), whose binary resolves
 * through an env override (`CMUX_BIN`), and whose launch is a single `new-workspace`
 * subprocess call - one fake, and the continue-in-terminal path is drivable end to end on
 * a machine with no terminal at all.
 *
 * The record it writes is the assertion surface: `--command` carries the exact shell
 * command the workspace would run, which is where a resumed conversation's argv - and the
 * permission mode it must carry - either shows up or provably does not.
 *
 * CommonJS `require`, deliberately: the file is extension-less, which Node treats as CJS,
 * and an `import` here would crash the fake at spawn time in a way that reads as a
 * launch failure rather than a broken fixture.
 */
const FAKE_CMUX = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);

// Answered BEFORE the record is written, and deliberately not recorded. Setup probes the
// control socket every time the panel is read, so recording this would turn "how many
// commands did a click run" - which several specs count - into a function of how often a
// browser looked at a page. \`MC_E2E_CMUX_CONTROL\` reproduces the two states that stand
// between an installed cmux and a working one, in cmux's own words.
if (argv[0] === "capabilities") {
  const control = process.env.MC_E2E_CMUX_CONTROL;
  if (control === "stopped") {
    process.stderr.write("Error: Socket not found at " + join(process.env.MISSION_HOME || "/tmp", "cmux.sock") + "\\n");
    process.exit(1);
  }
  if (control === "refused") {
    process.stderr.write("Error: ERROR: Access denied - only processes started inside cmux can connect\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ access_mode: "allowAll", methods: [] }) + "\\n");
  process.exit(0);
}

const dir = process.env.MC_E2E_RECORD_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`cmux-\${Date.now()}-\${process.pid}.json\`),
    JSON.stringify({ argv }, null, 2),
  );
}
if (process.env.MC_E2E_CMUX_MODE === "unknown") {
  setInterval(() => {}, 1000);
}
`;

/**
 * A disposable Herdr-compatible default server for the one E2E spec that opts into it.
 * It implements only Mission Control's bounded protocol surface, records every mutation,
 * and starts a free fake `claude` descendant for PID-ancestry discovery. No real Herdr or
 * agent binary is reachable from this process.
 */
const FAKE_HERDR = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const home = process.env.MISSION_HOME;
const socketPath = join(home, "fake-herdr.sock");
const recordPath = join(process.env.MC_E2E_RECORD_DIR, "herdr-requests.jsonl");
const status = (body) => process.stdout.write(JSON.stringify(body) + "\\n");
// "newer" is a Herdr past the supported floor on both axes, which is what a real 0.9.0 is.
// Mission Control pins a minimum, not an equality, so this must be as ordinary as the floor.
const newer = process.env.MC_E2E_HERDR_MODE === "newer";
const VERSION = newer ? "0.9.0" : "0.8.2";
const PROTOCOL = newer ? 22 : 20;
// 0.9.0 renamed the \`pane.split\` response type. It is the one response whose type moved
// without a field moving, so a fake claiming to be 0.9.0 has to answer under the new name or
// it quietly stops standing in for the server it names.
const SPLIT_TYPE = newer ? "pane_info" : "pane_created";
// A server that accepts the command and whose shell never runs it - which is what every Herdr
// dispatch used to be, when the Enter was swallowed inside the bracketed paste. The pane keeps
// answering with its login shell and nothing else, so a launch has something to actually fail
// against rather than only a passing path to confirm.
const stuck = process.env.MC_E2E_HERDR_MODE === "stuck";
if (argv[0] === "status" && argv[1] === "server") {
  if (process.env.MC_E2E_HERDR_MODE === "incompatible") {
    status({ status: "running", running: true, version: "0.7.0", protocol: 19, capabilities: {}, compatible: false, socket: socketPath, session: null, restart_needed: true });
  } else {
    const running = existsSync(socketPath);
    status({ status: running ? "running" : "not_running", running, version: running ? VERSION : null, protocol: running ? PROTOCOL : null, capabilities: running ? {} : null, compatible: running ? true : null, socket: socketPath, session: null, restart_needed: false });
  }
  process.exit(0);
}
if (argv[0] === "server") {
  if (!existsSync(socketPath)) {
    const child = spawn(process.execPath, [__filename, "serve", String(process.ppid)], {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    child.unref();
  }
  process.exit(0);
}
if (argv[0] !== "serve") process.exit(0);

rmSync(socketPath, { force: true });
let serial = 0;
const workspaces = new Map();
const agents = new Map();
const record = (request) => appendFileSync(recordPath, JSON.stringify(request) + "\\n");
const stopAgent = (paneId) => {
  const child = agents.get(paneId);
  if (!child) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  agents.delete(paneId);
};
const ensureAgent = (pane) => {
  if (agents.has(pane.pane_id)) return agents.get(pane.pane_id).pid;
  const fakeDir = join(home, "fake-herdr-agent");
  mkdirSync(fakeDir, { recursive: true });
  const agentBin = join(fakeDir, "claude");
  const script = join(fakeDir, "agent.mjs");
  if (!existsSync(agentBin)) symlinkSync(process.execPath, agentBin);
  writeFileSync(script, "setInterval(() => {}, 1000);\\n");
  const command = JSON.stringify(agentBin) + " " + JSON.stringify(script);
  // Discovery deliberately ignores headless agents. The script utility gives this fake the same real
  // controlling tty an agent has inside a Herdr pane, while remaining portable across the
  // two supported hosts. Cleanup kills its detached process group.
  const args = process.platform === "darwin"
    ? ["-q", "/dev/null", agentBin, script]
    : ["-q", "-c", command, "/dev/null"];
  const child = spawn("/usr/bin/script", args, {
    cwd: pane.cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  agents.set(pane.pane_id, child);
  pane.shell_pid = child.pid;
  return child.pid;
};
// What the pane is REALLY running, which is what \`pane.process_info\` reports and what the
// launch path now verifies before it calls a launch successful. \`shell_pid\` is the pane's
// shell - here the \`script\` process that owns the tty - and the agent is its child, so the
// two pids differ exactly as they do on a real server. Cached once resolved: the launch polls
// this, and so does discovery on its 100ms tick.
const foregroundProcesses = (pane) => {
  if (!pane) return [];
  // The measured shape of a real stuck pane: one foreground process, and its pid IS the
  // login shell's. Nothing was ever started under it.
  if (pane.stuck) return [{ pid: pane.shell_pid, name: "zsh", cwd: pane.cwd }];
  if (!pane.shell_pid) return [];
  if (pane.foreground_pid) return [{ pid: pane.foreground_pid, name: "node", cwd: pane.cwd }];
  try {
    const found = execFileSync("pgrep", ["-P", String(pane.shell_pid)], { encoding: "utf8" })
      .split("\\n").map((line) => Number(line.trim())).filter((pid) => pid > 0);
    if (found.length) pane.foreground_pid = found[0];
  } catch {
    // pgrep exits 1 when the shell has no children yet. That is "still only the shell",
    // which is the honest answer and the one a launch keeps polling through.
  }
  return pane.foreground_pid
    ? [{ pid: pane.foreground_pid, name: "node", cwd: pane.cwd }]
    : [{ pid: pane.shell_pid, name: "script", cwd: pane.cwd }];
};
// Stable Herdr closes a non-subscription connection after its first response.
const ok = (socket, id, result = { type: "ok" }) => socket.end(JSON.stringify({ id, result }) + "\\n");
const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      const request = JSON.parse(line);
      record(request);
      const p = request.params || {};
      if (request.method === "session.snapshot") {
        const values = [...workspaces.values()];
        ok(socket, request.id, {
          type: "session_snapshot",
          snapshot: {
            version: VERSION, protocol: PROTOCOL,
            workspaces: values.map((x) => ({ workspace_id: x.workspaceId, label: x.label })),
            tabs: values.map((x) => ({ tab_id: x.tabId, workspace_id: x.workspaceId, number: 1, label: "main" })),
            panes: values.flatMap((x) => x.panes.map((pane) => ({ pane_id: pane.pane_id, workspace_id: x.workspaceId, tab_id: x.tabId, cwd: pane.cwd, foreground_cwd: pane.cwd }))),
            layouts: [], agents: [],
          },
        });
      } else if (request.method === "pane.process_info") {
        const pane = [...workspaces.values()].flatMap((x) => x.panes).find((x) => x.pane_id === p.pane_id);
        ok(socket, request.id, { type: "pane_process_info", process_info: { pane_id: p.pane_id, shell_pid: pane?.shell_pid || null, tty: null, foreground_processes: foregroundProcesses(pane) } });
      } else if (request.method === "workspace.create") {
        serial += 1;
        const workspaceId = "fake-workspace-" + serial;
        const tabId = workspaceId + ":tab";
        const pane = { pane_id: workspaceId + ":pane", cwd: p.cwd, shell_pid: stuck ? process.pid : null, pasted: "", foreground_pid: null, stuck };
        workspaces.set(workspaceId, { workspaceId, tabId, label: p.label, panes: [pane] });
        ok(socket, request.id, {
          type: "workspace_created",
          workspace: { workspace_id: workspaceId, label: p.label },
          tab: { tab_id: tabId, workspace_id: workspaceId, number: 1, label: "main" },
          root_pane: { pane_id: pane.pane_id, workspace_id: workspaceId, tab_id: tabId, cwd: pane.cwd, foreground_cwd: pane.cwd },
        });
      } else if (request.method === "pane.send_input") {
        // A paste lands in the pane's edit buffer and runs NOTHING until it is submitted.
        // Modelling that is the point: Mission Control used to send the text and its Enter in
        // one call, and at dispatch size the Enter was swallowed by the shell's bracketed
        // paste, so the command sat here unexecuted. The Enter arrives separately below.
        const pane = [...workspaces.values()].flatMap((x) => x.panes).find((x) => x.pane_id === p.pane_id);
        if (pane) pane.pasted = String(p.text || "");
        if (pane && Array.isArray(p.keys) && p.keys.includes("enter")) ensureAgent(pane);
        ok(socket, request.id);
      } else if (request.method === "pane.send_keys") {
        const pane = [...workspaces.values()].flatMap((x) => x.panes).find((x) => x.pane_id === p.pane_id);
        if (!stuck && pane && Array.isArray(p.keys) && p.keys.includes("enter") && pane.pasted) ensureAgent(pane);
        ok(socket, request.id);
      } else if (request.method === "pane.split") {
        const workspace = [...workspaces.values()].find((x) => x.panes.some((pane) => pane.pane_id === p.target_pane_id));
        const pane = { pane_id: workspace.workspaceId + ":side", cwd: p.cwd, shell_pid: null, pasted: "", foreground_pid: null };
        workspace.panes.push(pane);
        ok(socket, request.id, { type: SPLIT_TYPE, pane: { pane_id: pane.pane_id, workspace_id: workspace.workspaceId, tab_id: workspace.tabId, cwd: pane.cwd, foreground_cwd: pane.cwd } });
      } else if (request.method === "pane.read") {
        const pane = [...workspaces.values()].flatMap((x) => x.panes).find((x) => x.pane_id === p.pane_id);
        // Wrapped across two rows the way a real pane wraps a long command, so a reader that
        // matched on layout rather than on content would fail here.
        const shown = pane?.pasted
          ? "~ % " + String(pane.pasted).slice(0, 8) + "\\n" + String(pane.pasted).slice(8)
          : "fake Herdr pane output";
        ok(socket, request.id, { type: "pane_read", read: { pane_id: p.pane_id, text: shown } });
      } else if (request.method === "workspace.rename") {
        const workspace = workspaces.get(p.workspace_id);
        if (workspace) workspace.label = p.label;
        ok(socket, request.id);
      } else if (request.method === "workspace.close") {
        const workspace = workspaces.get(p.workspace_id);
        if (workspace) for (const pane of workspace.panes) stopAgent(pane.pane_id);
        workspaces.delete(p.workspace_id);
        ok(socket, request.id);
      } else {
        ok(socket, request.id);
      }
    }
  });
});
// The server process is deliberately reparented, matching stable Herdr's
// detached_server_daemon capability. Keep the original disposable daemon PID only as a
// cleanup watchdog so a failed E2E worker cannot leave this fake behind.
const parentPid = Number(argv[1]);
const leave = () => {
  for (const paneId of agents.keys()) stopAgent(paneId);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 100).unref();
};
process.on("SIGTERM", leave);
process.on("SIGINT", leave);
setInterval(() => {
  try { process.kill(parentPid, 0); } catch { leave(); }
}, 100).unref();
server.listen(socketPath);
`;

const FAKE_WEZTERM = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.MC_E2E_RECORD_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, \`wezterm-\${Date.now()}-\${process.pid}.json\`), JSON.stringify({ argv: process.argv.slice(2) }, null, 2));
}
`;

/**
 * The stand-in `gh`, so a spec can watch what the daemon asks GitHub to do - and so that it
 * never actually asks.
 *
 * This one is not a cost dam like the agent fakes; it is a BLAST dam. `gh issue create` files
 * an issue into a repository other people are watching, and it cannot be taken back by
 * deleting a row here - so the one place that could do it for real is redirected at this,
 * through `MISSION_GH_BIN` (see `ghBin()` in `src/server/config.ts`). Without it a suite run
 * on a developer's machine, where `gh` is signed in, would file a real issue on every pass.
 *
 * That override is whole-codebase rather than push-only, which has a consequence this fake
 * owns: the PR poller reaches it too. Its `gh pr list --json …` output is parsed as JSON, and
 * a fake that printed nothing would turn every existing spec's PR lookup into a parse error,
 * so `pr list` and `issue list` answer with an empty array - "nothing found", the state every
 * spec that does not care about a PR is already in.
 *
 * A spec that DOES care writes `MC_E2E_GH_PRS` (see `writeGhPullRequests`), and then `pr list`
 * answers for the checkout it was run in and `pr view` answers for the url it was asked about.
 * Keyed on the cwd because that is the only thing that distinguishes one repository's pull
 * request from another's here: a multi-repo task cuts the SAME branch name in every repo, so
 * `--head` cannot tell them apart, and the daemon's whole per-repo fan-out is the claim that
 * it asks in each worktree separately. Re-read on every call, so a spec can merge one pull
 * request and leave its sibling open between two polls.
 *
 * The record it writes is the assertion surface: the argv carries the title, the body and one
 * `--label` per label the source sweeps on, and the cwd is the repo the issue is filed
 * against - which is where a push aimed at the wrong repository would show up.
 *
 * CommonJS `require`, for the reason `FAKE_CMUX` gives: the file is extension-less, which Node
 * treats as CJS, and an `import` here would crash at spawn time in a way that reads as a
 * missing `gh` rather than as a broken fixture.
 */
const FAKE_GH = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const dir = process.env.MC_E2E_RECORD_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`gh-\${Date.now()}-\${process.pid}.json\`),
    JSON.stringify({ argv, cwd: process.cwd() }, null, 2),
  );
}
const command = argv.join(" ");
/** Whatever the spec last scripted, re-read per call. Absent or unreadable means none. */
function scriptedPrs() {
  const path = process.env.MC_E2E_GH_PRS;
  if (!path) return [];
  try {
    return JSON.parse(require("node:fs").readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}
/**
 * The product-report script, re-read per call. Absent means the working default: every
 * preflight question answers yes and a create succeeds, which is what a spec that does not
 * care about this path already expects.
 */
function productScript() {
  const fallback = { preflight: "ok", issueCreate: "created" };
  const path = process.env.MC_E2E_GH_PRODUCT;
  if (!path) return fallback;
  try {
    return { ...fallback, ...JSON.parse(require("node:fs").readFileSync(path, "utf8")) };
  } catch {
    return fallback;
  }
}
/** The write-back script, re-read per call. Absent means both verbs succeed. */
function writebackScript() {
  const fallback = { comment: "ok", close: "ok" };
  const path = process.env.MC_E2E_GH_WRITEBACK;
  if (!path) return fallback;
  try {
    return { ...fallback, ...JSON.parse(require("node:fs").readFileSync(path, "utf8")) };
  } catch {
    return fallback;
  }
}
const REQUIRED_LABELS = ${JSON.stringify(PRODUCT_ISSUE_REQUIRED_LABELS)};
const product = productScript();
/** Fail exactly the scripted preflight question, the way the real CLI fails it. */
function preflightRefusal(stage) {
  if (product.preflight !== stage) return false;
  process.stderr.write(stage + " unavailable\\n");
  process.exit(1);
}
if (argv[0] === "--version") {
  preflightRefusal("gh-unavailable");
  process.stdout.write(
    product.preflight === "gh-version"
      ? "gh version 2.98.0 (fake)\\n"
      : "gh version 2.101.0 (fake)\\n",
  );
} else if (command.startsWith("auth status")) {
  preflightRefusal("gh-auth");
  process.stdout.write("Logged in to github.com as fake\\n");
} else if (command.startsWith("repo view")) {
  preflightRefusal("repository");
  process.stdout.write((argv[2] || "acme/public-issues") + "\\n");
} else if (argv[0] === "api" && command.includes("/labels")) {
  // The --slurp form prints one array of PAGES, each a page of label objects. The daemon parses
  // exactly that shape, so the fake has to nest rather than print a flat list.
  const names = product.preflight === "labels"
    ? REQUIRED_LABELS.filter((name) => name !== "usability")
    : (product.labels || REQUIRED_LABELS);
  process.stdout.write(JSON.stringify([names.map((name) => ({ name }))]) + "\\n");
} else if (command.startsWith("issue comment") || command.startsWith("issue close")) {
  // The two write-back verbs. Recorded above like everything else, so a spec reads the body
  // and the close reason off the argv - and nothing is published either way.
  const verb = argv[1] === "comment" ? "comment" : "close";
  if (writebackScript()[verb] === "refused") {
    process.stderr.write("could not " + verb + " issue: HTTP 403 (fake)\\n");
    process.exit(1);
  }
} else if (command.startsWith("issue create") && command.includes("${PRODUCT_ISSUE_STATUS_LABEL}")) {
  // A product report, distinguished from every other \`issue create\` by the fixed triage
  // label only the product reporter attaches. Task sources and the PR path keep their
  // existing behavior below.
  if (product.issueCreate === "refused") {
    process.stderr.write("could not create issue: label not found\\n");
    process.exit(1);
  } else if (product.issueCreate === "unknown") {
    // The shape the daemon must treat as "may have happened": exit 0, no URL.
    process.stdout.write("\\n");
  } else if (product.issueCreate === "partial") {
    process.stdout.write("${FAKE_GH_PRODUCT_ISSUE_URL}\\n");
    process.stderr.write("failed to upload second.png: request failed\\n");
    process.exit(1);
  } else if (product.issueCreate === "partial-no-url") {
    process.stderr.write("attachment publication failed before gh returned the issue URL\\n");
    process.exit(1);
  } else {
    process.stdout.write("${FAKE_GH_PRODUCT_ISSUE_URL}\\n");
  }
} else if (command.startsWith("issue create")) {
  // What the real gh prints on success: the URL of the issue in the requested repository,
  // and nothing else. An omitted --repo means gh derives the repository from the cwd; the
  // fake's seeded checkout represents acme/demo-repo.
  const repoIndex = argv.indexOf("--repo");
  const requested = repoIndex >= 0 ? argv[repoIndex + 1] : "acme/demo-repo";
  const parts = requested.split("/");
  const host = parts.length === 3 ? parts.shift() : "github.com";
  process.stdout.write("https://" + host + "/" + parts.join("/") + "/issues/123\\n");
} else if (command.startsWith("pr view")) {
  const url = argv[2];
  const found = scriptedPrs().find((pr) => pr.url === url);
  if (found) process.stdout.write(JSON.stringify({ state: found.state, mergedAt: found.mergedAt ?? null }) + "\\n");
} else if (command.startsWith("pr list")) {
  const here = scriptedPrs().filter((pr) => pr.cwd === process.cwd());
  process.stdout.write(JSON.stringify(here) + "\\n");
} else if (command.startsWith("issue list")) {
  process.stdout.write("[]\\n");
}
`;

/**
 * The stand-in `jira`, and the sharpest blast dam in this file.
 *
 * `gh issue create` publishes something new, which a person can delete. A Jira write-back
 * MOVES AN ISSUE: `jira issue move MC-431 "Done"` transitions a ticket in somebody's
 * project, on a board other people are working from, and nothing here takes that back. On a
 * machine where the operator ran `jira init` - which is every machine this source was built
 * for - an unfaked binary would do exactly that during a suite run. `jiraBin()`
 * (`src/server/config.ts`) is the single seam every `jira` subprocess resolves through, so
 * `MISSION_JIRA_BIN` closes the sweep and both write-back verbs with one variable.
 *
 * It answers rather than merely exiting, for the reason `FAKE_GH` does: the override is
 * whole-codebase, so a Jira source's sweep reaches this too, and `--raw` output that was not
 * JSON would turn a preflight into a parse error instead of the empty, healthy filter every
 * spec that does not care about Jira is already in.
 *
 * CommonJS `require`, for the reason `FAKE_CMUX` gives: the file is extension-less, which
 * Node treats as CJS, and an `import` here would crash at spawn time in a way that reads as
 * a missing `jira` rather than as a broken fixture.
 */
const FAKE_JIRA = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const dir = process.env.MC_E2E_RECORD_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`jira-\${Date.now()}-\${process.pid}.json\`),
    JSON.stringify({ argv, cwd: process.cwd() }, null, 2),
  );
}
const command = argv.join(" ");
if (command.startsWith("issue list")) {
  // The envelope both rungs read, holding nothing: a filter that is simply up to date.
  process.stdout.write('{"issues":[]}\\n');
} else if (command.startsWith("issue comment add") || command.startsWith("issue move")) {
  // What the real CLI prints on success. The record above is the assertion surface.
  process.stdout.write("done\\n");
} else if (argv[0] === "version" || argv[0] === "--version") {
  process.stdout.write("jira version 1.5.0 (fake)\\n");
}
`;

/**
 * The stand-in `caffeinate`, so the keep-awake spec can drive the real manager, routes
 * and SSE path without ever touching host power settings - `MISSION_KEEP_AWAKE_BIN`
 * makes this the provider under test on any platform, which is how Linux CI runs it.
 *
 * It records its argv at start (the assertion surface: `-i -w <daemon PID>` either
 * shows up exactly or provably does not) and an exit record when it goes, then behaves
 * like the real thing: it stays alive until SIGTERM, and it honours `-w <pid>` by
 * exiting when the watched process disappears - which is what keeps a SIGKILLed test
 * daemon from leaking an immortal fake into the operator's process table.
 *
 * CommonJS `require` for the reason FAKE_CMUX gives: the file is extension-less, which
 * Node treats as CJS.
 */
const FAKE_KEEP_AWAKE = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.MC_E2E_RECORD_DIR;
const record = (kind, body) => {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`keep-awake-\${process.pid}-\${kind}.json\`),
    JSON.stringify(body, null, 2),
  );
};
record("start", { argv: process.argv.slice(2), pid: process.pid });
const leave = (reason) => {
  record("exit", { reason });
  process.exit(0);
};
process.on("SIGTERM", () => leave("SIGTERM"));
const at = process.argv.indexOf("-w");
const watched = at >= 0 ? Number(process.argv[at + 1]) : null;
setInterval(() => {
  if (watched === null) return;
  try {
    process.kill(watched, 0);
  } catch {
    leave("watched-pid-gone");
  }
}, 250);
`;

/**
 * Write the three fakes into `home` and return their paths.
 *
 * The claude fake is COPIED to an extension-less path rather than symlinked or run in
 * place, because the vendored Agent SDK spawns `node <path>` for anything ending in
 * `.js`/`.mjs`/`.ts`/`.jsx`/`.tsx` and executes everything else directly. Extension-less
 * plus the file's own shebang is the combination that survives that branch.
 */
export function writeFakeAgents(home: string): FakeAgents {
  const binDir = join(home, "fake-bin");
  const recordDir = join(home, "agent-records");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });

  const claude = join(binDir, "fake-claude");
  copyFileSync(fileURLToPath(new URL("./fake-claude.mjs", import.meta.url)), claude);
  chmodSync(claude, 0o755);

  // Copied to an extension-less path for the same reason as its sibling above, though only
  // Claude's vendored SDK actually sniffs the extension: `spawnAppServer` execs the resolved
  // path directly, so the shebang is what picks the interpreter either way.
  const codex = join(binDir, "fake-codex");
  copyFileSync(fileURLToPath(new URL("./fake-codex.mjs", import.meta.url)), codex);
  chmodSync(codex, 0o755);
  writeCodexCatalogMode(home, "success");

  const pi = join(binDir, "fake-pi");
  copyFileSync(fileURLToPath(new URL("./fake-pi.mjs", import.meta.url)), pi);
  chmodSync(pi, 0o755);
  writePiCatalogMode(home, "success");
  // The managed runtime's half of the same dam. Written rather than passed as an env list
  // so a spec can widen it without restarting the daemon.
  writeFileSync(piSdkModelsPath(home), JSON.stringify(FAKE_PI_SDK_MODELS, null, 2));

  const cmux = join(binDir, "fake-cmux");
  writeFileSync(cmux, FAKE_CMUX);
  chmodSync(cmux, 0o755);

  const herdr = join(binDir, "fake-herdr");
  writeFileSync(herdr, FAKE_HERDR);
  chmodSync(herdr, 0o755);

  const wezterm = join(binDir, "fake-wezterm");
  writeFileSync(wezterm, FAKE_WEZTERM);
  chmodSync(wezterm, 0o755);

  const keepAwake = join(binDir, "fake-caffeinate");
  writeFileSync(keepAwake, FAKE_KEEP_AWAKE);
  chmodSync(keepAwake, 0o755);

  const gh = join(binDir, "fake-gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);

  const jira = join(binDir, "fake-jira");
  writeFileSync(jira, FAKE_JIRA);
  chmodSync(jira, 0o755);

  return { recordDir, bins: { claude, codex, pi, cmux, herdr, wezterm, keepAwake, gh, jira } };
}
