import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  WORKFLOW_COMMAND_OUTPUT_LIMITS,
  type WorkflowCommandArtifactDescriptor,
  type WorkflowCommandOutputPage,
} from "@shared/workflow.ts";
import { STATE_DIR } from "../config.ts";
import { openDb } from "../db.ts";

export const WORKFLOW_COMMAND_OUTPUT_DIR = join(STATE_DIR, "workflow-command-output");

type StreamKind = "stdout" | "stderr";

interface WorkflowCommandArtifactIo {
  write(fd: number, buffer: Buffer, offset: number, length: number): number;
}

const DEFAULT_ARTIFACT_IO: WorkflowCommandArtifactIo = {
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
};

interface ArtifactRow {
  id: string;
  run_id: string;
  submission_id: string;
  attempt_id: string;
  kind: StreamKind | "findings";
  retained_bytes: number;
  observed_bytes: number;
  dropped_bytes: number;
  sha256: string | null;
  capture_state: "complete" | "partial";
  availability: "retained" | "pruned" | "unavailable";
  unavailable_reason: string | null;
  storage_key: string | null;
}

function descriptor(row: ArtifactRow): WorkflowCommandArtifactDescriptor {
  return {
    id: row.id,
    kind: row.kind,
    retainedBytes: row.retained_bytes,
    observedBytes: row.observed_bytes,
    droppedBytes: row.dropped_bytes,
    sha256: row.sha256,
    captureState: row.capture_state,
    availability: row.availability,
    unavailableReason: row.unavailable_reason,
  };
}

type AnsiSanitizerState = "plain" | "escape" | "csi-parameters" | "csi-intermediates";

function sanitize(value: string, initialState: AnsiSanitizerState): {
  text: string;
  state: AnsiSanitizerState;
} {
  const normalized = value.replace(/\r\n?/g, "\n");
  let state = initialState;
  let text = "";
  for (const character of normalized) {
    const code = character.codePointAt(0)!;
    if (state === "escape") {
      if (character === "[") {
        state = "csi-parameters";
        continue;
      }
      state = "plain";
    }
    if (state === "csi-parameters") {
      if (code >= 0x30 && code <= 0x3f) continue;
      if (code >= 0x20 && code <= 0x2f) {
        state = "csi-intermediates";
        continue;
      }
      if (code >= 0x40 && code <= 0x7e) {
        state = "plain";
        continue;
      }
      state = "plain";
    }
    if (state === "csi-intermediates") {
      if (code >= 0x20 && code <= 0x2f) continue;
      if (code >= 0x40 && code <= 0x7e) {
        state = "plain";
        continue;
      }
      state = "plain";
    }
    // An unsupported sequence falls through once. A fresh ESC starts the next sequence.
    if (code === 0x1b) {
      state = "escape";
      continue;
    }
    if (code === 9 || code === 10 || code >= 160 || (code >= 32 && code !== 127)) {
      text += character;
    }
  }
  return { text, state };
}

