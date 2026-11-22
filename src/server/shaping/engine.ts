import { createHash } from "node:crypto";
import {
  allocateBudget,
  canonicalJson,
  composeShapingSection,
  composeSkillsSection,
  cutAtLineBoundary,
  describeInvalidResult,
  isShapingLifecyclePoint,
  joinShapingSections,
  mergeRoutedSkills,
  resolveShaperById,
  resolveShapers,
  SHAPING_LIMITS,
  SHAPING_PROTOCOL,
  SHAPING_SECTION_PREAMBLE,
  SHAPING_SKILLS_RESERVE_BYTES,
  shaperIsLocal,
  shapingEntryHeading,
  shapingSkillLine,
  shapingSlot,
  ShapingRequestSchema,
  ShapingResultSchema,
  ShapingRouteResultSchema,
  summariseShaping,
  utf8Length,
  type DiscoveredShaper,
  type ResolvedShaper,
  type ShapingCallRecord,
  type ShapingConfig,
  type ShapingContext,
  type ShapingFacts,
  type ShapingInjectedEntry,
  type ShapingOutcome,
  type ShapingRequest,
  type ShapingResult,
  type ShapingRouteResult,
  type ShapingRun,
  type ShapingSkillSummary,
  type ShapingStage,
} from "@shared/shaping.ts";
import { SHAPING_STAGES } from "@shared/shaping-registry.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { skillReference } from "@shared/harness-capabilities.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";

// The dry run's reply shape lives beside the other wire shapes, so the dashboard reads the same one.
export type { ShapingInjectedEntry, ShapingRun };
import { featureEnabled } from "../feature-flags/index.ts";
import { discoverShapers } from "./discovery.ts";
import { withoutNul } from "./references.ts";
import { getShapingConfig } from "./index.ts";
import {
  callTransport, SHAPING_TRANSPORT_CALLS, type ShapingRunScope, type ShapingTraceContext, type ShapingTransportCalls, type TransportReply,
} from "./transports/index.ts";
import { carriedWorkUnitId } from "./transports/carriers.ts";
import { resolveRoutedSkill, type RoutedSkillResolver } from "./skills.ts";

/**
 * `shapeTask`: the only caller of the transports. It decides nothing about which shapers exist
 * or are on (`resolveShapers` does), and everything about what a call is allowed to come to:
 * stage order, one call per shaper per repository in parallel, the step deadline, validation
 * against the one result schema, caps, de-duplication, the outcome and the record. It never
 * throws, and nothing a shaper does can stop the launch it is shaping.
 */

/** One attached repository, as dispatch collected it. `path` is the local worktree. */
export interface ShapeTaskRepository {
  name: string;
  role: "primary" | "additional";
  branch: string | null;
  baseSha: string | null;
  path: string | null;
}

/** Everything Mission Control collected about the task (constraint C2). */
export interface ShapeTaskInput {
  /** The operator's prompt, verbatim. */
  task: string;
  // Slots and the call's target are the engine's to assign, from the order dispatch collected.
  context: Omit<ShapingContext, "repositories" | "caller" | "target"> & { repositories: readonly ShapeTaskRepository[] };
  /** Aborted when the task is cancelled while it is being shaped. */
  signal?: AbortSignal;
  /** The turn being launched. An `iteration`, a resident's wake turn, is never shaped. */
  turn?: "launch" | "iteration";
  /**
   * Lowers the section's total for this one launch: the section never exceeds the smaller of
   * this and `limits.totalBytes`, and what does not fit is cut and recorded by the allocator's
   * usual rules. Phase 2 passes it on a delivery path with a byte ceiling.
   */
  maxSectionBytes?: number;
  /**
   * The launch's W3C trace context. Every call of the run receives it unchanged as `ctx.trace`.
   * It is never logged or recorded. Phase 2 passes it in.
   */
  trace?: ShapingTraceContext | null;
  /**
   * The shaping run's work unit id, when the task has one. Every call of the run carries it
   * unchanged as `ctx.workUnitId`: a header on `http` and streamable-HTTP `mcp` calls,
   * `params._meta.work_unit_id` on every `tools/call`, and `WORK_UNIT_ID` for a local process.
   * Opaque and not a credential, so it is never redacted, and never logged or recorded. Absent
   * until the task that mints it lands; a value that could not travel as a header is treated
   * as absent.
   */
  workUnitId?: string | null;
  /**
   * The attached repositories, by name, whose own task skill for this task's kind is in this
   * launch's turn one (FR-05's `resolveRepoTaskSkills`). A routed skill named for the kind is not
   * announced for them (D14). Absent, nothing is taken.
   */
  repositoryTaskSkills?: readonly string[];
  /**
   * The harness a dry run renders routed skills for, when the request names no harness of its
   * own. A launch always names its harness, and this is then ignored.
   */
  previewAgent?: AgentType;
}

