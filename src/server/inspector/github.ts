import { run } from "../util/exec.ts";
import { parseMarker } from "./marker.ts";
import type { OurThread } from "./verdict.ts";
import type { PlannedComment } from "./verdict.ts";

// Everything that talks to GitHub, through the `gh` CLI.
//
// `gh` rather than the REST API directly, for the same reason `src/server/pr.ts` uses
// it: the operator is already authenticated to it, so there is no token for this app to
// ask for, store, or leak. The cost is that every call is a subprocess.
//
// Reads use GraphQL because one query answers everything a tick needs - PR state, head
// sha, and every review thread with its comments - where REST would be three or four
// calls. Writes use REST except for resolving a thread, which only GraphQL can do.

/** Generous next to `pr.ts`'s 8s: these carry a whole PR's thread history or a review body. */
const GH_TIMEOUT_MS = 20_000;

export interface GhResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function fail<T>(what: string, res: { stderr: string; stdout: string; code: number | null }): GhResult<T> {
  const detail = (res.stderr || res.stdout || "").trim().slice(0, 300);
  return { ok: false, error: `${what} failed (exit ${res.code}): ${detail}` };
}

/** Split "https://github.com/owner/repo/pull/123" into its parts, or null. */
export function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number; key: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  const [, owner, repo, num] = m;
  return {
    owner: owner!,
    repo: repo!,
    number: Number(num),
    key: `${owner}/${repo}#${num}`,
  };
}

export interface PrSnapshot {
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  title: string;
  body: string;
  isDraft: boolean;
  threads: ThreadSnapshot[];
}

export interface ThreadSnapshot {
  id: string;
  isResolved: boolean;
  path: string | null;
  comments: {
    databaseId: number | null;
    body: string;
    author: string;
    createdAt: string;
  }[];
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      state headRefOid isDraft title body
      reviewThreads(first:100){
        nodes{
          id isResolved path
          comments(first:100){
            nodes{ databaseId body createdAt author{ login } }
          }
        }
      }
    }
  }
}`;

/**
 * One read per PR per tick: state, head sha, and every review thread.
 *
 * The head sha is why there is no separate `gh pr view` anywhere in this subsystem -
 * and why the Inspector needs no new `Session` field to know when to re-review.
 */
export async function fetchPr(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
): Promise<GhResult<PrSnapshot>> {
  const res = await run(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${PR_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${repo}`,
      "-F",
      `number=${number}`,
    ],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api graphql", res);
  try {
    const json = JSON.parse(res.stdout) as {
      data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null };
      errors?: { message?: string }[];
    };
    // GraphQL reports errors in a 200 body, so a zero exit is not success on its own.
    if (json.errors?.length) {
      return { ok: false, error: `graphql: ${json.errors.map((e) => e.message).join("; ")}` };
    }
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return { ok: false, error: "no such pull request" };
    return { ok: true, value: toSnapshot(pr) };
  } catch (err) {
    return { ok: false, error: `could not parse gh output: ${String(err)}` };
  }
}

function toSnapshot(pr: Record<string, unknown>): PrSnapshot {
  const threadNodes =
    ((pr.reviewThreads as { nodes?: unknown[] } | undefined)?.nodes as unknown[]) ?? [];
  return {
    state: (pr.state as PrSnapshot["state"]) ?? "CLOSED",
    headSha: typeof pr.headRefOid === "string" ? pr.headRefOid : "",
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    isDraft: pr.isDraft === true,
    threads: threadNodes.filter(Boolean).map((raw) => {
      const t = raw as Record<string, unknown>;
      const commentNodes = ((t.comments as { nodes?: unknown[] } | undefined)?.nodes ?? []) as unknown[];
      return {
        id: String(t.id ?? ""),
        isResolved: t.isResolved === true,
        path: typeof t.path === "string" ? t.path : null,
        comments: commentNodes.filter(Boolean).map((c) => {
          const o = c as Record<string, unknown>;
          return {
            databaseId: typeof o.databaseId === "number" ? o.databaseId : null,
            body: typeof o.body === "string" ? o.body : "",
            author: String((o.author as { login?: unknown } | null)?.login ?? "unknown"),
            createdAt: String(o.createdAt ?? ""),
          };
        }),
      };
    }),
  };
}

