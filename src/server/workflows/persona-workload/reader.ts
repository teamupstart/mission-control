import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  RepositoryOperationSchemas,
  RepositoryViewDescriptorSchema,
  RepositoryBudgetsSchema,
  RepositoryCursorMetadataSchema,
  RepositoryQueryAuditMetadataSchema,
  type RepositoryOperation,
  type RepositoryViewDescriptor,
  type RepositoryResult,
  type RepositoryQueryAuditMetadata,
  type RepositoryEvidenceHandle,
} from "@shared/repository-access.ts";
import {
  approvedPath,
  matchesGlob,
  scrubRepositoryText as scrubSecrets,
} from "./policy.ts";
import { repositoryGit } from "./git.ts";
import type { z } from "zod";

type Code = NonNullable<RepositoryResult["code"]>;
class Refusal extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true });
type Item = RepositoryResult["items"][number] & {
  range?: RepositoryEvidenceHandle["range"];
};
// Search resumes at a worktree entry and line; log resumes at a retained revision.
interface ScanPosition {
  index: number;
  position: number;
}

function worktreeDeletion(entry: RepositoryViewDescriptor["worktree"][number]): boolean {
  return entry.kind === "file" && entry.blob === null && entry.classifications.includes("deleted");
}

export interface RepositoryReaderOptions {
  view: RepositoryViewDescriptor;
  objectDirectory: string;
  gitBinary: string;
  workloadId: string;
  attemptId: string;
  budgets: z.input<typeof RepositoryBudgetsSchema>;
  signal: AbortSignal;
  audit: (metadata: RepositoryQueryAuditMetadata) => Promise<void>;
}

