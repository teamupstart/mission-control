import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  RepositoryBudgets,
  RepositoryEvidenceHandleMetadata,
  RepositoryEvidenceRange,
  RepositoryFailureCode,
  RepositoryManifestEntry,
  RepositoryOperationId,
  RepositoryOperationRequest,
  RepositoryOperationResult,
  RepositoryQueryAuditMetadata,
  RepositoryViewDescriptor,
} from "@shared/repository-access.ts";
import {
  REPOSITORY_OPERATION_IDS,
  RepositoryCursorMetadataSchema,
  RepositoryOperationResultSchema,
  RepositoryOperationRequestSchema,
  RepositoryViewDescriptorSchema,
} from "@shared/repository-access.ts";
import {
  approveRepositoryPath,
  canonicalRepositoryPath,
  RepositoryPathPolicyError,
  repositoryPathDenied,
  validateRevisionId,
} from "./security.ts";
import { scrubSecrets } from "../security/scrub.ts";

const execFileAsync = promisify(execFile);
const FAILURE_AUDIT_RESERVE_MS = 100;
const REPOSITORY_AUDIT_COMMITTED = Symbol("repositoryAuditCommitted");

export interface RepositoryAuditSink {
  append(metadata: RepositoryQueryAuditMetadata, signal: AbortSignal): Promise<void>;
}

export interface RepositoryReaderIdentity {
  workloadId: string;
  workflowAttemptId: string;
}

export interface RepositoryReaderWorktreeFileSystem {
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
  readlink(path: string): Promise<Buffer>;
}

export interface RepositoryReaderOptions {
  descriptor: RepositoryViewDescriptor;
  identity: RepositoryReaderIdentity;
  budgets: RepositoryBudgets;
  cursorSecret?: Uint8Array;
  audit: RepositoryAuditSink;
  now?: () => number;
  worktreeFileSystem?: RepositoryReaderWorktreeFileSystem;
}

interface MutableBudget {
  calls: number;
  bytes: number;
  startedAt: number;
}

interface PendingItem {
  path?: string;
  kind: "text" | "path" | "status" | "commit" | "blame" | "diff";
  text?: string;
  metadata?: Record<string, string | number | boolean | null>;
  range?: RepositoryEvidenceRange;
}

const GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.pager=cat",
  "-c", "pager.show=false",
  "-c", "pager.diff=false",
  "-c", "diff.external=",
  "-c", "diff.noprefix=false",
  "-c", "color.ui=false",
  "-c", "credential.helper=",
  "-c", "protocol.file.allow=never",
  "-c", "remote.origin.promisor=false",
] as const;

const DEFAULT_WORKTREE_FILE_SYSTEM: RepositoryReaderWorktreeFileSystem = {
  lstat,
  open,
  readlink: (path) => readlink(path, { encoding: "buffer" }),
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutCursor(request: RepositoryOperationRequest): unknown {
  const { cursor: _cursor, ...rest } = request;
  return rest;
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\0", ".*");
  return new RegExp(`^${source}$`, "u");
}

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function bufferIsText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes);
}

const EVIDENCE_HANDLE_SIZE_PLACEHOLDER = `reh_${"x".repeat(32)}`;

function serializedItemBytes(item: unknown): number {
  return Buffer.byteLength(JSON.stringify(item));
}

function pendingItemBytes(item: PendingItem, ordinal: number): number {
  return serializedItemBytes({
    ...item,
    ordinal,
    metadata: item.metadata ?? {},
    ...(item.path && item.range ? { evidenceHandleId: EVIDENCE_HANDLE_SIZE_PLACEHOLDER } : {}),
  });
}

function resultBytes(items: readonly unknown[]): number {
  return items.reduce<number>((total, item) => total + serializedItemBytes(item), 0);
}

function parseDiffHunks(text: string, path: string): PendingItem[] {
  const lines = text.split("\n");
  const hunks: PendingItem[] = [];
  let current: string[] = [];
  let range: RepositoryEvidenceRange | null = null;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      if (range) hunks.push({ path, kind: "diff", text: current.join("\n"), range });
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      range = {
        kind: "diff",
        old: { startLine: Math.max(1, oldStart), endLineExclusive: Math.max(1, oldStart) + oldCount },
        new: { startLine: Math.max(1, newStart), endLineExclusive: Math.max(1, newStart) + newCount },
      };
      current = [line];
    } else if (range) {
      current.push(line);
    }
  }
  if (range) hunks.push({ path, kind: "diff", text: current.join("\n").replace(/\n$/, ""), range });
  return hunks;
}

