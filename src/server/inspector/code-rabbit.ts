import { createHash } from "node:crypto";
import type { CodeRabbitFinding } from "@shared/code-rabbit.ts";
import { fetchIssueCommentPage, fetchThreadPage, type GhResult, type IssueCommentPage, type PrSnapshot, type ThreadPage } from "./github.ts";
import { preMergeFindings } from "./code-rabbit-pre-merge.ts";

// Bounds include the base response. Each subprocess also has the existing 8 MiB pipe cap.
export const CODE_RABBIT_LIMITS = { pages: 20, bytes: 8 * 1024 * 1024, elapsedMs: 60_000 };

export async function observeCodeRabbit(
  input: { cwd: string | null; owner: string; repo: string; number: number; snapshot: PrSnapshot; startedAt?: number },
  loadNext = (cursor: string, remaining: number): Promise<GhResult<ThreadPage>> =>
    fetchThreadPage(input.cwd, input.owner, input.repo, input.number, cursor, remaining),
  clock = Date.now,
  limits = CODE_RABBIT_LIMITS,
  loadComments = (cursor: string, remaining: number): Promise<GhResult<IssueCommentPage>> =>
    fetchIssueCommentPage(input.cwd, input.owner, input.repo, input.number, cursor, remaining),
): Promise<GhResult<Omit<CodeRabbitFinding, "generation">[]>> {
  const start = input.startedAt ?? clock();
  let page: ThreadPage = {
    threads: input.snapshot.threads, pageInfo: input.snapshot.threadsPageInfo!,
    error: input.snapshot.threadError,
    responseBytes: input.snapshot.responseBytes ?? Buffer.byteLength(JSON.stringify(input.snapshot)),
  };
  let bytes = 0;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const findings: Omit<CodeRabbitFinding, "generation">[] = [];
  let pages = 1;
  const matchesPr = (url: string) => url.toLowerCase().startsWith(`https://github.com/${input.owner}/${input.repo}/pull/${input.number}#`.toLowerCase());
  const isCodeRabbit = (type: string, login: string) => type === "Bot" && login.toLowerCase().replace(/\[bot\]$/, "") === "coderabbitai";
  for (; ; pages++) {
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
      if (!isCodeRabbit(root.actorType, root.author)) continue;
      if (!root.id || !root.updatedAt || !root.url || !matchesPr(root.url)) {
        return { ok: false, error: "Missing CodeRabbit root metadata" };
      }
      findings.push({
        id: thread.id, rootId: root.id, url: root.url, path: thread.path,
        identity: createHash("sha256").update(JSON.stringify([root.id, root.updatedAt, root.body])).digest("hex"),
        resolved: thread.isResolved,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
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
  // Both first pages arrived in the one base response, already charged above.
  let comments = input.snapshot.issueComments;
  const commentIds = new Set<string>(), commentCursors = new Set<string>();
  for (;;) {
    if (!comments || comments.error || !comments.pageInfo || typeof comments.pageInfo.hasNextPage !== "boolean") {
      return { ok: false, error: comments?.error ?? "Missing issue-comment pagination" };
    }
    for (const comment of comments.comments) {
      if (commentIds.has(comment.id)) return { ok: false, error: "Repeated issue-comment identity" };
      commentIds.add(comment.id);
      if (!isCodeRabbit(comment.author.__typename, comment.author.login)) continue;
      if (!matchesPr(comment.url)) return { ok: false, error: "CodeRabbit issue comment belongs to another PR" };
      const checks = preMergeFindings(comment);
      if (!checks.ok) return checks;
      findings.push(...checks.value!);
    }
    if (clock() - start >= limits.elapsedMs) return { ok: false, error: "CodeRabbit observation exceeded its time limit" };
    if (!comments.pageInfo.hasNextPage) return { ok: true, value: findings };
    const cursor = comments.pageInfo.endCursor;
    if (!cursor || commentCursors.has(cursor)) return { ok: false, error: "Missing or repeated issue-comment cursor" };
    commentCursors.add(cursor);
    if (++pages > limits.pages || clock() - start >= limits.elapsedMs) {
      return { ok: false, error: "CodeRabbit observation exceeded its page or time limit" };
    }
    let next: GhResult<IssueCommentPage>;
    try { next = await loadComments(cursor, Math.max(1, limits.elapsedMs - (clock() - start))); }
    catch { return { ok: false, error: "Could not read issue comments" }; }
    if (!next.ok || !next.value) return { ok: false, error: next.error ?? "Could not read issue comments" };
    comments = next.value;
    bytes += comments.responseBytes ?? Buffer.byteLength(JSON.stringify(comments));
    if (bytes > limits.bytes || clock() - start >= limits.elapsedMs) {
      return { ok: false, error: "CodeRabbit observation exceeded its byte or time limit" };
    }
  }
}