export interface ShapeTaskDeps {
  config?: ShapingConfig;
  discovered?: readonly DiscoveredShaper[];
  transports?: ShapingTransportCalls;
  /** Overrides the `task-shaping` flag, for tests. */
  enabled?: boolean;
  /** How a routed skill's name is checked against Mission Control's catalog. */
  resolveSkill?: RoutedSkillResolver;
}

/** A fresh empty run for every caller: nothing a caller does to one can leak into the next. */
/** A call with this little time left is recorded as out of time rather than started. */
const MIN_CALL_MS = 10;

function emptyRun(): ShapingRun {
  return { summary: null, section: "", entries: [], skills: [] };
}

/** Shape one task. Resolves to an empty run when the flag is off or no shaper applies. */
export async function shapeTask(input: ShapeTaskInput, deps: ShapeTaskDeps = {}): Promise<ShapingRun> {
  try {
    if (!(deps.enabled ?? featureEnabled("task-shaping"))) return emptyRun();
    const config = deps.config ?? getShapingConfig();
    // The folder is read at the start of every run, against the same config snapshot, so a
    // folder dropped in or replaced since the last launch takes effect now, with no restart.
    const discovered = deps.discovered ?? await discoverShapers({ config });
    const resolved = resolveShapers(config, discovered, {
      kind: input.context.kind, repositories: input.context.repositories, ...(input.turn ? { turn: input.turn } : {}),
    });
    if (resolved.length === 0) return emptyRun();
    return await runShaping(resolved, input, config, deps.transports ?? SHAPING_TRANSPORT_CALLS, deps.resolveSkill ?? resolveRoutedSkill);
  } catch (error) {
    console.warn("[shaping] the shaping step failed unexpectedly:", error);
    return emptyRun();
  }
}

export type DryRunResult =
  | { ok: true; run: ShapingRun }
  | { ok: false; error: "unknown_shaper" | "unsupported_shaper"; reason: string };

/** Run exactly one shaper, whatever its stored choice and filters, as `shapeTask` would. */
export async function dryRunShaper(id: string, input: ShapeTaskInput, deps: ShapeTaskDeps = {}): Promise<DryRunResult> {
  const config = deps.config ?? getShapingConfig();
  const discovered = deps.discovered ?? await discoverShapers({ config });
  const found = resolveShaperById(config, discovered, id, {
    kind: input.context.kind, repositories: input.context.repositories,
  });
  if (!found.ok) return found;
  return {
    ok: true,
    run: await runShaping([found.resolved], input, config, deps.transports ?? SHAPING_TRANSPORT_CALLS, deps.resolveSkill ?? resolveRoutedSkill),
  };
}

/** The SHA-256 of the definition that ran: canonical JSON for a registered shaper, the manifest's bytes for a discovered one. */
export function shaperSha256(resolved: Pick<ResolvedShaper, "stored" | "sha256">): string | null {
  if (resolved.sha256) return resolved.sha256;
  return resolved.stored ? createHash("sha256").update(canonicalJson(resolved.stored)).digest("hex") : null;
}

