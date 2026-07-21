import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolveAgentBin } from "../harness/index.ts";
import { grantRefusal } from "@shared/llm.ts";
import type { LlmRunOptions, LlmRunner } from "@shared/llm.ts";

const CODEX_BIN = resolveAgentBin("codex");
const DEFAULT_TIMEOUT_MS = Number(process.env.MISSION_CODEX_TIMEOUT_MS || 120_000);
const live = new Set<ReturnType<typeof spawn>>();

function headlessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MISSION_HEADLESS: "1" };
  delete env.TMUX_PANE;
  delete env.WEZTERM_PANE;
  return env;
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function killLiveCodexRuns(): void {
  for (const child of live) killTree(child);
  live.clear();
}

let exitHooked = false;
function hookExitOnce(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", killLiveCodexRuns);
}

/**
 * A fresh, ephemeral `codex exec` invocation. User configuration, project rules,
 * network access, writes, and approvals are disabled so embedded transcript text
 * cannot silently widen the run. Inspector grants are deliberately unsupported:
 * its diff remains in the prompt, but Codex cannot yet express Claude's exact
 * per-tool deny rules, so pretending to honour that grant would be unsafe.
 */
export const codexRunner: LlmRunner = {
  id: "codex",
  label: "Codex",

  async run(prompt: string, opts: LlmRunOptions = {}): Promise<string> {
    const grant = opts.grant ?? null;
    if (grant) {
      const refusal = grantRefusal(codexRunner.sandbox, grant);
      throw new Error(`codex runner refused the tool grant: ${refusal ?? "unsupported grant"}`);
    }
    return await new Promise((resolve, reject) => {
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--color", "never",
        "-c", 'approval_policy="never"',
        "-c", "features.shell_tool=false",
        "-c", "features.unified_exec=false",
      ];
      if (opts.model) args.push("--model", opts.model);
      args.push("-");
      const child = spawn(CODEX_BIN, args, {
        cwd: tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
        env: headlessEnv(),
        detached: true,
      });
      hookExitOnce();
      live.add(child);
      let out = "";
      let err = "";
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        live.delete(child);
      };
      const timer = setTimeout(() => {
        killTree(child);
        done();
        reject(new Error("codex exec timed out"));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (out += d));
      child.stderr.on("data", (d: string) => (err += d));
      child.stdin.on("error", () => {});
      child.on("error", (e) => {
        done();
        reject(e);
      });
      child.on("close", (code) => {
        done();
        if (code === 0) resolve(out.trim());
        else reject(new Error(`codex exited ${code}: ${err.slice(0, 300)}`));
      });
      child.stdin.end(prompt);
    });
  },

  runInThread: null,
  sandbox: null,
  litter: null,
  killLiveRuns: killLiveCodexRuns,
};