function assertPatchHeaders(text: string, allowed: ReadonlySet<string>): void {
  for (const line of text.split("\n")) {
    const pair = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (pair && (!allowed.has(pair[1]!) || !allowed.has(pair[2]!))) {
      throw new Error("Git returned an unapproved patch path");
    }
    const single = /^(?:--- a\/|\+\+\+ b\/)(.*)$/.exec(line);
    if (single && !allowed.has(single[1]!)) throw new Error("Git returned an unapproved patch path");
  }
}

function assertPatchIsText(text: string): void {
  if (/^(?:Binary files .* differ|GIT binary patch)$/mu.test(text)) {
    throw new RepositoryPathPolicyError("path_denied", "binary repository diff is unavailable");
  }
}

function settleBeforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class RepositoryReader {
  private readonly descriptor: RepositoryViewDescriptor;
  private readonly entries: Map<string, RepositoryManifestEntry>;
  private readonly retained: Set<string>;
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly usage: MutableBudget;
  private readonly worktreeFileSystem: RepositoryReaderWorktreeFileSystem;

  constructor(private readonly options: RepositoryReaderOptions) {
    this.descriptor = RepositoryViewDescriptorSchema.parse(options.descriptor);
    this.entries = new Map();
    for (const entry of this.descriptor.entries) {
      const path = canonicalRepositoryPath(entry.path, false);
      if (this.entries.has(path)) throw new Error("repository descriptor contains a duplicate path");
      if (repositoryPathDenied(path) && !entry.sensitive) {
        throw new Error("repository descriptor marks a protected path as readable");
      }
      this.entries.set(path, entry);
    }
    this.retained = new Set(this.descriptor.retainedRevisions.map((revision) => revision.id));
    this.secret = Buffer.from(options.cursorSecret ?? randomBytes(32));
    if (this.secret.byteLength < 32) throw new Error("repository cursor secret must be at least 32 bytes");
    this.now = options.now ?? Date.now;
    this.worktreeFileSystem = options.worktreeFileSystem ?? DEFAULT_WORKTREE_FILE_SYSTEM;
    this.usage = { calls: 0, bytes: 0, startedAt: this.now() };
  }

  async execute(input: unknown, signal: AbortSignal): Promise<RepositoryOperationResult> {
    const startedAt = this.now();
    const parsed = RepositoryOperationRequestSchema.safeParse(input);
    const operation = parsed.success ? parsed.data.operation : this.operationHint(input);
    const operationInstanceId = randomUUID();
    if (!parsed.success) {
      return this.finishFailure(operation, operationInstanceId, "invalid", "request_invalid", "request did not match the closed operation schema", startedAt);
    }
    const request = parsed.data;
    const inputHash = sha256(stableJson(withoutCursor(request)));
    let deadlineSignal: AbortSignal | undefined;
    try {
      const remainingAttemptMs = this.chargeCall();
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      const cursorPosition = request.cursor ? this.readCursor(request.cursor, request.operation, inputHash) : 0;
      deadlineSignal = AbortSignal.timeout(Math.min(this.options.budgets.maxCallMs, remainingAttemptMs));
      const callSignal = AbortSignal.any([signal, deadlineSignal]);
      const pending = await this.run(request, cursorPosition, callSignal);
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      if (deadlineSignal.aborted || this.now() - this.usage.startedAt >= this.options.budgets.maxAttemptMs) {
        throw Object.assign(new Error("repository call deadline exceeded"), { code: "deadline_exceeded" });
      }
      return await this.finishSuccess(request, operationInstanceId, inputHash, pending, startedAt, callSignal);
    } catch (error) {
      const failure = this.failureOf(error, signal, deadlineSignal);
      const auditCommitted = typeof error === "object"
        && error !== null
        && (error as { [REPOSITORY_AUDIT_COMMITTED]?: unknown })[REPOSITORY_AUDIT_COMMITTED] === true;
      return this.finishFailure(operation, operationInstanceId, failure.status, failure.code, failure.message, startedAt, inputHash, !auditCommitted);
    }
  }

  private operationHint(input: unknown): RepositoryOperationId {
    const candidate = input && typeof input === "object" ? (input as { operation?: unknown }).operation : null;
    return typeof candidate === "string" && REPOSITORY_OPERATION_IDS.includes(candidate as RepositoryOperationId)
      ? candidate as RepositoryOperationId
      : "read";
  }

  private chargeCall(): number {
    this.usage.calls += 1;
    if (this.usage.calls > this.options.budgets.maxCalls) {
      throw Object.assign(new Error("repository call budget exhausted"), { code: "budget_exhausted" });
    }
    const remainingAttemptMs = this.options.budgets.maxAttemptMs - (this.now() - this.usage.startedAt);
    if (remainingAttemptMs <= FAILURE_AUDIT_RESERVE_MS) {
      throw Object.assign(new Error("repository attempt deadline exceeded"), { code: "deadline_exceeded" });
    }
    return remainingAttemptMs - FAILURE_AUDIT_RESERVE_MS;
  }

  private async run(request: RepositoryOperationRequest, position: number, signal: AbortSignal): Promise<{ items: PendingItem[]; next: number | null; reason: RepositoryOperationResult["truncationReason"]; history?: boolean }> {
    switch (request.operation) {
      case "read": return this.read(request, position, signal);
      case "search": return this.search(request, position, signal);
      case "glob": return this.glob(request, position, signal);
      case "git_status": return this.status(position, signal);
      case "git_diff": return this.diff(request, position, signal);
      case "git_show": return this.show(request, position, signal);
      case "git_log": return this.log(request, position, signal);
      case "git_blame": return this.blame(request, position, signal);
    }
  }

  private entry(path: string): RepositoryManifestEntry {
    const approved = approveRepositoryPath(path);
    const entry = this.entries.get(approved);
    if (!entry || entry.sensitive || !entry.addressable) throw new RepositoryPathPolicyError("path_denied", "repository path is unavailable");
    if (entry.kind === "submodule") throw new RepositoryPathPolicyError("path_denied", "submodule traversal is unavailable");
    return entry;
  }

  private async worktreeBytes(entry: RepositoryManifestEntry, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
    const absolute = `${this.descriptor.repositoryRoot}/${entry.path}`;
    const stat = await this.worktreeFileSystem.lstat(absolute);
    if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
    if (stat.size > this.options.budgets.maxResponseBytes * 4) {
      throw Object.assign(new Error("repository file exceeds the bounded reader limit"), { code: "response_too_large" });
    }
    if (entry.kind === "symlink") {
      if (!stat.isSymbolicLink()) throw Object.assign(new Error("materialized symlink changed type"), { code: "view_unavailable" });
      const value = await this.worktreeFileSystem.readlink(absolute);
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      this.assertWorktreeObject(entry, value);
      return value;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("materialized file changed type"), { code: "view_unavailable" });
    const file = await this.worktreeFileSystem.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    try {
      const openedStat = await file.stat();
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      if (!openedStat.isFile()) throw Object.assign(new Error("materialized file changed type"), { code: "view_unavailable" });
      if (openedStat.size > this.options.budgets.maxResponseBytes * 4) {
        throw Object.assign(new Error("repository file exceeds the bounded reader limit"), { code: "response_too_large" });
      }
      const value = await file.readFile({ signal });
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      this.assertWorktreeObject(entry, value);
      return value;
    } finally {
      await file.close();
    }
  }

  private assertWorktreeObject(entry: RepositoryManifestEntry, bytes: Buffer): void {
    if (!entry.worktreePresent || !entry.worktreeObjectId || !entry.worktreeObjectSha256) {
      throw Object.assign(new Error("captured worktree object is unavailable"), { code: "view_unavailable" });
    }
    const header = `blob ${bytes.byteLength}\0`;
    const integrityDigest = createHash("sha256")
      .update(header)
      .update(bytes)
      .digest("hex");
    if (integrityDigest !== entry.worktreeObjectSha256) {
      throw Object.assign(new Error("materialized worktree bytes fail the captured integrity check"), { code: "view_unavailable" });
    }
    const algorithm = entry.worktreeObjectId.length === 40 ? "sha1" : "sha256";
    const actual = createHash(algorithm)
      .update(header)
      .update(bytes)
      .digest("hex");
    if (actual !== entry.worktreeObjectId) {
      throw Object.assign(new Error("materialized worktree bytes do not match the captured object"), { code: "view_unavailable" });
    }
  }

  private async indexBytes(entry: RepositoryManifestEntry, signal: AbortSignal): Promise<Buffer> {
    if (!entry.indexObjectId) throw Object.assign(new Error("index object is unavailable"), { code: "object_unavailable" });
    return this.gitBytes(["cat-file", "blob", entry.indexObjectId], signal);
  }

  private async read(request: Extract<RepositoryOperationRequest, { operation: "read" }>, position: number, signal: AbortSignal) {
    const entry = this.entry(request.path);
    const bytes = request.layer === "worktree" ? await this.worktreeBytes(entry, signal) : await this.indexBytes(entry, signal);
    if (!bufferIsText(bytes)) {
      throw new RepositoryPathPolicyError("path_denied", "binary repository content is unavailable");
    }
    if (request.window.kind === "byte") {
      const start = request.cursor === undefined ? request.window.startByte : position;
      if (start >= bytes.byteLength) {
        return { items: [], next: null, reason: null };
      }
      if (!bufferIsText(bytes.subarray(0, start))) {
        throw Object.assign(new Error("byte window must align to UTF-8 text boundaries"), { code: "request_invalid" });
      }
      let end = Math.min(bytes.byteLength, start + request.window.maxBytes, start + this.options.budgets.maxResponseBytes);
      while (end > start) {
        const returned = bytes.subarray(start, end);
        if (!bufferIsText(returned)) {
          end -= 1;
          continue;
        }
        const item: PendingItem = { path: entry.path, kind: "text", text: scrubSecrets(returned.toString("utf8")), range: { kind: "byte", startByte: start, endByteExclusive: end, encoding: "raw" } };
        const excessBytes = pendingItemBytes(item, 1) - this.options.budgets.maxResponseBytes;
        if (excessBytes <= 0) {
          return {
            items: [item],
            next: end < bytes.byteLength ? end : null,
            reason: end < bytes.byteLength ? "bytes" as const : null,
          };
        }
        end -= Math.max(1, excessBytes);
      }
      throw Object.assign(new Error("one repository byte window item exceeds the response limit"), { code: "response_too_large" });
    }
    if (!bufferIsText(bytes)) throw Object.assign(new Error("line windows require UTF-8 text"), { code: "request_invalid" });
    const lines = linesOf(bytes.toString("utf8"));
    const startIndex = request.cursor === undefined ? request.window.startLine - 1 : position;
    if (startIndex >= lines.length) {
      return { items: [], next: null, reason: null };
    }
    const maximum = Math.min(request.window.maxLines, this.options.budgets.maxItemsPerCall);
    let endIndex = Math.min(lines.length, startIndex + maximum);
    let text = scrubSecrets(lines.slice(startIndex, endIndex).join("\n"));
    let item: PendingItem = { path: entry.path, kind: "text", text, range: { kind: "line", startLine: startIndex + 1, endLineExclusive: endIndex + 1 } };
    while (pendingItemBytes(item, 1) > this.options.budgets.maxResponseBytes && endIndex > startIndex) {
      endIndex -= 1;
      text = scrubSecrets(lines.slice(startIndex, endIndex).join("\n"));
      item = { path: entry.path, kind: "text", text, range: { kind: "line", startLine: startIndex + 1, endLineExclusive: endIndex + 1 } };
    }
    if (endIndex === startIndex) {
      throw Object.assign(new Error("one complete repository line exceeds the response limit"), { code: "response_too_large" });
    }
    const truncated = endIndex < lines.length;
    return {
      items: [item],
      next: truncated ? endIndex : null,
      reason: truncated ? (endIndex - startIndex < maximum ? "bytes" as const : "lines" as const) : null,
    };
  }

  private eligibleEntries(paths: readonly string[], globs: readonly string[]): RepositoryManifestEntry[] {
    const allowedPaths = new Set(paths.map((path) => approveRepositoryPath(path)));
    const matchers = globs.map((glob) => globRegex(approveRepositoryPath(glob, true)));
    return this.descriptor.entries.filter((entry) =>
      !entry.sensitive
      && entry.addressable
      && entry.kind !== "submodule"
      && !repositoryPathDenied(entry.path)
      && (allowedPaths.size === 0 || allowedPaths.has(entry.path))
      && (matchers.length === 0 || matchers.some((matcher) => matcher.test(entry.path))),
    );
  }

  private async search(request: Extract<RepositoryOperationRequest, { operation: "search" }>, position: number, signal: AbortSignal) {
    const entries = this.eligibleEntries(request.paths, request.globs);
    const needle = request.caseSensitive ? request.literal : request.literal.toLocaleLowerCase("en-US");
    const matches: PendingItem[] = [];
    let responseBytes = 0;
    let ordinal = 0;
    for (const [entryIndex, entry] of entries.entries()) {
      if (entryIndex % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      const bytes = await this.worktreeBytes(entry, signal);
      if (!bufferIsText(bytes)) continue;
      const lines = linesOf(bytes.toString("utf8"));
      for (const [index, line] of lines.entries()) {
        if (index % 2_048 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
        const haystack = request.caseSensitive ? line : line.toLocaleLowerCase("en-US");
        if (!haystack.includes(needle)) continue;
        const start = Math.max(0, index - request.contextLines);
        const end = Math.min(lines.length, index + request.contextLines + 1);
        const matchPosition = ordinal++;
        if (matchPosition < position) continue;
        if (matches.length >= this.options.budgets.maxItemsPerCall) {
          return { items: matches, next: matchPosition, reason: "items" as const };
        }
        const item: PendingItem = { path: entry.path, kind: "text", text: scrubSecrets(lines.slice(start, end).join("\n")), metadata: { matchLine: index + 1 }, range: { kind: "line", startLine: start + 1, endLineExclusive: end + 1 } };
        const itemBytes = pendingItemBytes(item, matches.length + 1);
        if (responseBytes + itemBytes > this.options.budgets.maxResponseBytes) {
          if (matches.length === 0) {
            throw Object.assign(new Error("one repository search match exceeds the response limit"), { code: "response_too_large" });
          }
          return { items: matches, next: matchPosition, reason: "bytes" as const };
        }
        matches.push(item);
        responseBytes += itemBytes;
      }
    }
    return { items: matches, next: null, reason: null };
  }

  private async glob(request: Extract<RepositoryOperationRequest, { operation: "glob" }>, position: number, signal: AbortSignal) {
    const matcher = globRegex(approveRepositoryPath(request.pattern, true));
    const items: PendingItem[] = [];
    let ordinal = 0;
    for (const [index, entry] of this.descriptor.entries.entries()) {
      if (index % 2_048 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      if (entry.sensitive || repositoryPathDenied(entry.path) || !matcher.test(entry.path)) continue;
      if (ordinal++ < position) continue;
      items.push({ path: entry.path, kind: "path", metadata: { type: entry.kind, status: entry.status, mode: entry.mode } });
      if (items.length > this.options.budgets.maxItemsPerCall) break;
    }
    return this.positionedPage(items, position, signal);
  }

  private async status(position: number, signal: AbortSignal) {
    const items: PendingItem[] = [];
    let ordinal = 0;
    for (const [index, entry] of this.descriptor.entries.entries()) {
      if (index % 2_048 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      if (entry.sensitive || repositoryPathDenied(entry.path) || entry.status === "clean") continue;
      if (ordinal++ < position) continue;
      items.push({ path: entry.path, kind: "status", metadata: { status: entry.status, type: entry.kind } });
      if (items.length > this.options.budgets.maxItemsPerCall) break;
    }
    return this.positionedPage(items, position, signal);
  }

  private diffRefs(layers: "head:index" | "index:worktree" | "head:worktree" | "source:worktree"): [string, string] {
    switch (layers) {
      case "head:index": return [this.descriptor.headRevision, this.descriptor.indexTree];
      case "index:worktree": return [this.descriptor.indexTree, this.descriptor.worktreeTree];
      case "head:worktree": return [this.descriptor.headRevision, this.descriptor.worktreeTree];
      case "source:worktree": {
        if (!this.descriptor.sourceRevision) throw Object.assign(new Error("source revision is unavailable"), { code: "object_unavailable" });
        return [this.descriptor.sourceRevision, this.descriptor.worktreeTree];
      }
    }
  }

  private async diff(request: Extract<RepositoryOperationRequest, { operation: "git_diff" }>, position: number, signal: AbortSignal) {
    const [from, to] = this.diffRefs(request.layers);
    return this.diffBetween(from, to, request.paths, position, signal);
  }

  private async diffBetween(from: string, to: string, requestedPaths: readonly string[], position: number, signal: AbortSignal) {
    const scoped = requestedPaths.map((path) => approveRepositoryPath(path));
    const names = (await this.git(["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", from, to, "--", ...scoped], signal))
      .split("\0").filter(Boolean);
    const allowed = names.map((path) => approveRepositoryPath(path)).filter((path) => {
      const entry = this.entries.get(path);
      return entry && !entry.sensitive && !repositoryPathDenied(path);
    });
    if (allowed.length !== names.length) throw new RepositoryPathPolicyError("path_denied", "diff contains a protected path");
    const allowset = new Set(allowed);
    const items: PendingItem[] = [];
    let ordinal = 0;
    pathLoop: for (const path of allowed) {
      const patch = await this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", from, to, "--", path], signal);
      assertPatchHeaders(patch, allowset);
      assertPatchIsText(patch);
      for (const hunk of parseDiffHunks(scrubSecrets(patch), path)) {
        if (ordinal++ < position) continue;
        items.push(hunk);
        if (items.length > this.options.budgets.maxItemsPerCall) break pathLoop;
      }
    }
    return this.positionedPage(items, position, signal);
  }

  private revision(revision: string): { id: string; parents: string[] } {
    validateRevisionId(revision);
    const record = this.descriptor.retainedRevisions.find((item) => item.id === revision);
    if (!record) throw Object.assign(new Error("revision is outside the retained history"), { code: "revision_out_of_range" });
    return record;
  }

  private async show(request: Extract<RepositoryOperationRequest, { operation: "git_show" }>, position: number, signal: AbortSignal) {
    const revision = this.revision(request.revision);
    if (!request.patch) {
      const metadata = scrubSecrets(await this.git(["show", "-s", "--format=%H%n%P%n%an%n%ae%n%aI%n%B", revision.id], signal));
      return this.paginate([{ kind: "commit", text: metadata, metadata: { revision: revision.id } }], position);
    }
    let parent: string;
    if (revision.parents.length === 0) parent = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    else if (this.retained.has(revision.parents[0]!)) parent = revision.parents[0]!;
    else throw Object.assign(new Error("the first parent is outside retained history"), { code: "history_boundary" });
    return this.diffBetween(parent.trim(), revision.id, request.paths, position, signal);
  }

  private async log(request: Extract<RepositoryOperationRequest, { operation: "git_log" }>, position: number, signal: AbortSignal) {
    const path = request.path ? this.entry(request.path).path : null;
    const start = request.revision ? this.descriptor.retainedRevisions.findIndex((item) => item.id === request.revision) : 0;
    if (request.revision && start < 0) throw Object.assign(new Error("revision is outside the retained history"), { code: "revision_out_of_range" });
    const revisions = this.descriptor.retainedRevisions.slice(Math.max(0, start), Math.max(0, start) + request.limit);
    const items: PendingItem[] = [];
    for (const revision of revisions) {
      if (path) {
        const firstParent = revision.parents[0];
        if (firstParent && !this.retained.has(firstParent)) break;
        const changed = firstParent
          ? await this.git(["diff", "--name-only", "--no-ext-diff", "--no-textconv", firstParent, revision.id, "--", path], signal)
          : await this.git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", revision.id, "--", path], signal);
        if (!changed.trim()) continue;
      }
      const text = scrubSecrets(await this.git(["show", "-s", "--format=%H%x00%P%x00%aI%x00%an%x00%s", revision.id], signal));
      items.push({ kind: "commit", text, metadata: { revision: revision.id } });
    }
    const page = this.paginate(items, position);
    return { ...page, history: this.descriptor.omittedParents.length > 0 };
  }

  private async blame(request: Extract<RepositoryOperationRequest, { operation: "git_blame" }>, position: number, signal: AbortSignal) {
    this.revision(request.revision);
    const entry = this.entry(request.path);
    if (entry.kind !== "file") throw Object.assign(new Error("blame requires a regular file"), { code: "request_invalid" });
    if (request.startLine === request.endLineExclusive) return this.paginate([], position);
    const endInclusive = request.endLineExclusive - 1;
    const text = await this.git(["blame", "--porcelain", "--root", `-L${request.startLine},${endInclusive}`, request.revision, "--", entry.path], signal);
    const revisionFields = /^([0-9a-f]{40,64})(?= )|^previous ([0-9a-f]{40,64})(?= )/gm;
    const returnedRevisions = [...text.matchAll(revisionFields)].map((match) => (match[1] ?? match[2])!);
    const historyTruncated = returnedRevisions.some((revision) => !this.retained.has(revision));
    const redactedRevisions = text.replace(
      revisionFields,
      (field, headerRevision: string | undefined, previousRevision: string | undefined) => {
        const revision = (headerRevision ?? previousRevision)!;
        if (this.retained.has(revision)) return field;
        const redacted = "0".repeat(revision.length);
        return previousRevision ? `previous ${redacted}` : redacted;
      },
    );
    // The returned item already carries the approved canonical path. Historical porcelain
    // path fields can name protected or non-addressable pre-rename paths, so omit them rather
    // than attempting to decode Git's quoted-path grammar into the public text payload.
    const safe = scrubSecrets(redactedRevisions.replace(/^(?:filename|previous) .*(?:\n|$)/gm, ""));
    return this.paginate([{ path: entry.path, kind: "blame", text: safe, metadata: { historyTruncated }, range: { kind: "line", startLine: request.startLine, endLineExclusive: request.endLineExclusive } }], position);
  }

  private paginate(items: PendingItem[], position: number, signal?: AbortSignal) {
    const selected: PendingItem[] = [];
    let bytes = 0;
    let index = position;
    while (index < items.length && selected.length < this.options.budgets.maxItemsPerCall) {
      if (signal?.aborted) throw Object.assign(new Error("repository request cancelled"), { code: "cancelled" });
      const item = items[index]!;
      const size = pendingItemBytes(item, selected.length + 1);
      if (selected.length > 0 && bytes + size > this.options.budgets.maxResponseBytes) break;
      if (size > this.options.budgets.maxResponseBytes) throw Object.assign(new Error("one repository item exceeds the response limit"), { code: "response_too_large" });
      selected.push(item);
      bytes += size;
      index += 1;
    }
    const truncated = index < items.length;
    return { items: selected, next: truncated ? index : null, reason: truncated ? (selected.length >= this.options.budgets.maxItemsPerCall ? "items" as const : "bytes" as const) : null };
  }

  private positionedPage(items: PendingItem[], position: number, signal?: AbortSignal) {
    const page = this.paginate(items, 0, signal);
    return { ...page, next: page.next === null ? null : position + page.next };
  }

  private async git(args: readonly string[], signal: AbortSignal): Promise<string> {
    const { stdout } = await execFileAsync("git", [...GIT_CONFIG, ...args], {
      cwd: this.descriptor.repositoryRoot,
      encoding: "utf8",
      maxBuffer: this.options.budgets.maxResponseBytes * 4,
      signal,
      env: this.gitEnv(),
    });
    return stdout;
  }

  private gitBytes(args: readonly string[], signal: AbortSignal): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      execFile("git", [...GIT_CONFIG, ...args], {
        cwd: this.descriptor.repositoryRoot,
        encoding: "buffer",
        maxBuffer: this.options.budgets.maxResponseBytes * 4,
        signal,
        env: this.gitEnv(),
      }, (error, stdout) => {
        if (error) reject(Object.assign(new Error("Git object is unavailable"), { code: "object_unavailable", cause: error }));
        else resolve(stdout);
      });
    });
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_PAGER: "cat",
      GIT_OBJECT_DIRECTORY: this.descriptor.objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
      LC_ALL: "C",
    };
  }

  private cursor(operation: RepositoryOperationId, inputHash: string, position: number): string {
    const payload = Buffer.from(JSON.stringify({ version: 1, snapshotDigest: this.descriptor.snapshotDigest, policyVersion: 1, operation, inputHash, position })).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private readCursor(cursor: string, operation: RepositoryOperationId, inputHash: string): number {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra) throw Object.assign(new Error("continuation cursor is malformed"), { code: "cursor_invalid" });
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (
      received.toString("base64url") !== signature
      || expected.byteLength !== received.byteLength
      || !timingSafeEqual(expected, received)
    ) {
      throw Object.assign(new Error("continuation cursor signature is invalid"), { code: "cursor_invalid" });
    }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
    catch { throw Object.assign(new Error("continuation cursor payload is invalid"), { code: "cursor_invalid" }); }
    const metadata = RepositoryCursorMetadataSchema.safeParse(decoded);
    if (!metadata.success || metadata.data.snapshotDigest !== this.descriptor.snapshotDigest || metadata.data.operation !== operation || metadata.data.inputHash !== inputHash) {
      throw Object.assign(new Error("continuation cursor does not match this request"), { code: "cursor_invalid" });
    }
    return metadata.data.position;
  }

  private async finishSuccess(request: RepositoryOperationRequest, operationInstanceId: string, inputHash: string, pending: { items: PendingItem[]; next: number | null; reason: RepositoryOperationResult["truncationReason"]; history?: boolean }, startedAt: number, signal: AbortSignal): Promise<RepositoryOperationResult> {
    const truncated = pending.next !== null;
    const handles: RepositoryEvidenceHandleMetadata[] = [];
    const items = pending.items.map((item, index) => {
      const ordinal = index + 1;
      if (!item.path || !item.range) return { ...item, ordinal, metadata: item.metadata ?? {} };
      const handleId = `reh_${randomBytes(24).toString("base64url")}` as RepositoryEvidenceHandleMetadata["handleId"];
      handles.push({ handleId, snapshotDigest: this.descriptor.snapshotDigest, workloadId: this.options.identity.workloadId, workflowAttemptId: this.options.identity.workflowAttemptId, operationInstanceId, operation: request.operation, itemOrdinal: ordinal, path: item.path, policyVersion: 1, truncated, range: item.range });
      return { ...item, ordinal, metadata: item.metadata ?? {}, evidenceHandleId: handleId };
    });
    const byteCount = resultBytes(items);
    if (byteCount > this.options.budgets.maxResponseBytes) {
      return this.finishFailure(request.operation, operationInstanceId, "unavailable", "response_too_large", "repository response exceeds the byte limit", startedAt, inputHash);
    }
    if (this.usage.bytes + byteCount > this.options.budgets.maxAttemptBytes) {
      return this.finishFailure(request.operation, operationInstanceId, "unavailable", "budget_exhausted", "repository byte budget exhausted", startedAt, inputHash);
    }
    // Reserve synchronously before the audit await so concurrent calls observe one
    // cumulative attempt budget. Audit failure remains fail-closed and consumes the
    // reservation rather than making already-refused concurrent work retroactively safe.
    this.usage.bytes += byteCount;
    const audit: RepositoryQueryAuditMetadata = { operationInstanceId, operation: request.operation, normalizedInputHash: inputHash, status: "ok", failureCode: null, byteCount, itemCount: items.length, truncated, durationMs: Math.max(0, this.now() - startedAt), handles };
    try { await this.options.audit.append(audit, signal); }
    catch (error) {
      if (signal.aborted) throw error;
      return this.finishFailure(request.operation, operationInstanceId, "unavailable", "audit_unavailable", "repository audit sink is unavailable", startedAt, inputHash, false);
    }
    if (signal.aborted || this.now() - this.usage.startedAt >= this.options.budgets.maxAttemptMs) {
      throw Object.assign(new Error("repository call deadline exceeded"), {
        code: "deadline_exceeded",
        [REPOSITORY_AUDIT_COMMITTED]: true,
      });
    }
    return RepositoryOperationResultSchema.parse({ operation: request.operation, operationInstanceId, status: "ok", code: null, message: null, items, byteCount, itemCount: items.length, truncated, truncationReason: pending.reason, continuationCursor: pending.next === null ? null : this.cursor(request.operation, inputHash, pending.next), historyBoundary: pending.history ? { truncated: this.descriptor.omittedParents.length > 0, frontier: this.descriptor.frontier, omittedParents: this.descriptor.omittedParents } : null });
  }

  private async finishFailure(operation: RepositoryOperationId, operationInstanceId: string, status: Exclude<RepositoryOperationResult["status"], "ok">, code: RepositoryFailureCode, message: string, startedAt: number, inputHash = sha256("invalid"), audit = true): Promise<RepositoryOperationResult> {
    if (audit) {
      const metadata: RepositoryQueryAuditMetadata = { operationInstanceId, operation, normalizedInputHash: inputHash, status, failureCode: code, byteCount: 0, itemCount: 0, truncated: false, durationMs: Math.max(0, this.now() - startedAt), handles: [] };
      const remainingAttemptMs = this.options.budgets.maxAttemptMs - (this.now() - this.usage.startedAt);
      if (remainingAttemptMs > 0) {
        const auditSignal = AbortSignal.timeout(Math.min(this.options.budgets.maxCallMs, remainingAttemptMs));
        try { await settleBeforeAbort(this.options.audit.append(metadata, auditSignal), auditSignal); }
        catch { code = "audit_unavailable"; message = "repository audit sink is unavailable"; status = "unavailable"; }
      }
    }
    return RepositoryOperationResultSchema.parse({ operation, operationInstanceId, status, code, message, items: [], byteCount: 0, itemCount: 0, truncated: false, truncationReason: null, continuationCursor: null, historyBoundary: code === "history_boundary" ? { truncated: true, frontier: this.descriptor.frontier, omittedParents: this.descriptor.omittedParents } : null });
  }

  private failureOf(error: unknown, callerSignal: AbortSignal, deadlineSignal?: AbortSignal): { status: Exclude<RepositoryOperationResult["status"], "ok">; code: RepositoryFailureCode; message: string } {
    if (callerSignal.aborted) return { status: "cancelled", code: "cancelled", message: "repository request cancelled" };
    if (deadlineSignal?.aborted) return { status: "cancelled", code: "deadline_exceeded", message: "repository call deadline exceeded" };
    if (error instanceof RepositoryPathPolicyError) return { status: error.code === "path_denied" ? "denied" : "invalid", code: error.code, message: error.message };
    const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
    const rawCode = typeof candidate.code === "string" ? candidate.code : "internal";
    if (rawCode === "ABORT_ERR" || candidate.name === "TimeoutError") return { status: "cancelled", code: "deadline_exceeded", message: "repository call deadline exceeded" };
    const message = typeof candidate.message === "string" ? candidate.message.slice(0, 1_000) : "repository operation failed";
    switch (rawCode) {
      case "path_denied": return { status: "denied", code: rawCode, message };
      case "path_invalid":
      case "request_invalid":
      case "cursor_invalid": return { status: "invalid", code: rawCode, message };
      case "cancelled":
      case "deadline_exceeded": return { status: "cancelled", code: rawCode, message };
      case "budget_exhausted":
      case "response_too_large":
      case "revision_out_of_range":
      case "history_boundary":
      case "object_unavailable":
      case "audit_unavailable":
      case "view_unavailable":
      case "provider_unavailable": return { status: "unavailable", code: rawCode, message };
      case "provider_protocol":
      case "internal": return { status: "failed", code: rawCode, message };
      default: return { status: "failed", code: "internal", message };
    }
  }
}
