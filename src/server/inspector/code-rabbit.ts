import { createHash } from "node:crypto";
import type { CodeRabbitFinding } from "@shared/code-rabbit.ts";
import { fetchThreadPage, type GhResult, type PrSnapshot, type ThreadPage } from "./github.ts";

// Bounds include the base response. Each subprocess also has the existing 8 MiB pipe cap.
export const CODE_RABBIT_LIMITS = { pages: 20, bytes: 8 * 1024 * 1024, elapsedMs: 60_000 };

export async function observeCodeRabbit(
  input: { cwd: string | null; owner: string; repo: string; number: number; snapshot: PrSnapshot; startedAt?: number },
  loadNext = (cursor: string, remaining: number): Promise<GhResult<ThreadPage>> =>
    fetchThreadPage(input.cwd, input.owner, input.repo, input.number, cursor, remaining),
  clock = Date.now,
  limits = CODE_RABBIT_LIMITS,
): Promise<GhResult<Omit<CodeRabbitFinding, "generation">[]>> {
  const start = input.startedAt ?? clock();
  let page: ThreadPage = {
    threads: input.snapshot.threads, pageInfo: input.snapshot.threadsPageInfo!,
    error: input.snapshot.threadError, responseBytes: input.snapshot.responseBytes,
  };
  let bytes = 0;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const findings: Omit<CodeRabbitFinding, "generation">[] = [];
  for (let pages = 1; ; pages++) {
    bytes += page.responseBytes ?? Buffer.byteLength(JSON.stringify(page));
    if (pages > limits.pages || bytes > limits.bytes || clock() - start >= limits.elapsedMs) {
      return { ok: false, error: "CodeRabbit observation exceeded its page, byte or time limit" };
    }
    if (page.error || !page.pageInfo || typeof page.pageInfo.hasNextPage !== "boolean") {
      return { ok: false, error: page.error ?? "Missing review-thread pagination" };
    }
    for (const thread of page.threads) {
      const root = thread.comments[0];
      if (!thread.id || ids.has(thread.id) || !root?.actorType || !root.author || root.author === "unknown") {
        return { ok: false, error: "Unknown or repeated review-thread root identity" };
      }
      ids.add(thread.id);
      if (root.actorType !== "Bot" || root.author.toLowerCase().replace(/\[bot\]$/, "") !== "coderabbitai") continue;
      if (!root.id || !root.updatedAt || !root.url || !root.url.startsWith(`https://github.com/${input.owner}/${input.repo}/pull/${input.number}#`)) {
        return { ok: false, error: "Missing CodeRabbit root metadata" };
      }
      findings.push({
        id: thread.id, rootId: root.id, url: root.url, path: thread.path,
        identity: createHash("sha256").update(JSON.stringify([root.id, root.updatedAt, root.body])).digest("hex"),
        resolved: thread.isResolved,
      });
    }
    if (!page.pageInfo.hasNextPage) return { ok: true, value: findings };
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) return { ok: false, error: "Missing or repeated review-thread cursor" };
    if (pages >= limits.pages) return { ok: false, error: "CodeRabbit observation exceeded its page limit" };
    cursors.add(cursor);
    let next: GhResult<ThreadPage>;
    try { next = await loadNext(cursor, Math.max(1, limits.elapsedMs - (clock() - start))); }
    catch { return { ok: false, error: "Could not read review threads" }; }
    if (!next.ok || !next.value) return { ok: false, error: next.error ?? "Could not read review threads" };
    page = next.value;
  }
}
