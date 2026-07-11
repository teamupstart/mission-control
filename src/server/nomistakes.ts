import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { run } from "./util/exec.ts";
import { readCurrentTodo, resolveTranscriptPath } from "./transcript.ts";
import type { Registry } from "./registry.ts";
import type { NmFinding, NmRunSummary, NmStep } from "@shared/types.ts";

/** How often to refresh no-mistakes status for gated repos (ms). */
const NM_POLL_MS = Number(process.env.HARNESS_NM_POLL_MS ?? 5000);

// Surfaces the live status of a no-mistakes run for a gated repo by shelling out
// to `no-mistakes axi status` (the agent-facing TOON interface) and parsing it.
// Read-only: acting on a gate stays in no-mistakes' own surfaces.

let resolvedBin: string | null | undefined; // undefined = not yet resolved, null = unavailable

function candidates(): string[] {
  const home = homedir();
  // Go installs to $GOBIN, else $GOPATH/bin, else ~/go/bin - cover all three so
  // the daemon finds `no-mistakes` regardless of its own PATH.
  const goBin = process.env.GOBIN || "";
  const goPathBin = process.env.GOPATH ? join(process.env.GOPATH, "bin") : "";
  return [
    process.env.NOMISTAKES_BIN ?? "",
    "no-mistakes",
    join(home, ".local", "bin", "no-mistakes"),
    "/usr/local/bin/no-mistakes",
    "/opt/homebrew/bin/no-mistakes",
    goBin ? join(goBin, "no-mistakes") : "",
    goPathBin ? join(goPathBin, "no-mistakes") : "",
    join(home, "gopath", "bin", "no-mistakes"),
    join(home, "go", "bin", "no-mistakes"),
  ].filter(Boolean);
}

/** Resolve the no-mistakes binary once. Returns null if it isn't installed. */
export async function resolveNomistakesBin(): Promise<string | null> {
  if (resolvedBin !== undefined) return resolvedBin;
  for (const bin of candidates()) {
    if (bin.includes("/") && !existsSync(bin)) continue;
    const res = await run(bin, ["--version"], { timeoutMs: 3000 });
    if (res.code === 0 && /no-mistakes/i.test(res.stdout + res.stderr)) {
      resolvedBin = bin;
      return bin;
    }
  }
  resolvedBin = null;
  return null;
}

/** Fetch + parse the no-mistakes run status for a repo directory. */
export async function fetchStatus(cwd: string): Promise<NmRunSummary | null> {
  const bin = await resolveNomistakesBin();
  if (!bin) return null;
  const res = await run(bin, ["axi", "status"], { timeoutMs: 6000, cwd });
  if (!res.stdout.trim()) return null;
  return summarize(parseAxiStatus(res.stdout));
}

/** Repos with a respond in flight - blocks a second concurrent decision. */
const responding = new Set<string>();

export function isResponding(cwd: string): boolean {
  return responding.has(cwd);
}

export interface RespondOpts {
  findings?: string[];
  instructions?: string;
  step?: string;
}

/**
 * Send a decision to the no-mistakes gate for a repo. `axi respond` blocks
 * server-side until the run reaches the next gate or an outcome (a fix can run
 * the pipeline agent for a while), so we DON'T hold the HTTP request open: we
 * kick it off, optimistically refresh status, and let the poller surface
 * progress. The final state is applied when the command settles.
 */