/** A single attempt owns its budgets, cursor key and operation/evidence identities. */
export function createRepositoryReader(options: RepositoryReaderOptions) {
  const view = RepositoryViewDescriptorSchema.parse(options.view);
  const statusEntries = view.statusDeletions?.length
    ? [...view.worktree, ...view.statusDeletions.map(entry => ({ ...entry, kind: null, binary: null }))]
    : [...view.worktree];
  // A staged, assume-unchanged path may be absent on disk. Its index change
  // remains visible in status without manufacturing a readable worktree file.
  const listed = new Set(statusEntries.map(entry => entry.path));
  for (const entry of view.index) {
    if (!listed.has(entry.path) && entry.classifications.includes("staged") && !entry.classifications.includes("deleted"))
      statusEntries.push({ ...entry, kind: null, binary: null });
  }
  const budgets = RepositoryBudgetsSchema.parse(options.budgets);
  const secret = randomBytes(32);
  const started = Date.now();
  let calls = 0;
  let bytesServed = 0;
  let auditBroken = false;
  let tail: Promise<unknown> = Promise.resolve();
  const git = async (args: string[], signal: AbortSignal): Promise<Buffer> => {
    try {
      return await repositoryGit(
        options.gitBinary,
        options.objectDirectory,
        args,
        signal,
        budgets.callMs,
        Math.max(budgets.callBytes, 1048576),
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      )
        throw new Refusal("budget_exhausted");
      if (signal.aborted)
        throw new Refusal(
          signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
            ? "timeout"
            : "cancelled",
        );
      throw new Refusal("unavailable");
    }
  };
  const allow = (path: string): void => {
    if (!approvedPath(path)) throw new Refusal("denied_path");
  };
  const retained = (
    revision: string,
  ): NonNullable<(typeof view.retainedRevisions)[number]> => {
    const value = revision === "HEAD" ? view.head : revision;
    const record = view.retainedRevisions.find((r) => r.id === value);
    if (!record) throw new Refusal("revision_out_of_range");
    return record;
  };
  const blob = async (id: string, signal: AbortSignal): Promise<Buffer> =>
    git(["cat-file", "blob", id], signal);
  const treeEntry = async (tree: string, path: string, signal: AbortSignal) => {
    allow(path);
    const output = await git(["ls-tree", "-z", tree, "--", path], signal);
    if (!output.length) return null;
    const record = decoder.decode(output).split("\0").filter(Boolean);
    if (record.length !== 1) throw new Refusal("unavailable");
    const match =
      /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64})\t(.+)$/.exec(
        record[0]!,
      );
    if (!match || match[4] !== path) throw new Refusal("unavailable");
    return {
      id: match[3]!,
      symlink: match[1] === "120000",
      submodule: match[1] === "160000",
      mode: match[1]!,
    };
  };
  const scanBlob = async (id: string, signal: AbortSignal): Promise<{ text: string; kind?: undefined } | { kind: "binary" | "oversized" }> => {
    let data: Buffer;
    try {
      data = await blob(id, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Refusal && error.code === "budget_exhausted")
        return { kind: "oversized" };
      throw error;
    }
    if (data.includes(0)) return { kind: "binary" };
    let text: string;
    try {
      text = decoder.decode(data);
    } catch {
      return { kind: "binary" };
    }
    return { text: scrubSecrets(text) };
  };
  const metadata = async (
    revision: string,
    signal: AbortSignal,
  ): Promise<Item> => {
    const text = decoder.decode(
      await git(["cat-file", "commit", revision], signal),
    );
    const separator = text.indexOf("\n\n");
    if (separator < 0) throw new Refusal("unavailable");
    const headers = text.slice(0, separator).split("\n");
    const record = retained(revision),
      tree = headers.find((line) => line.startsWith("tree "))?.slice(5);
    const parents = headers
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice(7));
    if (
      tree !== record.tree ||
      JSON.stringify(parents) !== JSON.stringify(record.parents)
    )
      throw new Refusal("unavailable");
    return {
      metadata: {
        revision,
        tree,
        parents,
        message: scrubSecrets(text.slice(separator + 2)),
      },
    };
  };
  async function* diff(
    before: string | null,
    after: string,
    signal: AbortSignal,
    scope?: string[],
  ): AsyncGenerator<Item> {
    for (const path of scope ?? []) allow(path);
    // Names only first: denied blobs are never requested by a content command.
    const raw = await git(
      before
        ? [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            "-z",
            before,
            after,
            "--",
          ]
        : ["ls-tree", "-r", "--name-only", "-z", after, "--"],
      signal,
    );
    const paths = decoder
      .decode(raw)
      .split("\0")
      .filter(Boolean)
      .filter((p) => approvedPath(p) && (!scope || scope.includes(p)));
    for (const path of paths) {
      signal.throwIfAborted();
      const [a, b] = await Promise.all([
        before ? treeEntry(before, path, signal) : null,
        treeEntry(after, path, signal),
      ]);
      if (a?.submodule || b?.submodule) {
        yield {
          path,
          metadata: {
            kind: "submodule",
            oldObject: a?.id ?? null,
            newObject: b?.id ?? null,
          },
        };
        continue;
      }
      const left = a ? await scanBlob(a.id, signal) : { text: "" };
      const right = b ? await scanBlob(b.id, signal) : { text: "" };
      if (left.kind || right.kind) {
        yield {
          path,
          metadata: {
            kind: left.kind ?? right.kind!,
            oldObject: a?.id ?? null,
            newObject: b?.id ?? null,
          },
        };
        continue;
      }
      // Bounded full-file replacement hunks avoid configurable Git content drivers.
      const old = left.text, next = right.text;
      const lines = (text: string) =>
        text.length ? text.replace(/\n$/, "").split("\n") : [];
      const oldLines = lines(old),
        newLines = lines(next);
      if (!oldLines.length && !newLines.length) {
        yield {
          path,
          metadata: { oldMode: a?.mode ?? null, newMode: b?.mode ?? null },
        };
        continue;
      }
      for (
        let offset = 0;
        offset < Math.max(oldLines.length, newLines.length);
        offset += 32
      ) {
        const oldStart = Math.min(offset, oldLines.length),
          newStart = Math.min(offset, newLines.length);
        const removed = oldLines.slice(offset, offset + 32),
          added = newLines.slice(offset, offset + 32);
        const render = (
          parts: string[],
          prefix: string,
          start: number,
          all: string[],
          text: string,
        ) =>
          parts
            .map(
              (line, index) =>
                prefix +
                line +
                "\n" +
                (start + index === all.length - 1 && !text.endsWith("\n")
                  ? "\\ No newline at end of file\n"
                  : ""),
            )
            .join("");
        const patch =
          `--- ${a ? "a/" + path : "/dev/null"}\n+++ ${b ? "b/" + path : "/dev/null"}\n@@ -${removed.length ? oldStart + 1 : oldStart},${removed.length} +${added.length ? newStart + 1 : newStart},${added.length} @@\n` +
          render(removed, "-", oldStart, oldLines, old) +
          render(added, "+", newStart, newLines, next);
        yield {
          path,
          text: patch,
          metadata: { oldMode: a?.mode ?? null, newMode: b?.mode ?? null },
          range: {
            kind: "diff",
            oldStartLine: oldStart + 1,
            oldEndLineExclusive: oldStart + removed.length + 1,
            newStartLine: newStart + 1,
            newEndLineExclusive: newStart + added.length + 1,
          },
        };
      }
    }
  }
  async function* collect(
    operation: RepositoryOperation,
    input: unknown,
    signal: AbortSignal,
    scan: ScanPosition,
  ): AsyncGenerator<Item> {
    switch (operation) {
      case "read": {
        const r = RepositoryOperationSchemas.read.parse(input);
        allow(r.path);
        const e = view[r.layer].find((e) => e.path === r.path);
        if (r.layer === "worktree" && r.verifyAbsence && (!e || worktreeDeletion(e))) {
          // A captured deletion can have a status entry with no blob. A replacement
          // directory or an opaque ancestor prevents an absence proof.
          const obscured = view.worktree.some(entry => (entry.path.startsWith(r.path + "/") && !worktreeDeletion(entry))
            || (entry.kind !== "file" && r.path.startsWith(entry.path + "/")));
          if (!obscured) {
            yield { path: r.path, metadata: { absent: true } };
            return;
          }
        }
        if (!e || !e.blob) throw new Refusal("unavailable");
        if (e.kind === "submodule") throw new Refusal("denied_path");
        const data = await blob(e.blob, signal);
        if (r.unit === "byte") {
          // Scrub the complete text before selecting a byte window, preventing split-token leaks.
          if (data.includes(0)) throw new Refusal("unavailable");
          const original = decoder.decode(data);
          const scrubbed = scrubSecrets(original);
          if (scrubbed !== original) throw new Refusal("denied_path");
          const end = Math.min(data.length, r.start + r.length);
          if (end <= r.start) return;
          for (let start = r.start; start < end; start += 768) {
            const stop = Math.min(end, start + 768);
            yield {
              path: r.path,
              text: data.subarray(start, stop).toString("base64"),
              metadata: { encoding: "base64" },
              range: {
                kind: "byte",
                startByte: start,
                endByteExclusive: stop,
                encoding: "raw",
              },
            };
          }
          return;
        }
        if (data.includes(0)) throw new Refusal("unavailable");
        const lines = scrubSecrets(decoder.decode(data)).split("\n");
        if (lines.at(-1) === "") lines.pop();
        yield* lines.slice(r.start, r.start + r.length).map(
          (line, i): Item => ({
            path: r.path,
            text: line,
            range: {
              kind: "line",
              startLine: r.start + i + 1,
              endLineExclusive: r.start + i + 2,
            },
          }),
        );
        return;
      }
      case "glob":
      case "git_status": {
        const r = RepositoryOperationSchemas[operation].parse(input);
        allow(r.glob);
        let scanned = 0;
        for (const e of operation === "git_status" ? statusEntries : view.worktree) {
          if (++scanned % 64 === 0)
            await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
          if (approvedPath(e.path) && matchesGlob(e.path, r.glob))
            yield {
              path: e.path,
              metadata: {
                kind: e.kind,
                binary: e.binary,
                classifications: e.classifications,
              },
            };
        }
        return;
      }
      case "search": {
        const r = RepositoryOperationSchemas.search.parse(input);
        allow(r.glob);
        const needle = r.caseSensitive ? r.query : r.query.toLowerCase();
        for (; scan.index < view.worktree.length; scan.index++, scan.position = 0) {
          const e = view.worktree[scan.index]!;
          if (scan.index % 64 === 0)
            await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
          if (
            !approvedPath(e.path) ||
            !matchesGlob(e.path, r.glob) ||
            e.kind !== "file" ||
            e.binary ||
            !e.blob
          )
            continue;
          const content = await scanBlob(e.blob, signal);
          if (content.kind) continue;
          const lines = content.text.split("\n");
          if (lines.at(-1) === "") lines.pop();
          for (; scan.position < lines.length; scan.position++) {
            const i = scan.position;
            if (i && i % 4096 === 0) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              signal.throwIfAborted();
            }
            if ((r.caseSensitive ? lines[i]! : lines[i]!.toLowerCase()).includes(needle)) {
              const start = Math.max(0, i - r.context),
                end = Math.min(lines.length, i + r.context + 1);
              yield {
                path: e.path,
                text: lines.slice(start, end).join("\n"),
                range: {
                  kind: "line",
                  startLine: start + 1,
                  endLineExclusive: end + 1,
                },
              };
            }
          }
        }
        return;
      }
      case "git_diff": {
        const r = RepositoryOperationSchemas.git_diff.parse(input);
        const pairs = {
          base_head: [view.base, view.head],
          head_index: [view.head, view.indexTree],
          index_worktree: [view.indexTree, view.worktreeDiffTree ?? view.worktreeTree],
          base_worktree: [view.base, view.worktreeDiffTree ?? view.worktreeTree],
        } as const;
        const [a, b] = pairs[r.pair];
        if (!b) throw new Refusal("unavailable");
        yield* diff(a, b, signal, r.paths);
        return;
      }
      case "git_show": {
        const r = RepositoryOperationSchemas.git_show.parse(input),
          rev = retained(r.revision);
        if (!r.patch) {
          yield await metadata(rev.id, signal);
          return;
        }
        const parent = rev.parents[0];
        if (parent && !view.retainedRevisions.some((x) => x.id === parent))
          throw new Refusal("history_boundary");
        yield await metadata(rev.id, signal);
        yield* diff(parent ?? null, rev.id, signal);
        return;
      }
      case "git_log": {
        const r = RepositoryOperationSchemas.git_log.parse(input);
        if (r.path) allow(r.path);
        const root = retained(r.revision);
        const reachable = new Set<string>();
        const todo = [root.id];
        while (todo.length) {
          const id = todo.shift()!;
          if (reachable.has(id)) continue;
          const rev = view.retainedRevisions.find((x) => x.id === id);
          if (!rev) continue;
          reachable.add(id);
          todo.push(...rev.parents);
        }
        for (; scan.index < view.retainedRevisions.length; scan.index++) {
          signal.throwIfAborted();
          const rev = view.retainedRevisions[scan.index]!;
          if (!reachable.has(rev.id)) continue;
          if (r.path) {
            const current = await treeEntry(rev.tree, r.path, signal);
            const parents = rev.parents.filter((id) =>
              view.retainedRevisions.some((p) => p.id === id),
            );
            // A boundary is still returned as unknown prior history, never treated as an empty root.
            if (!rev.parents.length && !current) continue;
            if (parents.length === rev.parents.length && parents.length) {
              const entries = await Promise.all(
                parents.map((id) =>
                  treeEntry(retained(id).tree, r.path!, signal),
                ),
              );
              if (entries.every((entry) => entry?.id === current?.id)) continue;
            }
          }
          yield await metadata(rev.id, signal);
        }
        return;
      }
      case "git_blame": {
        const r = RepositoryOperationSchemas.git_blame.parse(input);
        allow(r.path);
        const rev = retained(r.revision);
        const entry = await treeEntry(rev.tree, r.path, signal);
        if (!entry || entry.symlink || entry.submodule)
          throw new Refusal("unavailable");
        // A non-complete ancestry requires a shallow view supplied by the artifact owner.
        // Never let Git walk an omitted parent or fetch a missing object.
        if (view.frontier.length) {
          const shallow = (
            await readFile(join(options.objectDirectory, "shallow"), "utf8")
          )
            .trim()
            .split("\n")
            .sort();
          if (
            JSON.stringify(shallow) !==
            JSON.stringify(view.frontier.map((f) => f.revision).sort())
          )
            throw new Refusal("unavailable");
        }
        const output = decoder.decode(
          await git(
            [
              "blame",
              "--boundary",
              "--line-porcelain",
              "--no-textconv",
              "--no-follow",
              "--ignore-revs-file",
              "",
              "-L",
              `${r.startLine},${r.endLineExclusive - 1}`,
              rev.id,
              "--",
              r.path,
            ],
            signal,
          ),
        );
        const porcelainPath = (value: string): string => {
          let path: unknown = value;
          try {
            if (value.startsWith('"')) path = JSON.parse(value);
          } catch {
            throw new Refusal("denied_path");
          }
          if (typeof path !== "string") throw new Refusal("denied_path");
          allow(path);
          return path;
        };
        for (const line of output.split("\n")) {
          if (line.startsWith("filename ")) {
            const p = porcelainPath(line.slice(9));
            if (p !== r.path) throw new Refusal("denied_path");
            allow(p);
          }
          if (line.startsWith("previous ")) {
            porcelainPath(line.split(" ").slice(2).join(" "));
            retained(line.split(" ")[1]!);
          }
          const commit = /^([a-f0-9]{40,64}) \d+ \d+/.exec(line);
          if (commit && !view.retainedRevisions.some((x) => x.id === commit[1]))
            throw new Refusal("revision_out_of_range");
        }
        // Emit one actual attributed line per item; Git can clamp a requested end at EOF.
        const blocks =
          output.match(
            /[a-f0-9]{40,64} \d+ \d+(?: \d+)?\n(?:[^\t][^\n]*\n)*\t[^\n]*(?:\n|$)/g,
          ) ?? [];
        for (const block of blocks) {
          const line = Number(block.split("\n", 1)[0]!.split(" ")[2]);
          if (line < r.startLine || line >= r.endLineExclusive)
            throw new Refusal("unavailable");
          yield {
            path: r.path,
            text: scrubSecrets(block),
            range: {
              kind: "line",
              startLine: line,
              endLineExclusive: line + 1,
            },
          };
        }
        if (!blocks.length) throw new Refusal("unavailable");
        return;
      }
    }
  }
  async function execute(
    operation: RepositoryOperation,
    input: unknown,
    callSignal?: AbortSignal,
  ): Promise<RepositoryResult> {
    const begin = Date.now(),
      operationId = randomUUID();
    const result: RepositoryResult = {
      operationId,
      operation,
      status: "ok",
      code: null,
      bytes: 0,
      itemCount: 0,
      truncated: false,
      limit: null,
      nextCursor: null,
      historyTruncated: view.frontier.length > 0,
      items: [],
    };
    // Queued callers may outlive the final admitted call. They get no repository
    // result and no journal slot. Every admitted call, even a cancellation, uses one.
    if (auditBroken || calls >= budgets.attemptCalls)
      return {
        ...result,
        status: "failed",
        code: auditBroken ? "audit_unavailable" : "budget_exhausted",
      };
    calls++;
    let inputHash = hash(null);
    let readLayer: "worktree" | "index" | undefined;
    const handles: RepositoryEvidenceHandle[] = [];
    try {
      if (options.signal.aborted || callSignal?.aborted)
        throw new Refusal("cancelled");
      if (
        Date.now() - started >= budgets.attemptMs ||
        bytesServed + 2048 > budgets.attemptBytes
      )
        throw new Refusal("budget_exhausted");
      const parsed = RepositoryOperationSchemas[operation].safeParse(input);
      if (!parsed.success) throw new Refusal("invalid_request");
      const { cursor, ...shape } = parsed.data;
      if (operation === "read" && "layer" in shape) readLayer = shape.layer;
      inputHash = hash(shape);
      let offset = 0, scanIndex = 0;
      if (cursor) {
        try {
          if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
          const [body, signature] = cursor.split(".");
          if (!body || !signature) throw Error();
          const expected = createHmac("sha256", secret).update(body).digest();
          const got = Buffer.from(signature, "base64url");
          if (got.toString("base64url") !== signature) throw Error();
          if (got.length !== expected.length || !timingSafeEqual(expected, got))
            throw Error();
          const c = RepositoryCursorMetadataSchema.parse(
            JSON.parse(Buffer.from(body, "base64url").toString()),
          );
          if (
            c.snapshotDigest !== view.snapshotDigest ||
            c.operation !== operation ||
            c.inputHash !== inputHash
          )
            throw Error();
          offset = c.position;
          scanIndex = c.scanIndex ?? 0;
        } catch {
          throw new Refusal("invalid_cursor");
        }
      }
      const timeout = AbortSignal.timeout(Math.max(0, Math.min(
        budgets.callMs, budgets.attemptMs - (Date.now() - started),
      )));
      const signal = AbortSignal.any([
        options.signal,
        ...(callSignal ? [callSignal] : []),
        timeout,
      ]);
      let position = 0;
      const scanning = operation === "search" || operation === "git_log";
      const scan = { index: scanIndex, position: offset };
      try {
        for await (const candidate of collect(operation, shape, signal, scan)) {
          if (position % 64 === 0)
            await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
          if (!scanning && position < offset) {
            position++;
            continue;
          }
          const { range, ...item } = candidate;
          const evidenceHandleId = range && item.path ? randomUUID() : undefined;
          if (evidenceHandleId) item.evidenceHandleId = evidenceHandleId;
          const size = Buffer.byteLength(JSON.stringify(item));
          if (result.items.length >= budgets.callItems) {
            result.limit = "items";
            break;
          }
          if (
            result.bytes + size >
            Math.min(budgets.callBytes, budgets.attemptBytes - bytesServed) - 2048
          ) {
            result.limit = "bytes";
            break;
          }
          result.bytes += size;
          if (range && item.path && evidenceHandleId) {
            handles.push({
              evidenceHandleId,
              snapshotDigest: view.snapshotDigest,
              workloadId: options.workloadId,
              attemptId: options.attemptId,
              operationId,
              operation,
              itemOrdinal: result.items.length,
              path: item.path,
              policyVersion: 1,
              truncated: false,
              range,
            });
          }
          result.items.push(item);
          position++;
        }
      } catch (error) {
        if (!scanning || !timeout.aborted || options.signal.aborted || callSignal?.aborted ||
            Date.now() - started >= budgets.attemptMs ||
            (scan.index === scanIndex && scan.position === offset))
          throw error;
        // Only a call timeout is resumable. Repository errors and cancellations fail closed.
        if (error !== timeout.reason && !(error instanceof Refusal && error.code === "timeout"))
          throw error;
        result.limit = "time";
      }
      if (result.limit) {
        if (result.limit !== "time" && !result.items.length) throw new Refusal("budget_exhausted");
        result.truncated = true;
        for (const h of handles) h.truncated = true;
        const body = Buffer.from(
          JSON.stringify({
            version: 1,
            snapshotDigest: view.snapshotDigest,
            operation,
            inputHash,
            policyVersion: 1,
            position: scanning ? scan.position : position,
            ...(scanning ? { scanIndex: scan.index } : {}),
          }),
        ).toString("base64url");
        result.nextCursor =
          body +
          "." +
          createHmac("sha256", secret).update(body).digest("base64url");
      }
      result.itemCount = result.items.length;
      // Count the serialized result, including handles, cursor and framing. The loop reserves
      // 2 KiB for that framing before accepting another item.
      let measured = Buffer.byteLength(JSON.stringify(result));
      while (measured !== result.bytes) {
        result.bytes = measured;
        measured = Buffer.byteLength(JSON.stringify(result));
      }
      bytesServed += result.bytes;
    } catch (error) {
      const code =
        error instanceof Refusal
          ? error.code
          : options.signal.aborted || callSignal?.aborted
            ? "cancelled"
            : error instanceof DOMException && error.name === "TimeoutError"
              ? "timeout"
              : "unavailable";
      Object.assign(result, {
        status:
          code === "cancelled"
            ? "cancelled"
            : [
                  "denied_path",
                  "revision_out_of_range",
                  "invalid_request",
                  "invalid_cursor",
                ].includes(code)
              ? "denied"
              : "failed",
        code,
        items: [],
        bytes: 0,
        itemCount: 0,
        truncated: false,
        limit: null,
        nextCursor: null,
      });
      handles.length = 0;
    }
    const first = result.items[0];
    const audit = RepositoryQueryAuditMetadataSchema.parse({
      operationId,
      operation,
      workloadId: options.workloadId,
      attemptId: options.attemptId,
      snapshotDigest: view.snapshotDigest,
      ...(readLayer === undefined ? {} : { readLayer }),
      ...(readLayer === "worktree" && first?.metadata?.absent === true ? { absentWorktreePath: first.path } : {}),
      inputHash,
      status: result.status,
      code: result.code,
      bytes: result.bytes,
      items: result.itemCount,
      durationMs: Date.now() - begin,
      truncated: result.truncated,
      hasNextPage: result.nextCursor !== null,
      handles,
    });
    try {
      await options.audit(audit);
    } catch {
      auditBroken = true;
      return {
        ...result,
        status: "failed",
        code: "audit_unavailable",
        items: [],
        bytes: 0,
        itemCount: 0,
        nextCursor: null,
        truncated: false,
      };
    }
    return result;
  }
  return {
    async drain() {
      await tail;
    },
    query(
      operation: RepositoryOperation,
      input: unknown,
      callSignal?: AbortSignal,
    ): Promise<RepositoryResult> {
      const next = tail.then(() => execute(operation, input, callSignal));
      tail = next.catch(() => {});
      return next;
    },
  };
}