interface CallResult {
  record: ShapingCallRecord;
  entries: Array<{ id: string; title: string | null; path: string | null; body: string; truncated: boolean }>;
  /** A router's skills, as it sent them. Empty at every other stage. */
  skills: ShapingRouteResult["skills"];
  facts: ShapingFacts | null;
  summary: string | null;
  /** The reply said it was truncated as a whole, whether or not any entry says so. */
  truncated: boolean;
}

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await fn(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function bounded(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, SHAPING_LIMITS.reasonChars);
}

/** A reply that states an error instead of a result, such as FR-02's `denied`. */
function replyError(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const error = (value as { error: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const parts = [code, message].filter((part): part is string => typeof part === "string" && part.length > 0);
    if (parts.length) return parts.join(": ");
  }
  return "The shaper returned an error.";
}

function runDeferred(cleanup: () => void | Promise<void>): void {
  void Promise.resolve().then(cleanup).catch((error: unknown) => {
    console.warn("[shaping] run cleanup failed:", error);
  });
}

/**
 * One run's scope. `close` runs every cleanup registered so far, and from then on `defer` runs
 * a cleanup as soon as it is registered. A call the engine abandoned at its timeout can still
 * be acquiring a resource when the run ends; whatever it registers afterwards is released,
 * not left open.
 */
export function runScope(): ShapingRunScope & { close(): void; readonly closed: boolean } {
  const pending: Array<() => void | Promise<void>> = [];
  let closed = false;
  return {
    shared: new Map<string, unknown>(),
    defer(cleanup) {
      if (closed) runDeferred(cleanup);
      else pending.push(cleanup);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const cleanup of pending.splice(0)) runDeferred(cleanup);
    },
    get closed() { return closed; },
  };
}

/**
 * The primary first, then the rest in attachment order (the sort is stable), each with its slot
 * (D17): `repo-01` for the primary, then `repo-02` onward.
 */
function orderRepositories(repositories: readonly ShapeTaskRepository[]): Array<ShapeTaskRepository & { slot: string }> {
  return [...repositories]
    .sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"))
    .map((repo, position) => ({ ...repo, slot: shapingSlot(position) }));
}

/** The harness a run's routed skills are rendered for, or null when it names none this build knows. */
function skillAgent(input: ShapeTaskInput): AgentType | null {
  const harness = input.context.harness;
  if (harness !== null) return (AGENT_TYPES as readonly string[]).includes(harness) ? harness as AgentType : null;
  return input.previewAgent ?? null;
}