export async function respond(
  registry: Registry,
  cwd: string,
  action: "approve" | "fix" | "skip",
  opts: RespondOpts = {},
): Promise<{ ok: boolean; error?: string }> {
  const bin = await resolveNomistakesBin();
  if (!bin) return { ok: false, error: "no-mistakes is not installed" };
  if (responding.has(cwd)) return { ok: false, error: "a decision is already in progress" };

  const args = ["axi", "respond", "--action", action];
  if (action === "fix" && opts.findings && opts.findings.length > 0) {
    args.push("--findings", opts.findings.join(","));
  }
  if (action === "fix" && opts.instructions) args.push("--instructions", opts.instructions);
  if (opts.step) args.push("--step", opts.step);

  responding.add(cwd);
  // Optimistic: the gate is being acted on; reflect it immediately.
  void fetchStatus(cwd).then((s) => registry.applyNomistakes(cwd, s));

  // Background: run to completion, then apply the resulting state. respond
  // prints the next state as TOON on success, so prefer that over a re-poll.
  run(bin, args, { cwd, timeoutMs: 10 * 60 * 1000 })
    .then(async (res) => {
      if (res.code !== 0) console.error(`[nomistakes] respond ${action} failed:`, res.stderr.trim());
      const summary = res.stdout.trim()
        ? summarize(parseAxiStatus(res.stdout))
        : await fetchStatus(cwd);
      registry.applyNomistakes(cwd, summary);
    })
    .catch((err) => console.error("[nomistakes] respond error:", err))
    .finally(() => responding.delete(cwd));

  return { ok: true };
}

/**
 * Poll no-mistakes status for gated repos on an interval. Only queries repos
 * discovery already flagged as gated, so it's a no-op (no subprocesses) when no
 * session is in a no-mistakes repo, or when no-mistakes isn't installed.
 */
export function startNomistakesPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const cwds = registry.gatedCwds();
      if (cwds.length > 0 && (await resolveNomistakesBin())) {
        for (const cwd of cwds) {
          registry.applyNomistakes(cwd, await fetchStatus(cwd));
        }
      }
      // For sessions now showing a run, surface what the skill is doing right
      // now from its Claude transcript (a bounded tail read, no subprocess).
      for (const s of registry.nomistakesSessions()) {
        const path = resolveTranscriptPath(s);
        registry.applyNomistakesNarration(s.id, path ? readCurrentTodo(path) : null);
      }
    } catch (err) {
      console.error("[nomistakes] poll failed:", err);
    }
    if (stopped) return;
    timer = setTimeout(tick, NM_POLL_MS);
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// ---- TOON parsing (targeted to the axi status shape) ----

interface NmRun {
  id: string;
  branch: string;
  status: string;
  head: string | null;
  awaitingAgent: string | null;
  findingsSummary: string | null;
  steps: NmStep[];
  gate: {
    step: string;
    status: string;
    summary: string | null;
    risk: string | null;
    findings: NmFinding[];
  } | null;
  outcome: string | null;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Parse `no-mistakes axi status` TOON output. Returns null for the error / no-run
 * cases (`error: repo not initialized`, `error: not in a git repository`, or no
 * `run:` block). Handles the `run:`, `gate:`, and `outcome:` blocks plus the
 * `steps[N]{...}` and `findings[N]{...}` tabular arrays.
 */
export function parseAxiStatus(out: string): NmRun | null {
  const lines = out.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  if (lines[0]!.trimStart().startsWith("error:")) return null;

  const run: NmRun = {
    id: "",
    branch: "",
    status: "",
    head: null,
    awaitingAgent: null,
    findingsSummary: null,
    steps: [],
    gate: null,
    outcome: null,
  };
  let sawRun = false;
  let section: "run" | "gate" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();

    if (indentOf(raw) === 0) {
      if (line === "run:") {
        sawRun = true;
        section = "run";
      } else if (line === "gate:") {
        run.gate = { step: "", status: "", summary: null, risk: null, findings: [] };
        section = "gate";
      } else {
        const om = line.match(/^outcome:\s*(.+)$/);
        if (om) run.outcome = om[1]!.trim();
        section = null; // help/count/etc. end the current block
      }
      continue;
    }

    // Some axi output has a leading progress block (`run: running` with indented
    // step lines) before the real `run:` object; ignore lines seen before it.
    if (section === "run") {
      const stepsHeader = line.match(/^steps\[\d+\]\{([^}]*)\}:$/);
      if (stepsHeader) {
        i = readRows(lines, i + 1, indentOf(raw), stepsHeader[1]!, (cols) =>
          run.steps.push({
            step: cols.step ?? "",
            status: cols.status ?? "",
            findings: Number(cols.findings ?? 0) || 0,
          }),
        );
        continue;
      }
      assignRunScalar(run, line);
    } else if (section === "gate" && run.gate) {
      const findHeader = line.match(/^findings\[\d+\]\{([^}]*)\}:$/);
      if (findHeader) {
        i = readRows(lines, i + 1, indentOf(raw), findHeader[1]!, (cols) =>
          run.gate!.findings.push({
            id: cols.id ?? "",
            severity: cols.severity ?? "",
            file: cols.file ?? "",
            action: cols.action ?? "",
            description: cols.description ?? "",
          }),
        );
        continue;
      }
      assignGateScalar(run.gate, line);
    }
  }

  return sawRun ? run : null;
}

