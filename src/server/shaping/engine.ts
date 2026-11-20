import { createHash } from "node:crypto";
import {
  allocateBudget,
  canonicalJson,
  composeShapingSection,
  cutAtLineBoundary,
  describeInvalidResult,
  resolveShaperById,
  resolveShapers,
  SHAPING_LIMITS,
  SHAPING_PROTOCOL,
  SHAPING_SECTION_PREAMBLE,
  shaperIsLocal,
  shapingEntryHeading,
  shapingSlot,
  ShapingRequestSchema,
  ShapingResultSchema,
  summariseShaping,
  utf8Length,
  type DiscoveredShaper,
  type ResolvedShaper,
  type ShapingCallRecord,
  type ShapingConfig,
  type ShapingContext,
  type ShapingFacts,
  type ShapingOutcome,
  type ShapingRequest,
  type ShapingStage,
  type TaskShaping,
} from "@shared/shaping.ts";
import { SHAPING_STAGES } from "@shared/shaping-registry.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { discoverShapers } from "./discovery.ts";
import { withoutNul } from "./references.ts";
import { getShapingConfig } from "./index.ts";
import {
  callTransport, SHAPING_TRANSPORT_CALLS, type ShapingRunScope, type ShapingTraceContext, type ShapingTransportCalls, type TransportReply,
} from "./transports/index.ts";

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
}

/** One entry as it would be injected, for the record, the viewer and the dry run. */
export interface ShapingInjectedEntry {
  shaperId: string;
  label: string;
  stage: string;
  repo: string;
  id: string;
  title: string | null;
  path: string | null;
  body: string;
  truncated: boolean;
  omittedBytes: number;
}

export interface ShapingRun {
  /** Null when no shaper applied. */
  summary: TaskShaping | null;
  /** The section for turn one. Empty when nothing was kept. */
  section: string;
  entries: ShapingInjectedEntry[];
}

export interface ShapeTaskDeps {
  config?: ShapingConfig;
  discovered?: readonly DiscoveredShaper[];
  transports?: ShapingTransportCalls;
  /** Overrides the `task-shaping` flag, for tests. */
  enabled?: boolean;
}

/** A fresh empty run for every caller: nothing a caller does to one can leak into the next. */
/** A call with this little time left is recorded as out of time rather than started. */
const MIN_CALL_MS = 10;

function emptyRun(): ShapingRun {
  return { summary: null, section: "", entries: [] };
}