/**
 * Our threads, keyed by the fingerprint in the marker of the thread's FIRST comment.
 *
 * The first comment specifically: that is the one we wrote to open the thread. A later
 * comment of ours in the same thread is a follow-up reply and carries the same
 * fingerprint, but keying off "any comment of ours" would let a thread someone else
 * started - which we merely replied to - be treated as ours to resolve.
 */
export function ourThreads(snapshot: PrSnapshot): Map<string, OurThread> {
  const out = new Map<string, OurThread>();
  for (const t of snapshot.threads) {
    const first = t.comments[0];
    if (!first) continue;
    const marker = parseMarker(first.body);
    if (!marker) continue;
    out.set(marker.fingerprint, {
      fingerprint: marker.fingerprint,
      threadId: t.id,
      isResolved: t.isResolved,
    });
  }
  return out;
}

export async function fetchDiff(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  maxBytes: number,
): Promise<GhResult<{ diff: string; truncated: boolean }>> {
  const res = await run(
    "gh",
    ["api", `repos/${owner}/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff"],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api (diff)", res);
  const full = res.stdout;
  return {
    ok: true,
    value: { diff: full.slice(0, maxBytes), truncated: full.length > maxBytes },
  };
}

/**
 * Post one review carrying every inline comment for this round.
 *
 * ONE call, deliberately: a round lands as a single review the author gets one
 * notification for, rather than N separate comments. `event: "COMMENT"` and never
 * APPROVE or REQUEST_CHANGES - the Inspector's job is to surface issues, and blocking
 * a merge is a different kind of consent than the operator gave by enabling it.
 */
export async function postReview(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  body: string,
  comments: { path: string; line: number; body: string }[],
  commitId: string,
): Promise<GhResult<void>> {
  const payload = JSON.stringify({
    commit_id: commitId,
    body,
    event: "COMMENT",
    comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
  });
  const res = await run(
    "gh",
    ["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS, input: payload },
  );
  if (res.code !== 0) return fail("gh api (create review)", res);
  return { ok: true };
}

/**
 * The review comments we just created, newest first.
 *
 * Creating a review does not tell us the ids of the comments inside it, and we need
 * them to reply and to map rows onto threads later. Rather than trust the order of the
 * response, this re-reads and matches on the marker - which is the only thing that
 * actually identifies one of ours.
 */
export async function fetchReviewComments(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
): Promise<GhResult<Map<string, number>>> {
  const res = await run(
    "gh",
    ["api", "--paginate", `repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api (list comments)", res);
  try {
    // --paginate concatenates JSON arrays; normalize back into one.
    const chunks = res.stdout.replace(/\]\s*\[/g, ",").trim();
    const arr = JSON.parse(chunks || "[]") as { id?: unknown; body?: unknown }[];
    const byFingerprint = new Map<string, number>();
    for (const c of arr) {
      if (typeof c.body !== "string" || typeof c.id !== "number") continue;
      const marker = parseMarker(c.body);
      if (marker) byFingerprint.set(marker.fingerprint, c.id);
    }
    return { ok: true, value: byFingerprint };
  } catch (err) {
    return { ok: false, error: `could not parse comment list: ${String(err)}` };
  }
}

/** Reply in an existing thread, by the id of any comment already in it. */
export async function replyToComment(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  body: string,
): Promise<GhResult<void>> {
  const res = await run(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      "--input",
      "-",
    ],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS, input: JSON.stringify({ body }) },
  );
  if (res.code !== 0) return fail("gh api (reply)", res);
  return { ok: true };
}

const RESOLVE_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread { id isResolved } }
}`;

/**
 * Resolve one review thread. GraphQL only - REST cannot do this.
 *
 * The caller is responsible for having established that the thread is ours; there is
 * nothing in this call that would stop it closing someone else's.
 */
export async function resolveThread(
  cwd: string | null,
  threadId: string,
): Promise<GhResult<void>> {
  const res = await run(
    "gh",
    ["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-F", `threadId=${threadId}`],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api (resolve thread)", res);
  return { ok: true };
}

/** Render one finding as a comment body: marker first, at column 0. See `marker.ts`. */
export function renderComment(marker: string, c: PlannedComment): string {
  return [
    marker,
    `**⌕ Inspector** · \`${c.severity}\` · ${c.title}`,
    "",
    c.body,
    "",
    "<sub>Automated review from Mission Control against `INSPECTOR.md`. Reply here to ask a follow-up.</sub>",
  ].join("\n");
}
