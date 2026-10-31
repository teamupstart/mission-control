import { z } from "zod";
import { CODERABBIT_SEVERITIES, type CodeRabbitSeverity } from "@shared/workflow.ts";

export const CODERABBIT_RESULT_LIMITS = { recordBytes: 256 * 1024, findings: 1000, findingsBytes: 4 * 1024 * 1024 } as const;
const severities = [...CODERABBIT_SEVERITIES, "none"] as const;
const Finding = z.object({
  type: z.literal("finding"), severity: z.enum(severities), fileName: z.string().min(1).max(4000),
  title: z.string().optional(), comment: z.string().optional(), codegenInstructions: z.string().optional(),
  suggestions: z.union([z.string(), z.array(z.unknown())]).optional(),
  startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
}).refine((v) => Boolean(v.title || v.comment || v.codegenInstructions), "Finding has no content");
const Complete = z.object({
  type: z.literal("complete"), status: z.enum(["review_completed", "review_skipped"]),
  outcome: z.enum(["completed", "success", "completed_with_warnings", "failed"]).optional(),
  unreviewedFileCount: z.number().int().nonnegative(), reused: z.boolean().optional(),
  findings: z.number().int().nonnegative().optional(),
  gate: z.object({ threshold: z.enum(CODERABBIT_SEVERITIES), status: z.enum(["passed", "blocked", "incomplete"]), blockingFindings: z.number().int().nonnegative() }),
});
export type CodeRabbitFinding = z.infer<typeof Finding> & { id: string; displayPath: string | null };
export interface CodeRabbitResult {
  status: "passed" | "failed" | "skipped" | "incomplete";
  diagnostic: string;
  counts: Record<(typeof severities)[number], number>;
  titles: string[];
  body: Buffer;
  retryAt?: number;
  expectedDuration?: string;
}