/** Shape one task. Resolves to an empty run when the flag is off or no shaper applies. */
export async function shapeTask(input: ShapeTaskInput, deps: ShapeTaskDeps = {}): Promise<ShapingRun> {
  try {
    if (!(deps.enabled ?? featureEnabled("task-shaping"))) return emptyRun();
    const config = deps.config ?? getShapingConfig();
    const discovered = deps.discovered ?? await discoverShapers();
    const resolved = resolveShapers(config, discovered, {
      kind: input.context.kind, repositories: input.context.repositories,
    });
    if (resolved.length === 0) return emptyRun();
    return await runShaping(resolved, input, config, deps.transports ?? SHAPING_TRANSPORT_CALLS);
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
  const discovered = deps.discovered ?? await discoverShapers();
  const found = resolveShaperById(config, discovered, id, {
    kind: input.context.kind, repositories: input.context.repositories,
  });
  if (!found.ok) return found;
  return { ok: true, run: await runShaping([found.resolved], input, config, deps.transports ?? SHAPING_TRANSPORT_CALLS) };
}

/** The SHA-256 of the definition that ran: canonical JSON for a registered shaper, the manifest's bytes for a discovered one. */
export function shaperSha256(resolved: Pick<ResolvedShaper, "stored" | "sha256">): string | null {
  if (resolved.sha256) return resolved.sha256;
  return resolved.stored ? createHash("sha256").update(canonicalJson(resolved.stored)).digest("hex") : null;
}

interface CallResult {
  record: ShapingCallRecord;
  entries: Array<{ id: string; title: string | null; path: string | null; body: string; truncated: boolean }>;
  facts: ShapingFacts | null;
  summary: string | null;
  /** The reply said it was truncated as a whole, whether or not any entry says so. */
  truncated: boolean;
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

async function runShaping(
  resolved: readonly ResolvedShaper[],
  input: ShapeTaskInput,
  config: ShapingConfig,
  transports: ShapingTransportCalls,
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
  const repositories = orderRepositories(input.context.repositories);
  const multiRepo = repositories.length > 1;
  const hashes = new Map(resolved.map((entry) => [entry.shaper.id, shaperSha256(entry)]));
  const facts = repositories.map((): ShapingFacts | null => null);
  const summaries = repositories.map((): string | null => null);
  const results: Array<{ resolved: ResolvedShaper; repo: ShapeTaskRepository & { slot: string }; result: CallResult }> = [];

  const contextFor = (local: boolean, target: string): ShapingContext => ({
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
      record: record(outcome, reason, null, redacted), entries: [], facts: null, summary: null, truncated: false,
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
      context: contextFor(local, repo.slot),
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
    try {
      reply = await Promise.race([
        // The parsed request, so a transport receives only the fields the wire contract declares.
        callTransport(wire.data, entry.shaper, {
          deadline, timeoutMs, signal: call.signal, scope, root: entry.root, trace: input.trace ?? null,
        }, transports),
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
    const late = performance.now() - callStart > timeoutMs;
    if (reply === "abandoned") return run.signal.aborted ? stopped() : timedOut();
    // The call's deadline applies to every reply, not only to data. A busy event loop can let a
    // transport settle after the deadline before the overdue timer runs: whatever it says then
    // is a timeout, keeping the transport's own timeout diagnostic when it gave one.
    if (late) {
      if (run.signal.aborted) return stopped();
      return reply.kind === "timed_out" ? empty("timed_out", reply.reason, reply.redacted === true) : timedOut();
    }
    const redacted = reply.redacted === true;
    if (reply.kind !== "data") return empty(reply.kind, reply.reason, redacted);

    // Every reason below is built from text the shaper wrote, so it is scrubbed of what the
    // transport handed the shaper before it is recorded, and before it is cut to length.
    const scrub = reply.redact ?? ((text: string) => text);
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
    const parsed = ShapingResultSchema.safeParse(value);
    if (!parsed.success) return empty("invalid", scrub(describeInvalidResult(parsed.error)), redacted);
    const result = parsed.data;
    const notes = scrub(result.notes?.filter((note) => note.trim()).join(" ") ?? "");
    // What the transport dropped while redacting, recorded whatever the outcome: a successful
    // reply that lost an entry still says so, and still answers `ok`.
    const dropped = (reply.redactionNotes ?? []).join(" ");
    // The version is the shaper's text too, recorded and returned, so it is scrubbed as an
    // identifier (a named credential and any long value go, `v1.4.0` keeps an inherited "0"),
    // then held to its bound: a replacement can be longer than what it replaced.
    const version = result.version == null ? null
      : (reply.redact ? reply.redact(result.version, { identifier: true }) : result.version).slice(0, SHAPING_LIMITS.versionChars);
    return {
      record: result.degraded
        ? record("degraded", [notes || "The shaper reported that it is degraded.", dropped].filter(Boolean).join(" "), version, redacted)
        : record("ok", dropped || null, version, redacted),
      entries: result.guidance.map((guidance) => ({
        id: guidance.id, title: guidance.title ?? null, path: guidance.path ?? null,
        body: guidance.body, truncated: guidance.truncated === true,
      })),
      facts: result.repo?.facts ?? null,
      truncated: result.truncated === true,
      summary: result.repo?.summary ?? null,
    };
  };

  try {
    for (const stage of SHAPING_STAGES) {
      const calls = resolved.filter((entry) => entry.shaper.stage === stage).flatMap((entry) =>
        repositories.flatMap((repo, index) => entry.repositories.includes(repo.name) ? [{ entry, index }] : []));
      if (calls.length === 0) continue;
      const settled = await Promise.all(calls.map(({ entry, index }) => callOne(stage, entry, index)));
      settled.forEach((result, at) => {
        const { entry, index } = calls[at]!;
        results.push({ resolved: entry, repo: repositories[index]!, result });
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

  // Candidates in pipeline order. The allocator de-duplicates them by their keys as it keeps them.
  const candidates: Array<{
    group: string; groupBytes: number; body: string; overhead: number; keys: string[];
    entry: Omit<ShapingInjectedEntry, "body" | "truncated" | "omittedBytes">; sourceTruncated: boolean;
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
        sourceTruncated: item.truncated,
        // De-duplicated per repository, and only against entries the budget keeps: the same id
        // from the same shaper, or an identical body from any shaper, is injected once for that
        // repository. Two repositories whose entries share an id both reach the section.
        // Keyed by slot, not name: two attached worktrees of one repository are separate here.
        keys: [`id\u0000${repo.slot}\u0000${shaper.shaper.id}\u0000${item.id}`, `body\u0000${repo.slot}\u0000${item.body}`],
      });
    }
  }
  // The launch may lower the total, never raise it: the section fits the smaller of the two.
  const launchCap = input.maxSectionBytes;
  const totalBytes = typeof launchCap === "number" && Number.isFinite(launchCap)
    ? Math.min(config.limits.totalBytes, Math.max(0, Math.floor(launchCap)))
    : config.limits.totalBytes;
  const allocation = allocateBudget(candidates, Math.max(0, totalBytes - utf8Length(SHAPING_SECTION_PREAMBLE)));
  const entries: ShapingInjectedEntry[] = allocation.kept.map((slot) => ({
    ...slot.item.entry, body: slot.body, truncated: slot.truncated || slot.item.sourceTruncated, omittedBytes: slot.omittedBytes,
  }));
  const section = composeShapingSection(entries.map((entry) => ({
    label: entry.label, title: entry.title ?? undefined, id: entry.id, repo: entry.repo, body: entry.body,
  })), multiRepo);
  const truncatedShapers = new Set<string>([
    ...allocation.kept.filter((slot) => slot.truncated || slot.item.sourceTruncated).map((slot) => slot.item.group),
    ...allocation.dropped.map((drop) => drop.item.group),
    // A shaper that says its reply was cut supplied incomplete context, entries or not. So does
    // one that marked any entry truncated, counted from every validated reply before
    // de-duplication, so a dropped duplicate's truncation is not lost with it.
    ...results.filter(({ result }) => result.truncated || result.entries.some((entry) => entry.truncated))
      .map(({ resolved: shaper }) => shaper.shaper.id),
  ]);
  const summary = summariseShaping({
    calls: results.map(({ result }) => result.record),
    kept: allocation.kept.map((slot) => ({ shaperId: slot.item.group, bytes: slot.bytes, truncated: slot.truncated })),
    truncatedShapers,
    at: startedAt,
    durationMs: Math.round(performance.now() - startedMono),
    multiRepo,
  });
  return { summary: summary && { ...summary, bytes: utf8Length(section) }, section, entries };
}