async function runShaping(
  resolved: readonly ResolvedShaper[],
  input: ShapeTaskInput,
  config: ShapingConfig,
  transports: ShapingTransportCalls,
  resolveSkill: RoutedSkillResolver,
): Promise<ShapingRun> {
  // Elapsed time and every budget come from the monotonic clock, so a wall-clock correction
  // during the step neither discards an on-time reply nor skips a stage with time left. The
  // wall clock only stamps the record, and the epoch deadline handed to transports.
  const startedAt = Date.now();
  const startedMono = performance.now();
  const deadline = startedAt + config.limits.deadlineMs;
  const deadlineMono = startedMono + config.limits.deadlineMs;
  const run = new AbortController();
  const deadlineTimer = setTimeout(() => run.abort(), config.limits.deadlineMs);
  const onCancel = () => run.abort();
  input.signal?.addEventListener("abort", onCancel, { once: true });
  if (input.signal?.aborted) run.abort();
  const scope = runScope();
  const workUnitId = carriedWorkUnitId(input.workUnitId);
  const repositories = orderRepositories(input.context.repositories);
  const multiRepo = repositories.length > 1;
  const hashes = new Map(resolved.map((entry) => [entry.shaper.id, shaperSha256(entry)]));
  const facts = repositories.map((): ShapingFacts | null => null);
  const summaries = repositories.map((): string | null => null);
  const results: Array<{ stage: ShapingStage; resolved: ResolvedShaper; repo: ShapeTaskRepository & { slot: string }; result: CallResult }> = [];

  // The selected guidance per repository slot, set once the selectors have settled (D13).
  let guidanceBySlot: Map<string, Array<{ shaper: string; id: string }>> | null = null;

  const contextFor = (local: boolean, target: string, stage: ShapingStage): ShapingContext => ({
    ...input.context,
    repositories: repositories.map((repo) => ({
      slot: repo.slot, name: repo.name, role: repo.role, branch: repo.branch, baseSha: repo.baseSha,
      ...(local && repo.path ? { path: repo.path } : {}),
    })),
    target,
    caller: {
      user: config.caller.user || null,
      agent: input.context.harness,
      conversation: input.context.taskId,
    },
    // Only a route request carries it, and always, empty when nothing was selected there.
    ...(stage === "route" ? { guidance: (guidanceBySlot?.get(target) ?? []).slice(0, SHAPING_LIMITS.guidanceIds) } : {}),
  });

  const callOne = async (stage: ShapingStage, entry: ResolvedShaper, repoIndex: number): Promise<CallResult> => {
    const repo = repositories[repoIndex]!;
    const callStart = performance.now();
    // `redacted`: the transport removed a credential value from what this record was built from.
    const record = (outcome: ShapingOutcome, reason: string | null, version: string | null = null, redacted = false): ShapingCallRecord => ({
      shaper: entry.shaper, origin: entry.origin, sha256: hashes.get(entry.shaper.id) ?? null, repo: repo.name,
      outcome, reason: reason === null ? null : bounded(reason), durationMs: Math.round(performance.now() - callStart), version, redacted,
    });
    const empty = (outcome: ShapingOutcome, reason: string, redacted = false): CallResult => ({
      record: record(outcome, reason, null, redacted), entries: [], skills: [], facts: null, summary: null, truncated: false,
    });
    const stopped = () => input.signal?.aborted
      ? empty("failed", "The task was cancelled while it was being shaped.")
      : empty("timed_out", "The shaping step ran out of time before this call could finish.");

    const left = deadlineMono - callStart;
    // Whole milliseconds: the request's `limits.deadlineMs` is an integer on the wire, and a
    // floor keeps the call inside the step's monotonic deadline rather than past it.
    const timeoutMs = Math.floor(Math.min(entry.shaper.timeoutMs ?? config.limits.timeoutMs, left));
    // A call that would start with no usable budget is not started at all: the step's deadline
    // and an earlier call's own timeout fall due together, and either can fire first.
    if (run.signal.aborted || timeoutMs <= MIN_CALL_MS) return stopped();
    const local = shaperIsLocal(entry.shaper);
    const request: ShapingRequest = {
      protocol: SHAPING_PROTOCOL,
      stage,
      task: input.task,
      repo: {
        name: repo.name,
        ...(local && repo.path ? { path: repo.path } : {}),
        ...(stage !== "gather" && facts[repoIndex] ? { facts: facts[repoIndex]! } : {}),
        ...(stage !== "gather" && summaries[repoIndex] ? { summary: summaries[repoIndex]! } : {}),
      },
      ...(entry.shaper.version ? { version: entry.shaper.version } : {}),
      context: contextFor(local, repo.slot, stage),
      limits: { maxBytes: entry.shaper.maxBytes ?? config.limits.maxBytes, deadlineMs: timeoutMs },
    };
    // The request is checked against the wire schema before any transport sees it. Input the
    // caller collected can exceed the protocol's bounds, such as more repositories than a
    // request may name, and a shaper that validates its requests would refuse every call.
    const wire = ShapingRequestSchema.safeParse(request);
    if (!wire.success) {
      const issue = wire.error.issues[0];
      const at = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return empty("failed", `The task's context is outside the shaping protocol's bounds, so this shaper was not called. ${at}${issue?.message ?? "The request is not valid."}`);
    }

    // The call's own deadline is exact: its signal is aborted at `timeoutMs`, and a reply that
    // arrives after it contributes nothing. The short grace that follows only lets a transport
    // say why it stopped; the call is abandoned at its end even if the transport ignores the
    // signal, and at once when the whole run stops.
    const call = new AbortController();
    const onRunAbort = () => call.abort();
    run.signal.addEventListener("abort", onRunAbort, { once: true });
    const expires = setTimeout(() => call.abort(), timeoutMs);
    const timedOut = () => empty("timed_out", `Timed out after ${Math.round(timeoutMs / 100) / 10} s.`);
    let abandon: ReturnType<typeof setTimeout> | undefined;
    let onStop: (() => void) | undefined;
    let reply: TransportReply | "abandoned";
    // When the transport settled: first as the transport itself reports it, where it produced the
    // reply, then as its promise settles. The continuation below can run later than either on a
    // busy event loop, and a reply in time must not be judged by when it was read.
    let producedAt: number | undefined;
    let settledAt: number | undefined;
    try {
      reply = await Promise.race([
        // The parsed request, so a transport receives only the fields the wire contract declares.
        callTransport(wire.data, entry.shaper, {
          deadline, timeoutMs, signal: call.signal, scope, root: entry.root, trace: input.trace ?? null, workUnitId,
          settled: () => { producedAt ??= performance.now(); },
        }, transports).then((settled) => {
          settledAt = performance.now();
          return settled;
        }),
        new Promise<"abandoned">((done) => {
          abandon = setTimeout(() => done("abandoned"), timeoutMs + 50);
          onStop = () => done("abandoned");
          run.signal.addEventListener("abort", onStop, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(expires);
      clearTimeout(abandon);
      run.signal.removeEventListener("abort", onRunAbort);
      if (onStop) run.signal.removeEventListener("abort", onStop);
      call.abort();
    }
    if (reply === "abandoned") return run.signal.aborted ? stopped() : timedOut();
    // The transport's own moment first, then the engine's, then now: each is earlier than this read.
    const late = (producedAt ?? settledAt ?? performance.now()) - callStart > timeoutMs;
    // The call's deadline applies to every reply, not only to data. A busy event loop can let a
    // transport settle after the deadline before the overdue timer runs: whatever it says then
    // is a timeout, keeping the transport's own timeout diagnostic when it gave one.
    if (late) {
      if (run.signal.aborted) return stopped();
      return reply.kind === "timed_out" ? empty("timed_out", reply.reason, reply.redacted === true) : timedOut();
    }
    let redacted = reply.redacted === true;
    if (reply.kind !== "data") return empty(reply.kind, reply.reason, redacted);

    // Every reason below is built from text the shaper wrote, so it is scrubbed of what the
    // transport handed the shaper before it is recorded, and before it is cut to length.
    // A diagnostic built here from the shaper's text can hold a named value the transport left in
    // place, such as an invalid fact's name kept for validation. Removing it counts as redaction.
    const redact = reply.redact ?? ((text: string) => text);
    const holdsNamed = reply.holdsNamed ?? (() => false);
    // The record collapses whitespace, which can turn a spacing variant of a value into the
    // value itself: the text is scrubbed as written, collapsed, and scrubbed again, and either
    // pass removing a value marks the record.
    const scrub = (text: string): string => {
      const first = redact(text);
      const flat = first.replace(/\s+/g, " ").trim();
      if (holdsNamed(text) || holdsNamed(flat)) redacted = true;
      return redact(flat);
    };
    let value = reply.data;
    if (typeof value === "string") {
      try { value = JSON.parse(value); }
      catch { return empty("invalid", "The reply is not JSON.", redacted); }
    }
    // No NUL from a shaper reaches anything built from its reply. Phase 2 appends the section to
    // a launch argument, and an argument holding NUL refuses to start the worker at all.
    withoutNul(value);
    const error = replyError(value);
    if (error !== null) return empty("failed", scrub(error), redacted);
    // A router answers with skills, every other stage with entries: one schema each, so a router
    // that sends guidance, or a selector that sends skills, is refused rather than half-read.
    const parsed = stage === "route"
      ? ShapingRouteResultSchema.safeParse(value)
      : ShapingResultSchema.safeParse(value);
    if (!parsed.success) return empty("invalid", scrub(describeInvalidResult(parsed.error)), redacted);
    const result: Partial<ShapingResult> & Partial<ShapingRouteResult> = parsed.data;
    const notes = scrub(result.notes?.filter((note) => note.trim()).join(" ") ?? "");
    // What the transport dropped while redacting, recorded whatever the outcome: a successful
    // reply that lost an entry still says so, and still answers `ok`.
    const dropped = (reply.redactionNotes ?? []).join(" ");
    // The version is the shaper's text too, recorded and returned, so it is scrubbed as an
    // identifier (a named credential and any long value go, `v1.4.0` keeps an inherited "0"),
    // then held to its bound: a replacement can be longer than what it replaced.
    if (result.version != null && holdsNamed(result.version)) redacted = true;
    const version = result.version == null ? null
      : redact(result.version, { identifier: true }).slice(0, SHAPING_LIMITS.versionChars);
    // What redaction dropped leads the reason: a reason is held to `reasonChars`, and the shaper's
    // own notes can fill it, so a diagnostic placed after them could be cut while the record
    // still says `redacted`.
    return {
      record: result.degraded
        ? record("degraded", [dropped, notes || "The shaper reported that it is degraded."].filter(Boolean).join(" "), version, redacted)
        // A reply that is not degraded keeps its notes too, such as the files a gatherer skipped,
        // so the record says what the shaper left out without marking the run degraded.
        : record("ok", [dropped, notes].filter(Boolean).join(" ") || null, version, redacted),
      entries: (result.guidance ?? []).map((guidance) => ({
        id: guidance.id, title: guidance.title ?? null, path: guidance.path ?? null,
        body: guidance.body, truncated: guidance.truncated === true,
      })),
      skills: result.skills ?? [],
      facts: result.repo?.facts ?? null,
      truncated: result.truncated === true,
      summary: result.repo?.summary ?? null,
    };
  };

  /**
   * Every context entry in pipeline order, fitted to what the total leaves once the skills'
   * reserve is set aside. Pure over the results so far: the route stage calls it before routers
   * run, to tell them what was selected, and the section is built from the same answer.
   */
  function allocateEntries() {
    // Candidates in pipeline order. The allocator de-duplicates them by their keys as it keeps them.
    const candidates: Array<{
      group: string; groupBytes: number; body: string; overhead: number; keys: string[];
      entry: Omit<ShapingInjectedEntry, "body" | "truncated" | "omittedBytes">; slot: string; sourceTruncated: boolean;
    }> = [];
    for (const { resolved: shaper, repo, result } of results) {
      for (const item of result.entries) {
        const entry = {
          shaperId: shaper.shaper.id, label: shaper.shaper.label, stage: shaper.shaper.stage, repo: repo.name,
          id: item.id, title: item.title, path: item.path,
        };
        const heading = shapingEntryHeading({ label: entry.label, title: entry.title ?? undefined, id: entry.id, repo: entry.repo }, multiRepo);
        candidates.push({
          group: shaper.shaper.id,
          groupBytes: shaper.shaper.maxBytes ?? config.limits.maxBytes,
          body: item.body,
          // "\n\n" before the heading and "\n" after it, as `composeShapingSection` joins them.
          overhead: utf8Length(heading) + 3,
          entry,
          slot: repo.slot,
          sourceTruncated: item.truncated,
          // De-duplicated per repository, and only against entries the budget keeps: the same id
          // from the same shaper, or an identical body from any shaper, is injected once for that
          // repository. Two repositories whose entries share an id both reach the section.
          // Keyed by slot, not name: two attached worktrees of one repository are separate here.
          keys: [`id\u0000${repo.slot}\u0000${shaper.shaper.id}\u0000${item.id}`, `body\u0000${repo.slot}\u0000${item.body}`],
        });
      }
    }
    const budget = allocateBudget(candidates, Math.max(0, totalBytes - reserve - utf8Length(SHAPING_SECTION_PREAMBLE)));
    const kept: Array<ShapingInjectedEntry & { slot: string }> = budget.kept.map((slot) => ({
      ...slot.item.entry, slot: slot.item.slot,
      body: slot.body, truncated: slot.truncated || slot.item.sourceTruncated, omittedBytes: slot.omittedBytes,
    }));
    return { budget, entries: kept };
  }

  // The launch may lower the total, never raise it: the section fits the smaller of the two.
  const launchCap = input.maxSectionBytes;
  const totalBytes = typeof launchCap === "number" && Number.isFinite(launchCap)
    ? Math.min(config.limits.totalBytes, Math.max(0, Math.floor(launchCap)))
    : config.limits.totalBytes;
  const callsFor = (stage: ShapingStage) => resolved.filter((entry) => entry.shaper.stage === stage).flatMap((entry) =>
    repositories.flatMap((repo, index) => entry.repositories.includes(repo.name) ? [{ entry, index }] : []));
  // While a router applies, its skills' room is set aside before any entry is allocated, so
  // guidance that fills the total cannot crowd them out. With no router nothing is reserved, and
  // the allocation is exactly what it was before routing existed.
  const routerApplies = callsFor("route").length > 0;
  const reserve = routerApplies ? Math.min(SHAPING_SKILLS_RESERVE_BYTES, totalBytes) : 0;
  let allocated: ReturnType<typeof allocateEntries> | null = null;

  try {
    for (const stage of SHAPING_STAGES) {
      const calls = callsFor(stage);
      if (calls.length === 0) continue;
      if (stage === "route") {
        // Every stage before this one has settled, so what reaches the section is known now, and
        // each router is told which selected entries made it for its repository (D13).
        allocated = allocateEntries();
        guidanceBySlot = new Map();
        for (const kept of allocated.entries) {
          if (kept.stage !== "select") continue;
          const list = guidanceBySlot.get(kept.slot) ?? [];
          list.push({ shaper: kept.shaperId, id: kept.id });
          guidanceBySlot.set(kept.slot, list);
        }
      }
      // At most `concurrentCalls` in flight. Results keep the call order whatever finishes first,
      // and a call that waits for a slot starts with what is left of the step's deadline.
      const settled = await mapBounded(calls, SHAPING_LIMITS.concurrentCalls, ({ entry, index }) => callOne(stage, entry, index));
      settled.forEach((result, at) => {
        const { entry, index } = calls[at]!;
        results.push({ stage, resolved: entry, repo: repositories[index]!, result });
        if (stage !== "gather") return;
        // Facts merge by name and the later gatherer wins; the summary is the last one returned.
        // Kept within the request's own bound, first names first.
        if (result.facts) {
          facts[index] = Object.fromEntries(Object.entries({ ...facts[index], ...result.facts }).slice(0, SHAPING_LIMITS.facts));
        }
        // A presence check: an empty summary a later gatherer returns replaces an earlier one,
        // and only an omitted one leaves it standing.
        if (result.summary !== null) summaries[index] = cutAtLineBoundary(result.summary, SHAPING_LIMITS.summaryBytes);
      });
    }
  } finally {
    clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", onCancel);
    run.abort();
    // Cleanup never delays the launch, and a failing one is only logged. Closing the scope also
    // covers an abandoned call whose transport registers cleanup after this point.
    scope.close();
  }

  const allocation = allocated ?? allocateEntries();
  const entries = allocation.entries.map(({ slot: _slot, ...entry }) => entry);
  const contextSection = composeShapingSection(entries.map((entry) => ({
    label: entry.label, title: entry.title ?? undefined, id: entry.id, repo: entry.repo, body: entry.body,
  })), multiRepo);
  const routed = routeSkills();
  const section = joinShapingSections(contextSection, routed.section);
  const truncatedShapers = new Set<string>([
    ...allocation.budget.kept.filter((slot) => slot.truncated || slot.item.sourceTruncated).map((slot) => slot.item.group),
    ...allocation.budget.dropped.map((drop) => drop.item.group),
    // A router whose skill was left out for the cap or the budget supplied more than turn one carries.
    ...routed.skills.filter((skill) => skill.state === "dropped").map((skill) => skill.shaper),
    // A shaper that says its reply was cut supplied incomplete context, entries or not. So does
    // one that marked any entry truncated, counted from every validated reply before
    // de-duplication, so a dropped duplicate's truncation is not lost with it.
    ...results.filter(({ result }) => result.truncated || result.entries.some((entry) => entry.truncated))
      .map(({ resolved: shaper }) => shaper.shaper.id),
  ]);
  const summary = summariseShaping({
    calls: results.map(({ result }) => result.record),
    kept: allocation.budget.kept.map((slot) => ({ shaperId: slot.item.group, bytes: slot.bytes, truncated: slot.truncated })),
    truncatedShapers,
    at: startedAt,
    durationMs: Math.round(performance.now() - startedMono),
    multiRepo,
  });
  return {
    summary: summary && { ...summary, bytes: utf8Length(section), ...(routerApplies ? { skills: routed.skills } : {}) },
    section,
    entries,
    skills: routed.skills,
  };

  /**
   * Every router's skills, merged, checked and fitted into what the task context left of the
   * total. The words of each line are Mission Control's; a router supplies only a validated name.
   */
  function routeSkills(): { skills: ShapingSkillSummary[]; section: string } {
    const replies = results.filter((call) => call.stage === "route")
      .map(({ resolved: shaper, repo, result }) => ({ shaper: shaper.shaper.id, repo: repo.name, skills: result.skills }));
    const skills = mergeRoutedSkills(replies);
    const agent = skillAgent(input);
    const ownTaskSkills = new Set(input.repositoryTaskSkills ?? []);
    const repositoryNames = new Set(repositories.map((repo) => repo.name));
    const references = new Map<ShapingSkillSummary, string>();
    for (const skill of skills) {
      if (skill.state !== "announced") continue;
      // D14: a routed skill named for the task's kind answers to the same invocation as a
      // repository's own task skill for that kind, so the repository's own wins where it is in
      // turn one. With no repository left, it is not announced at all.
      if (skill.name === input.context.kind && ownTaskSkills.size > 0) {
        skill.repositories = skill.repositories.filter((name) => !ownTaskSkills.has(name));
        if (skill.repositories.length === 0) {
          Object.assign(skill, { state: "superseded", reason: "The repository's own task skill for this kind is in turn one." });
          continue;
        }
      }
      if (!agent) {
        Object.assign(skill, { state: "unavailable", reason: "No harness was named to invoke it with." });
        continue;
      }
      let resolution: ReturnType<RoutedSkillResolver>;
      try {
        resolution = resolveSkill(agent, skill.name);
      } catch (error) {
        Object.assign(skill, { state: "unavailable", reason: bounded(`The skill could not be checked: ${error instanceof Error ? error.message : String(error)}`) });
        continue;
      }
      if (resolution.catalog && !resolution.ok) {
        Object.assign(skill, { state: "unavailable", reason: bounded(resolution.reason) });
        continue;
      }
      // D15: a catalog skill is checked and named as installed; any other name is taken as given.
      const reference = skillReference(agent, resolution.catalog ? resolution.name : skill.name);
      if (!reference) {
        Object.assign(skill, { state: "unavailable", reason: `${AGENT_IDENTITY[agent].label} cannot invoke a skill by name.` });
        continue;
      }
      skill.verified = resolution.catalog;
      references.set(skill, reference);
    }
    // What the task context left of the total, the reserve included. Lines that do not fit are
    // left out from the end, so the earliest-routed skills are the ones that reach the worker.
    const room = totalBytes - utf8Length(contextSection) - (contextSection ? 2 : 0);
    const announced = skills.filter((skill) => skill.state === "announced");
    const lines = announced.map((skill) => shapingSkillLine({
      reference: references.get(skill)!,
      // Announced skills have a known point: `mergeRoutedSkills` made the others unsupported.
      lifecyclePoint: isShapingLifecyclePoint(skill.lifecyclePoint) ? skill.lifecyclePoint : "during",
      // Only a skill routed for some of a task's repositories names them.
      repositories: multiRepo && skill.repositories.length < repositoryNames.size ? skill.repositories : null,
    }));
    let kept = lines.length;
    while (kept > 0 && utf8Length(composeSkillsSection(lines.slice(0, kept))) > room) kept -= 1;
    for (const skill of announced.slice(kept)) {
      Object.assign(skill, { state: "dropped", reason: "It did not fit in the context budget for turn one." });
    }
    return { skills, section: composeSkillsSection(lines.slice(0, kept)) };
  }
}