/** Streaming stdout consumer, independent of the raw capture limit. Errors are sticky. */
export class CodeRabbitResultParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private findings: CodeRabbitFinding[] = [];
  private bytes = 0;
  private terminal: z.infer<typeof Complete> | null = null;
  private error: string | null = null;
  private finished = false;
  private retryAt: number | undefined;
  private expectedDuration: string | undefined;
  constructor(private readonly attemptId: string, private readonly threshold: CodeRabbitSeverity) {}

  push(chunk: Buffer): void {
    if (this.finished || this.error) return; // The supervisor continues draining both pipes.
    try { this.consume(this.decoder.decode(chunk, { stream: true })); }
    catch { this.error = "CodeRabbit stdout is not valid UTF-8 NDJSON"; }
  }
  private consume(text: string): void {
    this.pending += text;
    let cut: number;
    while (!this.error && (cut = this.pending.indexOf("\n")) >= 0) {
      const record = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut + 1);
      if (Buffer.byteLength(record) > CODERABBIT_RESULT_LIMITS.recordBytes) {
        this.error = "CodeRabbit semantic record exceeds 256 KiB"; break;
      }
      if (record.trim()) this.record(record);
    }
    if (Buffer.byteLength(this.pending) > CODERABBIT_RESULT_LIMITS.recordBytes) this.error = "CodeRabbit semantic record exceeds 256 KiB";
    if (this.error) this.pending = "";
  }
  private record(line: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { this.error = "Malformed CodeRabbit NDJSON"; return; }
    if (!event || typeof event.type !== "string") { this.error = "Invalid CodeRabbit event"; return; }
    if (this.terminal && ["finding", "complete"].includes(event.type)) { this.error = "CodeRabbit emitted findings or duplicate completion after terminal completion"; return; }
    if (event.type === "finding") {
      const parsed = Finding.safeParse(event);
      if (!parsed.success) { this.error = "Invalid CodeRabbit finding"; return; }
      const value = parsed.data;
      if (value.endLine && value.startLine && value.endLine < value.startLine) { this.error = "Invalid CodeRabbit line range"; return; }
      const path = value.fileName;
      const displayPath = !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !path.split("").some((character) => character.charCodeAt(0) < 32) ? path : null;
      const finding: CodeRabbitFinding = { ...value, id: `${this.attemptId}:${this.findings.length + 1}`, displayPath };
      const bytes = Buffer.byteLength(JSON.stringify(finding)) + 1;
      if (this.findings.length >= CODERABBIT_RESULT_LIMITS.findings || this.bytes + bytes > CODERABBIT_RESULT_LIMITS.findingsBytes) {
        this.error = "CodeRabbit normalized findings capacity exceeded"; return;
      }
      this.bytes += bytes; this.findings.push(finding);
    } else if (event.type === "review_context") {
      if (typeof event.expectedDuration === "string" || typeof event.expectedDuration === "number") this.expectedDuration = String(event.expectedDuration).slice(0, 250);
    } else if (event.type === "complete") {
      const parsed = Complete.safeParse(event);
      if (!parsed.success) this.error = "Invalid CodeRabbit completion/gate";
      else this.terminal = parsed.data;
    } else if (["error", "action_required", "auth", "usage", "rate_limit"].includes(event.type)
      || event.type === "status" && /error|failed|action_required|auth|usage|rate.limit|credit/i.test(String(event.status))) {
      // Never surface arbitrary vendor text that could contain a credential in compact SSE.
      if (typeof event.retryAfterSeconds === "number" && Number.isFinite(event.retryAfterSeconds) && event.retryAfterSeconds > 0) {
        this.retryAt = Date.now() + Math.min(event.retryAfterSeconds, 24 * 60 * 60) * 1000;
      }
      this.error = "CodeRabbit requires operator action (authentication, service, usage limit or interruption). Check stored login and vendor wait guidance in retained output; do not authorize credits automatically";
    }
  }
  finish(exitCode: number, emptyComparison: boolean): CodeRabbitResult {
    if (!this.finished) {
      try { this.consume(this.decoder.decode()); if (this.pending.trim() && !this.error) this.record(this.pending); }
      catch { this.error = "CodeRabbit stdout is not valid UTF-8 NDJSON"; }
      this.pending = ""; this.finished = true;
    }
    const counts = Object.fromEntries(severities.map((s) => [s, 0])) as CodeRabbitResult["counts"];
    for (const finding of this.findings) counts[finding.severity]++;
    const blocking = severities.slice(0, severities.indexOf(this.threshold) + 1).reduce((n, s) => n + counts[s], 0);
    const terminal = this.terminal;
    let diagnostic = this.error;
    if (!diagnostic && (!terminal || exitCode === 1 || terminal.outcome === "failed" || terminal.unreviewedFileCount > 0 || terminal.reused
      || terminal.gate.status === "incomplete")) diagnostic = "CodeRabbit review did not complete with full fresh coverage";
    if (!diagnostic && terminal && (terminal.gate.threshold !== this.threshold || terminal.gate.blockingFindings !== blocking
      || terminal.findings !== undefined && terminal.findings !== this.findings.length
      || terminal.gate.status !== (blocking ? "blocked" : "passed") || exitCode !== (blocking ? 2 : 0))) diagnostic = "CodeRabbit gate, findings and process exit disagree";
    if (!diagnostic && terminal && (terminal.status === "review_skipped" ? !emptyComparison || this.findings.length > 0 : emptyComparison)) diagnostic = "CodeRabbit no-change result disagrees with the pinned comparison";
    const status = diagnostic ? "incomplete" : terminal!.status === "review_skipped" ? "skipped" : blocking ? "failed" : "passed";
    return { status, diagnostic: diagnostic ?? (status === "skipped" ? "Warning: pinned comparison has no changes; review skipped" : `Complete CodeRabbit review: ${blocking} findings at or above ${this.threshold}; all ${this.findings.length} findings retained`),
      counts, titles: this.findings.slice(0, 8).map((f) => `${f.severity}: ${f.title ?? f.comment ?? "Finding"} (${f.displayPath ?? "unsafe path omitted"}:${f.startLine ?? "?"})`.slice(0, 250)),
      ...(this.retryAt ? { retryAt: this.retryAt } : {}),
      ...(this.expectedDuration ? { expectedDuration: this.expectedDuration } : {}),
      body: Buffer.from(this.findings.map((f) => JSON.stringify(f)).join("\n") + (this.findings.length ? "\n" : "")), };
  }
}
