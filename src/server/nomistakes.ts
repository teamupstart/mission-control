import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { run } from "./util/exec.ts";
import { envVar } from "./config.ts";
import { unref } from "./util/timers.ts";
import { sessionMessages } from "./harness/index.ts";
import { fixSummaries, retainFixLogs } from "./nomistakes-fixes.ts";
import type { Registry } from "./registry.ts";
import type { NmActiveStep, NmFinding, NmGateResponse, NmRunSummary, NmStep } from "@shared/types.ts";

/** How often to refresh no-mistakes status for gated repos (ms). */
const NM_POLL_MS = Number(envVar("NM_POLL_MS") ?? 5000);

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
const responseByRun = new Map<string, NmGateResponse>();
const RESPONSE_HISTORY_CAP = 200;
const RESPONSE_ERROR_CHAR_CAP = 4000;
const RESPONSE_ERROR_TRUNCATION = "\n… [earlier output truncated]\n";

function retainedResponseError(error: string): string {
  const trimmed = error.trim();
  if (trimmed.length <= RESPONSE_ERROR_CHAR_CAP) return trimmed;
  return (
    RESPONSE_ERROR_TRUNCATION +
    trimmed.slice(-(RESPONSE_ERROR_CHAR_CAP - RESPONSE_ERROR_TRUNCATION.length))
  );
}

export function isResponding(cwd: string): boolean {
  return responding.has(cwd);
}

/** Current dashboard response for a run. Exported as a narrow test seam. */
export function responseForRun(runId: string): NmGateResponse | null {
  return responseByRun.get(runId) ?? null;
}

export interface RespondOpts {
  findings?: string[];
  instructions?: string;
  step?: string;
  /** The polled gate this dashboard action answered, used to surface async delivery. */
  runId?: string;
  /**
   * Called when the spawned `axi respond` did NOT exit cleanly, so nothing here can
   * claim the decision reached the gate. Deliberately opaque: this module knows only
   * that the spawn failed, never what a caller staked on it going through.
   *
   * "Not delivered" is the honest reading, not a proven one: the timeout kills the
   * CLI without proving the gate missed what it sent, so this can fire for a decision
   * that did land. That's the direction to be wrong in - a caller drops a claim it can
   * no longer support, rather than keeping one it can't back.
   *
   * Never on the success path, and never for a respond rejected before a spawn (the
   * caller already has that in the returned `ok`).
   */
  onUndelivered?: () => void;
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
  if (opts.runId) {
    if (!responseByRun.has(opts.runId) && responseByRun.size >= RESPONSE_HISTORY_CAP) {
      responseByRun.delete(responseByRun.keys().next().value!);
    }
    responseByRun.set(opts.runId, {
      runId: opts.runId,
      step: opts.step ?? "",
      action,
      findingIds: opts.findings ?? [],
      status: "submitting",
      error: null,
    });
  }
  // Optimistic: reflect the acted-on gate immediately, before the blocking respond returns.
  void pollAndReconcile(registry);

  // Background: run to completion, then reconcile the resulting cross-session state.
  run(bin, args, { cwd, timeoutMs: 10 * 60 * 1000 })
    .then(
      async (res) => {
        if (res.code !== 0) {
          const error = res.stderr.trim() || `no-mistakes exited with status ${res.code}`;
          console.error(`[nomistakes] respond ${action} failed:`, error);
          if (opts.runId) {
            const prior = responseByRun.get(opts.runId);
            if (prior) {
              responseByRun.set(opts.runId, {
                ...prior,
                status: "failed",
                error: retainedResponseError(error),
              });
            }
          }
          opts.onUndelivered?.();
        } else if (opts.runId) {
          const prior = responseByRun.get(opts.runId);
          if (prior) responseByRun.set(opts.runId, { ...prior, status: "submitted" });
        }
        await pollAndReconcile(registry);
      },
      async (err) => {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[nomistakes] respond error:", err);
        if (opts.runId) {
          const prior = responseByRun.get(opts.runId);
          if (prior) {
            responseByRun.set(opts.runId, {
              ...prior,
              status: "failed",
              error: retainedResponseError(error),
            });
          }
        }
        opts.onUndelivered?.();
        await pollAndReconcile(registry);
      },
    )
    // A reconcile failure says nothing about whether the CLI delivered the response.
    // Log it without retracting the byline or changing the delivery state; the regular
    // poller will try the same read again.
    .catch((err) => console.error("[nomistakes] response reconcile error:", err))
    .finally(() => responding.delete(cwd));

  return { ok: true };
}