/** Read comma-delimited tabular rows nested under a `name[N]{cols}:` header. */
function readRows(
  lines: string[],
  start: number,
  headerIndent: number,
  colspec: string,
  emit: (cols: Record<string, string>) => void,
): number {
  const columns = colspec.split(",").map((c) => c.trim());
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (indentOf(raw) <= headerIndent) break; // dedent ends the table
    const cells = splitRow(raw.trim(), columns.length);
    const row: Record<string, string> = {};
    columns.forEach((c, idx) => (row[c] = cells[idx] ?? ""));
    emit(row);
  }
  return i - 1; // caller's loop will i++ to the dedented line
}

/** Split a TOON row into N cells, keeping commas inside the final free-text cell. */
function splitRow(line: string, n: number): string[] {
  const cells: string[] = [];
  let rest = line;
  for (let k = 0; k < n - 1; k++) {
    const comma = rest.indexOf(",");
    if (comma === -1) {
      cells.push(rest);
      rest = "";
    } else {
      cells.push(rest.slice(0, comma));
      rest = rest.slice(comma + 1);
    }
  }
  cells.push(rest);
  return cells.map((c) => c.trim().replace(/^"|"$/g, ""));
}

function scalar(line: string, key: string): string | null {
  const m = line.match(new RegExp(`^${key}:\\s*(.*)$`));
  return m ? m[1]!.trim().replace(/^"|"$/g, "") : null;
}

function assignRunScalar(run: NmRun, line: string): void {
  const id = scalar(line, "id");
  if (id !== null) return void (run.id = id);
  const branch = scalar(line, "branch");
  if (branch !== null) return void (run.branch = branch);
  const status = scalar(line, "status");
  if (status !== null) return void (run.status = status);
  const head = scalar(line, "head");
  if (head !== null) return void (run.head = head);
  const awaiting = scalar(line, "awaiting_agent");
  if (awaiting !== null) return void (run.awaitingAgent = awaiting);
  const findings = scalar(line, "findings");
  if (findings !== null) return void (run.findingsSummary = findings);
}

function assignGateScalar(gate: NonNullable<NmRun["gate"]>, line: string): void {
  const step = scalar(line, "step");
  if (step !== null) return void (gate.step = step);
  const status = scalar(line, "status");
  if (status !== null) return void (gate.status = status);
  const summary = scalar(line, "summary");
  if (summary !== null) return void (gate.summary = summary);
  const risk = scalar(line, "risk");
  if (risk !== null) return void (gate.risk = risk);
}

/** Reduce a parsed run to the compact summary the UI shows. */
function summarize(run: NmRun | null): NmRunSummary | null {
  if (!run) return null;
  return {
    status: run.status,
    branch: run.branch,
    awaitingAgent: run.awaitingAgent,
    findingsSummary: run.findingsSummary,
    gateStep: run.gate?.step ?? null,
    gateSummary: run.gate?.summary ?? null,
    gateRisk: run.gate?.risk ?? null,
    steps: run.steps,
    findings: run.gate?.findings ?? [],
    outcome: run.outcome,
  };
}
