import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentBin } from "../harness/index.ts";
import { codexTokenSplit } from "../harness/codex/usage.ts";
import { estimateStandardApiUsage } from "../harness/codex/pricing.ts";
import { grantRefusal } from "@shared/llm.ts";
import { reportLlmSpend, spendReportIsRecordable } from "./spend.ts";
import type { LlmRunOptions, LlmRunner } from "@shared/llm.ts";
import type { LlmSpendReport, LlmSpendRole } from "@shared/llm-spend.ts";

const CODEX_BIN = resolveAgentBin("codex");
const DEFAULT_TIMEOUT_MS = Number(process.env.MISSION_CODEX_TIMEOUT_MS || 120_000);
const FAILURE_DETAIL_MAX = 300;
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
 * Read the `--json` event stream: the model's final text, and what the turn cost.
 *
 * `codex exec` without `--json` prints a human transcript - a banner naming the workdir and
 * model, the prompt echoed back, the reply, and a `tokens used` line - and this runner used
 * to hand that whole thing to its caller, leaving `parseModelJson` to find the JSON inside
 * it. `--json` replaces that with one object per event, which is both a stricter answer
 * (the reply arrives as a string field, so a reply that happens to contain the banner's
 * words cannot confuse the extraction) and the only place the token counts exist in a
 * machine-readable form at all. That second half is why the flag is here: `--ephemeral`
 * writes no rollout file, so the usage poller that accounts for interactive Codex sessions
 * has nothing to read, and this stream is the run's only account of itself.
 *
 * The LAST `agent_message` wins. A turn can emit several items - reasoning, tool calls,
 * intermediate messages - and the final assistant message is the answer; taking the first
 * would return a preamble.
 *
 * `turn.completed` is likewise last-wins rather than summed, and that is safe HERE for a
 * reason worth stating before someone changes it: this runner spawns with
 * `features.shell_tool=false` and `features.unified_exec=false` and refuses every tool
 * grant, so one `codex exec` is one prompt and exactly one turn. If a future change grants
 * this runner tools, a run could complete several turns and the usage would need
 * accumulating - and whether these payloads are per-turn or cumulative has to be settled
 * first, because guessing wrong silently halves or doubles every headless row.
 *
 * Unparseable lines are skipped rather than fatal. This is a CLI's event stream, not a
 * protocol we control: a version that adds an event type, or writes a stray line to stdout,
 * must not fail a review that already succeeded.
 */
function readCodexEvents(stdout: string): {
  text: string;
  usage: Record<string, unknown> | null;
  threadId: string;
} {
  let text = "";
  let usage: Record<string, unknown> | null = null;
  let threadId = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    } else if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      usage = event.usage as Record<string, unknown>;
    } else if (event.type === "item.completed" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") text = item.text;
    }
  }
  return { text, usage, threadId };
}

/** One bounded, single-line provider diagnostic, never an agent message or raw stream. */
function safeFailureText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, FAILURE_DETAIL_MAX);
}

/**
 * Read only Codex's explicit failure events from a failed `--json` stream.
 *
 * The stream can also contain `agent_message` text, which may repeat operator task briefs.
 * None of that is diagnostic material. Restricting this to the CLI's named error fields is
 * what lets a useful provider refusal survive without turning stdout into a prompt leak.
 */
function readCodexFailure(stdout: string): string {
  let reason = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "error") {
      reason = safeFailureText(event.message);
      continue;
    }
    if (event.type === "turn.failed") {
      if (typeof event.error === "string") {
        reason = safeFailureText(event.error);
      } else if (event.error && typeof event.error === "object") {
        reason = safeFailureText((event.error as Record<string, unknown>).message);
      }
    }
  }
  return reason;
}

function codexFailureDetail(stdout: string, stderr: string): string {
  const event = readCodexFailure(stdout);
  // A named JSON failure event is the provider's diagnostic. Prefer it outright rather
  // than appending stderr, which is less structured and could contain unrelated process
  // output. Bounded stderr remains useful when Codex dies before emitting any event.
  return event || safeFailureText(stderr) || "no provider failure detail";
}