/**
 * Poll `no-mistakes axi status` from every worktree the registry cares about and
 * reconcile the active runs onto the sessions that own them.
 *
 * A repo can have several concurrent runs (different launchers, different
 * branches), and `axi status` reports one run per invocation - but it is
 * branch-scoped when run from a worktree checked out on a run's branch. So we
 * poll each relevant worktree (every gated session's checkout plus every
 * remembered launcher worktree), collect the distinct runs by branch, and hand
 * the full set to the registry in one pass. Cheap when nothing is gated: no
 * worktrees to poll means no subprocesses.
 */
export async function pollAndReconcile(registry: Registry): Promise<void> {
  const cwds = registry.nomistakesPollCwds();
  if (cwds.length === 0) {
    registry.reconcileNomistakes([]); // clear any lingering decoration
    return;
  }
  if (!(await resolveNomistakesBin())) return;
  const runs = new Map<string, NmRunSummary>();
  await Promise.all(
    cwds.map(async (cwd) => {
      const fetched = await fetchStatus(cwd);
      if (fetched && fetched.branch) {
        const response = responseByRun.get(fetched.id) ?? null;
        const s = response ? { ...fetched, response } : fetched;
        const prior = runs.get(s.branch);
        // Several worktrees can report one run. Keep the copy carrying the in-flight
        // dashboard decision so a later duplicate cannot erase its acknowledgement.
        if (!prior || s.response || !prior.response) runs.set(s.branch, timeRun(s));
      }
    }),
  );
  registry.reconcileNomistakes([...runs.values()]);
}

// ---- run clock ----

/**
 * Runs we have watched running, mapped to when we saw them stop (null while still
 * going). Absent means we never saw the run go - and such a run is never stamped,
 * because we'd be recording when the daemon started looking, not when the run
 * ended. A card that says a 4-minute run took 3 hours is worse than one that
 * shows no duration at all.
 */
const watched = new Map<string, number | null>();

/** How many runs the clock remembers, so a long-lived daemon can't grow forever. */
const WATCHED_CAP = 200;

/** Forget everything the run clock has watched. Test seam. */
export function resetRunClock(): void {
  watched.clear();
}

/**
 * Time `run`: its end stamped the moment we see it stop running (its start comes
 * from its own id, in summarize). Idempotent - every worktree on a run's branch
 * reports it each poll, and only the first sighting of its end is kept.
 */
export function timeRun(run: NmRunSummary, now = Date.now()): NmRunSummary {
  if (!run.id) return run; // an id-less run can't be told apart from the next one
  if (run.status === "running") {
    if (!watched.has(run.id)) {
      watched.set(run.id, null);
      // Map keeps insertion order, and re-setting a key holds its place - so the
      // first key is always the run we've been watching longest.
      if (watched.size > WATCHED_CAP) watched.delete(watched.keys().next().value!);
    }
    return { ...run, endedAt: null };
  }
  const seen = watched.get(run.id);
  if (seen === undefined) return { ...run, endedAt: null }; // it was over before we looked
  if (seen === null) watched.set(run.id, now);
  return { ...run, endedAt: seen ?? now };
}

/**
 * Refresh each gated session's fix log. Read from git, not from `axi`, so this
 * deliberately does NOT depend on the no-mistakes binary resolving or on a run
 * being active: the log's whole job is to outlive the run. Cheap when nothing
 * changed - `fixSummaries` is keyed on HEAD, so a still branch costs one
 * `rev-parse` per session per tick.
 */
export async function pollFixLogs(registry: Registry): Promise<void> {
  const targets = registry.nomistakesFixTargets();
  // This set IS what "still worth remembering" means, and it's already computed
  // here each tick - so the cache is bounded by the live sessions rather than by how
  // long the daemon has been up. A checkout that leaves the dashboard takes its log
  // with it; one that comes back pays a re-read.
  retainFixLogs(targets.map((t) => t.cwd));
  await Promise.all(
    targets.map(async ({ id, cwd }) => {
      try {
        registry.applyNomistakesFixes(id, await fixSummaries(cwd));
      } catch (err) {
        console.error("[nomistakes] fix log failed:", err);
      }
    }),
  );
}

/**
 * Drive no-mistakes reconciliation on an interval. A no-op (no subprocesses)
 * when no session is in a no-mistakes repo, or when no-mistakes isn't installed.
 */