function safeUtf8Length(data: Buffer): number {
  let end = data.length;
  if (end === 0) return 0;
  let lead = end - 1;
  while (lead >= 0 && (data[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const byte = data[lead]!;
  const expected = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : byte < 0xf8 ? 4 : 1;
  if (end - lead < expected) end = lead;
  return end;
}

function encodeCursor(
  id: string,
  sha256: string,
  position: number,
  sanitizerState: AnsiSanitizerState,
): string {
  return Buffer.from(
    JSON.stringify({ v: 2, id, sha256, position, sanitizerState }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string | null | undefined): {
  id: string; sha256: string; position: number; sanitizerState: AnsiSanitizerState;
} | null {
  if (!value) return { id: "", sha256: "", position: 0, sanitizerState: "plain" };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if ((parsed.v !== 1 && parsed.v !== 2)
      || typeof parsed.id !== "string" || typeof parsed.sha256 !== "string"
      || !Number.isSafeInteger(parsed.position) || (parsed.position as number) < 0) return null;
    const sanitizerState = parsed.v === 1 ? "plain" : parsed.sanitizerState;
    if (sanitizerState !== "plain" && sanitizerState !== "escape"
      && sanitizerState !== "csi-parameters" && sanitizerState !== "csi-intermediates") return null;
    return {
      id: parsed.id,
      sha256: parsed.sha256,
      position: parsed.position as number,
      sanitizerState,
    };
  } catch {
    return null;
  }
}

interface CaptureStreamFacts {
  observed: number;
  retained: number;
  sha256: string | null;
  temp: string | null;
}

/** One attempt's byte-bounded, stream-separated capture. */
export class WorkflowCommandOutputCapture {
  private readonly fds = new Map<StreamKind, number>();
  private readonly temp = new Map<StreamKind, string>();
  private readonly hashes = new Map<StreamKind, ReturnType<typeof createHash>>();
  private readonly trimmed = new Set<StreamKind>();
  private readonly observed = new Map<StreamKind, number>([["stdout", 0], ["stderr", 0]]);
  private readonly retained = new Map<StreamKind, number>([["stdout", 0], ["stderr", 0]]);
  private total = 0;
  private failure: string | null = null;
  private finished = false;
  private capacityExceeded = false;

  constructor(
    private readonly service: WorkflowCommandArtifactService,
    readonly runId: string,
    readonly submissionId: string,
    readonly attemptId: string,
    readonly capacity: number,
    readonly semanticBytes = 0,
  ) {
    for (const kind of ["stdout", "stderr"] as const) {
      this.hashes.set(kind, createHash("sha256"));
      try {
        const path = service.tempPath(`${attemptId}-${kind}-${randomUUID()}.tmp`);
        this.temp.set(kind, path);
        this.fds.set(kind, openSync(path, "wx+", 0o600));
      } catch (error) {
        this.failure ??= error instanceof Error ? error.message : String(error);
      }
    }
  }

  push(kind: StreamKind, chunk: Buffer): void {
    this.observed.set(kind, (this.observed.get(kind) ?? 0) + chunk.length);
    if (this.failure || this.finished) return;
    if (this.total >= this.capacity) {
      if (chunk.length > 0) this.capacityExceeded = true;
      return;
    }
    const kept = chunk.subarray(0, Math.max(0, this.capacity - this.total));
    if (kept.length < chunk.length) this.capacityExceeded = true;
    if (kept.length === 0) return;
    try {
      const fd = this.fds.get(kind);
      if (fd === undefined) throw new Error(`${kind} capture is not open`);
      this.service.writeFully(fd, kept);
      this.hashes.get(kind)!.update(kept);
      this.retained.set(kind, (this.retained.get(kind) ?? 0) + kept.length);
      this.total += kept.length;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }

  finalize(complete: boolean): WorkflowCommandArtifactDescriptor[] {
    if (this.finished) return this.service.listForAttempt(this.attemptId);
    this.finished = true;
    if (this.capacityExceeded) this.trimIncompleteUtf8Tails();
    for (const fd of this.fds.values()) {
      try { closeSync(fd); } catch { /* best effort, metadata records failure below */ }
    }
    const facts = new Map<StreamKind, CaptureStreamFacts>();
    for (const kind of ["stdout", "stderr"] as const) facts.set(kind, this.facts(kind));
    return this.service.finalizeCapture(
      this,
      complete && this.failure === null,
      this.failure,
      facts,
    );
  }

  private facts(kind: StreamKind): CaptureStreamFacts {
    const temp = this.temp.get(kind) ?? null;
    let sha256: string | null = null;
    try {
      sha256 = this.trimmed.has(kind) && temp
        ? createHash("sha256").update(readFileSync(temp)).digest("hex")
        : this.hashes.get(kind)!.digest("hex");
    } catch (error) {
      this.failure ??= error instanceof Error ? error.message : String(error);
    }
    return {
      observed: this.observed.get(kind) ?? 0,
      retained: this.retained.get(kind) ?? 0,
      sha256,
      temp,
    };
  }

  /** A retention cap never publishes the leading bytes of a partial terminal code point. */
  private trimIncompleteUtf8Tails(): void {
    for (const kind of ["stdout", "stderr"] as const) {
      const retained = this.retained.get(kind) ?? 0;
      const fd = this.fds.get(kind);
      if (retained === 0 || fd === undefined) continue;
      const tail = Buffer.alloc(Math.min(4, retained));
      try {
        const bytes = readSync(fd, tail, 0, tail.length, retained - tail.length);
        const safe = safeUtf8Length(tail.subarray(0, bytes));
        const dropped = bytes - safe;
        if (dropped === 0) continue;
        const nextRetained = retained - dropped;
        ftruncateSync(fd, nextRetained);
        this.retained.set(kind, nextRetained);
        this.total -= dropped;
        this.trimmed.add(kind);
      } catch (error) {
        this.failure ??= error instanceof Error ? error.message : String(error);
      }
    }
  }
}

/** Durable metadata, bounded reservation and authorized body reader. */
export class WorkflowCommandArtifactService {
  // Exact files owned by live capture objects in this daemon singleton. A restarted service
  // has no live captures: its constructor marks reserved attempts interrupted before cleanup.
  private readonly activeTempPaths = new Set<string>();

  constructor(
    private readonly db: DatabaseSync = openDb(),
    private readonly root = WORKFLOW_COMMAND_OUTPUT_DIR,
    private readonly io: WorkflowCommandArtifactIo = DEFAULT_ARTIFACT_IO,
  ) {
    try { mkdirSync(join(this.root, "retained"), { recursive: true, mode: 0o700 }); } catch {
      // A later capture publishes explicit unavailable descriptors. Storage must not stop startup.
    }
    try { mkdirSync(join(this.root, ".tmp"), { recursive: true, mode: 0o700 }); } catch {
      // A later capture publishes explicit unavailable descriptors. Storage must not stop startup.
    }
    this.recoverInterrupted();
    this.reconcile();
  }

  beginCapture(input: { runId: string; submissionId: string; attemptId: string; semanticBytes?: number }): WorkflowCommandOutputCapture {
    const reserved = this.reserve(input.runId, input.attemptId, input.semanticBytes ?? 0);
    const capacity = Math.min(reserved, WORKFLOW_COMMAND_OUTPUT_LIMITS.retainedBytesPerAttempt);
    return new WorkflowCommandOutputCapture(
      this, input.runId, input.submissionId, input.attemptId, capacity, input.semanticBytes ?? 0,
    );
  }

  tempPath(name: string): string {
    const dir = join(this.root, ".tmp");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, basename(name));
    this.activeTempPaths.add(path);
    return path;
  }

  writeFully(fd: number, buffer: Buffer): void {
    let offset = 0;
    while (offset < buffer.length) {
      const remaining = buffer.length - offset;
      const written = this.io.write(fd, buffer, offset, remaining);
      if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
        throw new Error("Retained output storage made no valid write progress");
      }
      offset += written;
    }
  }

  private releaseTempPath(path: string): void {
    this.activeTempPaths.delete(path);
  }

  private reserve(runId: string, attemptId: string, semanticBytes = 0): number {
    const existing = this.db.prepare(
      `SELECT reserved_bytes FROM workflow_command_artifact_reservations WHERE attempt_id = ?`,
    ).get(attemptId) as { reserved_bytes: number } | undefined;
    if (existing) return existing.reserved_bytes;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN state = 'reserved' THEN reserved_bytes ELSE retained_bytes END), 0) AS n
           FROM workflow_command_artifact_reservations WHERE run_id = ?`,
      ).get(runId) as { n: number };
      const capacity = Math.max(0, Math.min(
        WORKFLOW_COMMAND_OUTPUT_LIMITS.retainedBytesPerAttempt + semanticBytes,
        WORKFLOW_COMMAND_OUTPUT_LIMITS.retainedBytesPerRun - Number(used.n),
      ));
      const now = Date.now();
      this.db.prepare(
        `INSERT INTO workflow_command_artifact_reservations
           (attempt_id, run_id, reserved_bytes, retained_bytes, state, created_at, updated_at)
         VALUES (?, ?, ?, 0, 'reserved', ?, ?)`,
      ).run(attemptId, runId, capacity, now, now);
      this.db.exec("COMMIT");
      return capacity;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finalizeCapture(
    capture: WorkflowCommandOutputCapture,
    complete: boolean,
    failure: string | null,
    streamFacts: ReadonlyMap<StreamKind, CaptureStreamFacts>,
  ): WorkflowCommandArtifactDescriptor[] {
    let retainedDirectoryAvailable = true;
    try {
      mkdirSync(join(this.root, "retained"), { recursive: true, mode: 0o700 });
    } catch {
      retainedDirectoryAvailable = false;
    }
    const now = Date.now();
    const rows: ArtifactRow[] = [];
    for (const kind of ["stdout", "stderr"] as const) {
      const facts = streamFacts.get(kind)!;
      const id = randomUUID();
      const storageKey = `${id}.${kind}.log`;
      let availability: ArtifactRow["availability"] = failure || !facts.temp || !facts.sha256
        || !retainedDirectoryAvailable ? "unavailable" : "retained";
      let reason = failure ? "Retained output storage failed" : null;
      if (!facts.temp || !retainedDirectoryAvailable) reason = "Retained output storage failed";
      if (capture.capacity === 0) {
        availability = "unavailable";
        reason = "The run retained-output quota was already full";
      }
      if (availability === "retained") {
        try {
          renameSync(facts.temp!, join(this.root, "retained", storageKey));
        } catch {
          availability = "unavailable";
          reason = "Retained output storage failed";
        }
      }
      if (facts.temp) {
        if (availability !== "retained") {
          try { rmSync(facts.temp, { force: true }); } catch { /* best effort */ }
        }
        this.releaseTempPath(facts.temp);
      }
      rows.push({
        id, run_id: capture.runId, submission_id: capture.submissionId,
        attempt_id: capture.attemptId, kind,
        retained_bytes: availability === "retained" ? facts.retained : 0,
        observed_bytes: facts.observed,
        dropped_bytes: facts.observed - (availability === "retained" ? facts.retained : 0),
        sha256: availability === "retained" ? facts.sha256 : null,
        capture_state: complete ? "complete" : "partial",
        availability, unavailable_reason: reason,
        storage_key: availability === "retained" ? storageKey : null,
      });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO workflow_command_artifacts
           (id, run_id, submission_id, attempt_id, kind, retained_bytes, observed_bytes,
            dropped_bytes, sha256, capture_state, availability, unavailable_reason,
            storage_key, created_at, finalized_at, pruned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      for (const row of rows) insert.run(
        row.id, row.run_id, row.submission_id, row.attempt_id, row.kind,
        row.retained_bytes, row.observed_bytes, row.dropped_bytes, row.sha256,
        row.capture_state, row.availability, row.unavailable_reason, row.storage_key, now, now,
      );
      const retained = rows.reduce((sum, row) => sum + row.retained_bytes, 0);
      this.db.prepare(
        `UPDATE workflow_command_artifact_reservations
            SET retained_bytes = ?, state = ?, updated_at = ? WHERE attempt_id = ?`,
      ).run(retained, capture.semanticBytes > 0 ? 'reserved' : 'finalized', now, capture.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.map(descriptor);
  }

  /** Independent complete semantic body; capacity was reserved before spawning the review. */
  publishFindings(input: { runId: string; submissionId: string; attemptId: string }, body: Buffer, complete: boolean): WorkflowCommandArtifactDescriptor {
    const existing = this.listForAttempt(input.attemptId).find((a) => a.kind === "findings");
    if (existing) return existing;
    const reservation = this.db.prepare("SELECT reserved_bytes FROM workflow_command_artifact_reservations WHERE attempt_id = ?").get(input.attemptId) as { reserved_bytes: number } | undefined;
    const raw = this.listForAttempt(input.attemptId).reduce((n, a) => n + a.retainedBytes, 0);
    const id = randomUUID();
    const key = `${id}.findings.log`;
    let temp: string | null = null;
    let available = false;
    const digest = createHash("sha256").update(body).digest("hex");
    try {
      if (!reservation || body.length + raw > reservation.reserved_bytes) throw new Error("Semantic output quota exceeded");
      temp = this.tempPath(`${id}.tmp`);
      const fd = openSync(temp, "wx", 0o600);
      try { this.writeFully(fd, body); } finally { closeSync(fd); }
      renameSync(temp, this.bodyPath(key));
      available = true;
    } catch { /* An unavailable descriptor prevents a successful reviewer outcome. */ }
    finally {
      if (temp) { this.releaseTempPath(temp); try { rmSync(temp, { force: true }); } catch { /* reconciled later */ } }
    }
    const now = Date.now();
    let transactionOpen = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      this.db.prepare(`INSERT INTO workflow_command_artifacts
        (id, run_id, submission_id, attempt_id, kind, retained_bytes, observed_bytes, dropped_bytes,
         sha256, capture_state, availability, unavailable_reason, storage_key, created_at, finalized_at)
         VALUES (?, ?, ?, ?, 'findings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.runId, input.submissionId, input.attemptId, available ? body.length : 0, body.length,
          available ? 0 : body.length, available ? digest : null, complete && available ? "complete" : "partial",
          available ? "retained" : "unavailable", available ? null : "Complete findings could not be retained within the run quota", available ? key : null, now, now);
      this.db.prepare("UPDATE workflow_command_artifact_reservations SET retained_bytes = ?, state = 'finalized', updated_at = ? WHERE attempt_id = ?")
        .run(raw + (available ? body.length : 0), now, input.attemptId);
      this.db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      if (available) { try { rmSync(this.bodyPath(key), { force: true }); } catch { /* startup reconciles unreferenced bodies */ } }
      try {
        this.db.prepare(`INSERT OR IGNORE INTO workflow_command_artifacts
          (id, run_id, submission_id, attempt_id, kind, retained_bytes, observed_bytes, dropped_bytes,
           sha256, capture_state, availability, unavailable_reason, storage_key, created_at, finalized_at)
          VALUES (?, ?, ?, ?, 'findings', 0, ?, ?, NULL, 'partial', 'unavailable', ?, NULL, ?, ?)`)
          .run(id, input.runId, input.submissionId, input.attemptId, body.length, body.length,
            "Findings publication was interrupted", now, now);
      } finally {
        // Release only this attempt's unused capacity, even if its unavailable descriptor
        // cannot be inserted. Other reviews may still be collecting their semantic output.
        this.db.prepare("UPDATE workflow_command_artifact_reservations SET retained_bytes = ?, state = 'interrupted', updated_at = ? WHERE attempt_id = ? AND state = 'reserved'")
          .run(raw, now, input.attemptId);
      }
      throw error;
    }
    return this.listForAttempt(input.attemptId).find((a) => a.kind === "findings")!;
  }

  listForAttempt(attemptId: string): WorkflowCommandArtifactDescriptor[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_command_artifacts WHERE attempt_id = ?
       ORDER BY CASE kind WHEN 'stdout' THEN 0 WHEN 'stderr' THEN 1 ELSE 2 END`,
    ).all(attemptId) as unknown as ArtifactRow[]).map(descriptor);
  }

  read(input: {
    runId: string; attemptId: string; artifactId: string;
    cursor?: string | null; limit?: number;
  }): WorkflowCommandOutputPage {
    const row = this.db.prepare(
      `SELECT * FROM workflow_command_artifacts
        WHERE id = ? AND run_id = ? AND attempt_id = ?`,
    ).get(input.artifactId, input.runId, input.attemptId) as ArtifactRow | undefined;
    if (!row) throw new CommandArtifactReadError("command_output_not_found", "No such retained Command output", 404);
    if (row.availability === "pruned") {
      throw new CommandArtifactReadError("command_output_pruned", "Retained Command output has been pruned", 410);
    }
    if (row.availability !== "retained" || !row.storage_key || !row.sha256) {
      throw new CommandArtifactReadError(
        "command_output_unavailable", row.unavailable_reason ?? "Retained Command output is unavailable", 409,
      );
    }
    const cursor = decodeCursor(input.cursor);
    if (!cursor) throw new CommandArtifactReadError("command_output_cursor", "Command output cursor is invalid", 400);
    if (input.cursor && (cursor.id !== row.id || cursor.sha256 !== row.sha256)) {
      throw new CommandArtifactReadError("command_output_cursor", "Command output cursor names another artifact", 400);
    }
    const position = cursor.position;
    if (position > row.retained_bytes) {
      throw new CommandArtifactReadError("command_output_cursor", "Command output cursor is past the retained body", 400);
    }
    const limit = Math.max(WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMin, Math.min(
      Number.isSafeInteger(input.limit) ? input.limit! : WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMax,
      WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMax,
    ));
    const path = this.bodyPath(row.storage_key);
    let fd: number | null = null;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("symbolic link");
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const data = Buffer.alloc(Math.min(limit, row.retained_bytes - position));
      const bytes = readSync(fd, data, 0, data.length, position);
      const available = data.subarray(0, bytes);
      const safeLength = safeUtf8Length(available);
      if (safeLength < bytes && position + bytes === row.retained_bytes) {
        throw new CommandArtifactReadError(
          "command_output_encoding",
          "Retained Command output ends with incomplete UTF-8",
          409,
        );
      }
      const slice = available.subarray(0, safeLength);
      const nextPosition = position + slice.length;
      if (nextPosition === position && position < row.retained_bytes) {
        throw new CommandArtifactReadError(
          bytes === 0 ? "command_output_unavailable" : "command_output_encoding",
          bytes === 0
            ? "Retained Command output ended before its recorded byte count"
            : "Retained Command output cannot advance from this cursor",
          409,
        );
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
      } catch {
        throw new CommandArtifactReadError(
          "command_output_encoding",
          "Retained Command output contains invalid UTF-8 at this cursor",
          409,
        );
      }
      const sanitized = sanitize(text, cursor.sanitizerState);
      return {
        artifact: descriptor(row),
        text: sanitized.text,
        nextCursor: nextPosition < row.retained_bytes
          ? encodeCursor(row.id, row.sha256, nextPosition, sanitized.state)
          : null,
      };
    } catch (error) {
      if (error instanceof CommandArtifactReadError) throw error;
      throw new CommandArtifactReadError("command_output_unavailable", "Retained Command output could not be opened safely", 409);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  /** Mark interrupted reservations unavailable and remove bodies no retained row owns. */
  recoverInterrupted(): void {
    const now = Date.now();
    const interrupted = this.db.prepare(
      `SELECT r.attempt_id, r.run_id, a.submission_id, a.check_run_slot
         FROM workflow_command_artifact_reservations r
         JOIN workflow_node_attempts a ON a.id = r.attempt_id
        WHERE r.state = 'reserved'`,
    ).all() as Array<{ attempt_id: string; run_id: string; submission_id: string; check_run_slot: string | null }>;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO workflow_command_artifacts
         (id, run_id, submission_id, attempt_id, kind, retained_bytes, observed_bytes,
          dropped_bytes, sha256, capture_state, availability, unavailable_reason,
          storage_key, created_at, finalized_at, pruned_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL, 'partial', 'unavailable', ?, NULL, ?, ?, NULL)`,
    );
    for (const row of interrupted) {
      const kinds = row.check_run_slot === "coderabbit" ? ["stdout", "stderr", "findings"] : ["stdout", "stderr"];
      for (const kind of kinds) {
        insert.run(
          randomUUID(), row.run_id, row.submission_id, row.attempt_id, kind,
          "Capture was interrupted before retained output could be published", now, now,
        );
      }
    }
    this.db.prepare(
      `UPDATE workflow_command_artifact_reservations AS r
          SET state = 'interrupted', retained_bytes = (SELECT COALESCE(SUM(a.retained_bytes), 0)
            FROM workflow_command_artifacts a WHERE a.attempt_id = r.attempt_id), updated_at = ? WHERE state = 'reserved'`,
    ).run(now);
  }

  reconcile(): void {
    const referenced = new Set((this.db.prepare(
      `SELECT storage_key FROM workflow_command_artifacts
        WHERE availability = 'retained' AND storage_key IS NOT NULL`,
    ).all() as Array<{ storage_key: string }>).map((row) => row.storage_key));
    const retained = join(this.root, "retained");
    if (existsSync(retained)) {
      let names: string[] = [];
      try { names = readdirSync(retained); } catch {
        // An obstructed startup path is reported unavailable by the next capture.
      }
      for (const name of names) {
        if (!referenced.has(name)) {
          try { rmSync(join(retained, name), { force: true }); } catch {
            // Cleanup is retried later; an orphan must not keep the daemon from supervising Commands.
          }
        }
      }
    }
    const temp = join(this.root, ".tmp");
    if (existsSync(temp)) {
      let names: string[] = [];
      try { names = readdirSync(temp); } catch {
        // An obstructed startup path is reported unavailable by the next capture.
      }
      for (const name of names) {
        const path = join(temp, name);
        if (!this.activeTempPaths.has(path)) {
          try { rmSync(path, { force: true }); } catch {
            // Cleanup is retried later; an orphan must not keep the daemon from supervising Commands.
          }
        }
      }
    }
  }

  private bodyPath(storageKey: string): string {
    if (basename(storageKey) !== storageKey || storageKey === "." || storageKey === "..") {
      throw new CommandArtifactReadError("command_output_path", "Retained Command output locator is invalid", 409);
    }
    const root = resolve(this.root, "retained");
    const path = resolve(root, storageKey);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new CommandArtifactReadError("command_output_path", "Retained Command output left its storage root", 409);
    }
    return path;
  }
}

export class CommandArtifactReadError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 410) {
    super(message);
  }
}