interface MaterializedSchema {
  path: string;
  cleanup(): void;
}

/** Give `codex exec` a schema file whose lifetime is exactly one run. */
function materializeSchema(schema: Record<string, unknown> | undefined): MaterializedSchema | null {
  if (!schema) return null;
  const dir = mkdtempSync(join(tmpdir(), "mission-codex-schema-"));
  const path = join(dir, "output-schema.json");
  try {
    writeFileSync(path, JSON.stringify(schema), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    path,
    // `dir` is a unique directory minted above and contains only the file this function
    // wrote. Never broaden this to the shared temp directory or a caller-provided path.
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Turn one finished run into a spend report, or null when there is nothing to report.
 *
 * Tokens only, never a dollar figure: Codex reports no cost, so `reportedCostUsd` is null
 * and the daemon values these rows itself against the versioned price snapshot in
 * `harness/codex/pricing.ts`. That is the difference the ledger records as
 * `api-equivalent` rather than `reported`, and it is why an unrecognised model id lands as
 * honestly unpriced instead of as zero.
 *
 * The model is the one we ASKED for, because the event stream names none. That is sound
 * here and only here: every headless call site resolves an explicit model id before it
 * calls, so there is no default to be wrong about - but it is also why a run that omits
 * `opts.model` reports an empty id and prices as unknown rather than guessing.
 */
function codexSpendReport(
  role: LlmSpendRole,
  modelId: string,
  stdout: ReturnType<typeof readCodexEvents>,
  ts: number,
): LlmSpendReport | null {
  if (!stdout.usage) return null;
  const split = codexTokenSplit(stdout.usage);
  if (!split) return null;
  const report: LlmSpendReport = {
    role,
    runner: "codex",
    runId: stdout.threadId,
    ts,
    models: [{ modelId, reportedCostUsd: null, ...split }],
  };
  return spendReportIsRecordable(report) ? report : null;
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
    const schema = materializeSchema(opts.schema);
    try {
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
          // Machine-readable events instead of the human transcript - see `readCodexEvents`.
          // Load-bearing for accounting: an `--ephemeral` run writes no rollout file, so this
          // stream is the only place its token usage is ever stated.
          "--json",
        ];
        if (schema) args.push("--output-schema", schema.path);
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
          if (code !== 0) {
            reject(new Error(`codex exited ${code}: ${codexFailureDetail(out, err)}`));
            return;
          }
          const events = readCodexEvents(out);
          // Reported BEFORE resolving, so the accounting cannot be skipped by a caller that
          // throws on the value - and after the exit check, so a failed spawn reports nothing.
          if (opts.role) {
            const report = codexSpendReport(opts.role, opts.model ?? "", events, Date.now());
            if (report) reportLlmSpend(report);
          }
          resolve(events.text.trim());
        });
        child.stdin.end(prompt);
      });
    } finally {
      schema?.cleanup();
    }
  },

  /**
   * Value a headless run at the same Standard API rates an interactive Codex session is
   * valued at - the same function, not a second table.
   *
   * `estimateStandardApiUsage` is what the rollout poller already prices every interactive
   * request with, so a Foreman review and the session it reviewed are counted in the same
   * currency and against the same versioned snapshot. It declines an unrecognised model id
   * rather than guessing, which is why a run on a model this build has no verified rate for
   * lands as unpriced instead of as free.
   */
  price(usage) {
    const priced = estimateStandardApiUsage({
      identity: "",
      ts: 0,
      modelId: usage.modelId || null,
      querySource: "main",
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
      reasoningOutput: usage.reasoningOutput,
    });
    if (!priced) return null;
    return {
      costUsd: priced.costUsd,
      basis: "api-equivalent",
      pricingVersion: priced.pricingVersion,
    };
  },

  runInThread: null,
  structuredOutput: { guaranteesInputShape: true },
  sandbox: null,
  litter: null,
  killLiveRuns: killLiveCodexRuns,
};