export function startNomistakesPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollAndReconcile(registry);
      await pollFixLogs(registry);
      // For sessions with an *active* run, surface what the skill is doing right
      // now from its harness's transcript (a bounded tail read, no subprocess). A
      // run that has reached an outcome is finished, so its narration is cleared.
      // Attribution is precise now, so only the launcher/owner sessions narrate.
      // A harness with no readable turns simply narrates nothing - the strip is a
      // one-line status, so its absence degrades to blank rather than to wrong.
      for (const s of registry.nomistakesSessions()) {
        const active = s.nomistakes && !s.nomistakes.outcome;
        const t = active ? sessionMessages(s) : null;
        registry.applyNomistakesNarration(s.id, t ? t.read.narration(t.path) : null);
      }
    } catch (err) {
      console.error("[nomistakes] poll failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, NM_POLL_MS));
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
  /** The PR this run's `pr` step opened, if it has reached that step. */
  pr: string | null;
  awaitingAgent: string | null;
  findingsSummary: string | null;
  steps: NmStep[];
  activeSteps: NmActiveStep[];
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
    pr: null,
    awaitingAgent: null,
    findingsSummary: null,
    steps: [],
    activeSteps: [],
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
      const activeHeader = line.match(/^active_steps\[\d+\]\{([^}]*)\}:$/);
      if (activeHeader) {
        i = readRows(lines, i + 1, indentOf(raw), activeHeader[1]!, (cols) =>
          run.activeSteps.push({
            step: cols.step ?? "",
            status: cols.status ?? "",
            activeFor: cols.active_for ?? "",
            lastActivity: cols.last_activity ?? "",
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

/**
 * Split a TOON row into N cells, keeping commas inside a free-text cell.
 *
 * Two shapes of free text to protect. The final cell takes whatever is left, which
 * covers an unquoted trailing `description`. And a QUOTED cell runs to its closing
 * quote wherever it sits in the row - `active_steps` puts `last_activity` in the
 * middle and quotes it, so whatever a step logged (commas and all) would otherwise
 * shift every later cell along by one.
 */
function splitRow(line: string, n: number): string[] {
  const cells: string[] = [];
  let rest = line.trim();
  for (let k = 0; k < n - 1; k++) {
    const comma = cellEnd(rest);
    if (comma === -1) {
      cells.push(rest);
      rest = "";
    } else {
      cells.push(rest.slice(0, comma));
      rest = rest.slice(comma + 1).trim();
    }
  }
  cells.push(rest);
  return cells.map((c) => c.trim().replace(/^"|"$/g, ""));
}

/** Index of the comma ending `row`'s first cell, or -1 when nothing follows it. */
function cellEnd(row: string): number {
  if (row.startsWith('"')) {
    const close = closingQuote(row);
    if (close !== -1) return row.indexOf(",", close + 1);
  }
  return row.indexOf(",");
}

/**
 * Index of the quote closing the cell that opens `row`: the next `"` with the row's
 * end or its next comma behind it. Quotes inside the text (`he said "no", loudly`)
 * don't close it, so the cell survives them. -1 when the quote never closes, and
 * the caller falls back to splitting on the comma - a malformed row degrades to the
 * old behaviour instead of swallowing the rest of the line.
 */
function closingQuote(row: string): number {
  for (let i = 1; i < row.length; i++) {
    if (row[i] !== '"') continue;
    const after = row.slice(i + 1).trimStart();
    if (after === "" || after.startsWith(",")) return i;
  }
  return -1;
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
  const pr = scalar(line, "pr");
  if (pr !== null) return void (run.pr = pr);
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

/** Crockford base32, the ULID alphabet (no I, L, O or U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The start time a ULID carries in its leading 10 characters (a 48-bit epoch-ms
 * timestamp). `axi status` reports no timestamps, but every run id it prints is a
 * ULID - so a run dates itself, with no extra subprocess and nothing to remember.
 *
 * Returns null for an id that isn't a ULID, so an id format we don't recognise
 * costs the card its duration rather than showing a wrong one.
 */
export function ulidTime(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return null;
  let ms = 0;
  for (const c of id.slice(0, 10).toUpperCase()) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms;
}

/**
 * Reduce a parsed run to the compact summary the UI shows. Exported alongside
 * `parseAxiStatus` so tests can pin the whole status -> card path, notably that
 * the run id survives it: a dropped id silently un-retires a dismissed run.
 *
 * Pure: `endedAt` is left null for the poller's clock (see timeRun) to stamp.
 */
export function summarize(run: NmRun | null): NmRunSummary | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    branch: run.branch,
    startedAt: ulidTime(run.id),
    endedAt: null,
    prUrl: run.pr,
    awaitingAgent: run.awaitingAgent,
    findingsSummary: run.findingsSummary,
    gateStep: run.gate?.step ?? null,
    gateSummary: run.gate?.summary ?? null,
    gateRisk: run.gate?.risk ?? null,
    steps: run.steps,
    activeSteps: run.activeSteps,
    findings: run.gate?.findings ?? [],
    response: null,
    outcome: run.outcome,
  };
}
