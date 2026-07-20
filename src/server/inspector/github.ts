import { run } from "../util/exec.ts";
import type { RunResult } from "../util/exec.ts";
import { isOurs, parseMarker } from "./marker.ts";
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
  /**
   * The `gh` process died rather than GitHub refusing us, so whether the request took
   * effect is UNKNOWN. Only a writer needs this, and it needs it badly - read the rule
   * off `wasRefused` rather than off this field.
   */
  outcomeUnknown?: boolean;
  /** The response did not fit in the pipe. Retrying the same request cannot produce less. */
  tooLarge?: boolean;
}

/**
 * Did GitHub REFUSE this request - as opposed to us never finding out?
 *
 * The single statement of a rule that decides whether a round which may already be
 * public can be re-planned. A refusal is a fact: nothing was published, so the round is
 * free to be said again. Anything else - a `gh` that died, or a result that never
 * carried the flag at all - is not a fact, and must be treated as "it may have landed".
 *
 * So this demands an explicit `false` rather than testing for the absence of `true`.
 * Every way of not knowing then lands on the same side, and the side it lands on is the
 * one where the cost is a delayed round instead of a duplicate public comment.
 */
export function wasRefused(res: GhResult<unknown>): boolean {
  return !res.ok && res.outcomeUnknown === false;
}

function fail<T>(what: string, res: RunResult): GhResult<T> {
  const detail = (res.stderr || res.stdout || "").trim().slice(0, 300);
  return {
    ok: false,
    error: `${what} failed (exit ${res.code}): ${detail}`,
    outcomeUnknown: res.outcomeUnknown,
    tooLarge: res.overflowed,
  };
}

/**
 * The login `gh` is authenticated as, cached with a TTL.
 *
 * Half of the ownership rule (see `isOurs`): a comment we wrote must carry BOTH our
 * marker and this login. Never hardcoded and never derived from a config value - a
 * GitHub App or a bot credential reports a different login and has to keep working.
 *
 * BOTH answers expire, and the success matters more than the failure. `gh auth switch`
 * is an ordinary thing to do for anyone with a work account and a personal one, and a
 * login cached for the life of the daemon would go on naming the account we are no
 * longer posting as. That is worse than not knowing: every ownership test then reads
 * "nothing here is ours", so questions quietly stop being answered and threads that are
 * open on GitHub get closed in the ledger - and it all looks like a quiet PR, with
 * nothing anywhere saying why. Failing to resolve at least abstains loudly.
 *
 * The failure window is shorter, and for a different reason: it collapses a sweep's
 * worth of pointless subprocesses into one while `gh` is unavailable, without pinning
 * the subsystem into its fail-closed state until a restart.
 */
const LOGIN_TTL_MS = 5 * 60_000;
const LOGIN_FAILURE_TTL_MS = 60_000;

let cachedLogin: string | null = null;
let loginExpiresAt = 0;

export async function authenticatedLogin(
  cwd: string | null,
  now: number = Date.now(),
): Promise<string | null> {
  if (now < loginExpiresAt) return cachedLogin;
  const res = await run("gh", ["api", "user", "--jq", ".login"], {
    cwd: cwd ?? undefined,
    timeoutMs: GH_TIMEOUT_MS,
  });
  const login = res.code === 0 ? res.stdout.trim() : "";
  // A re-resolve that fails discards the old answer rather than keeping it: an identity
  // we can no longer confirm is exactly the one we must not act on.
  cachedLogin = login || null;
  loginExpiresAt = now + (login ? LOGIN_TTL_MS : LOGIN_FAILURE_TTL_MS);
  return cachedLogin;
}

/** Drop the cached login, success or failure. Exists for tests; the tick never calls it. */
export function resetAuthenticatedLogin(): void {
  cachedLogin = null;
  loginExpiresAt = 0;
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
 *
 * This map is what decides which threads may be RESOLVED, so it goes through the
 * two-part `isOurs` rule rather than the marker alone, and returns nothing at all when
 * `login` is null. See `marker.ts`.
 */
export function ourThreads(snapshot: PrSnapshot, login: string | null): Map<string, OurThread> {
  const out = new Map<string, OurThread>();
  if (!login) return out;
  for (const t of snapshot.threads) {
    const first = t.comments[0];
    if (!first) continue;
    if (!isOurs(first, login)) continue;
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

/**
 * How much of a diff we will hold in memory to slice `maxBytes` off the front of it.
 *
 * `gh` hands us the whole diff whatever we intend to keep, so this is a MEMORY ceiling,
 * not a review budget - the daemon is one process also serving hook ingest and SSE. Far
 * above the default 8MB, so a regenerated lockfile or a vendored directory no longer
 * wedges the PR; far below "whatever GitHub will send", so a pathological diff is
 * declined rather than materialised. Past this the caller gets `tooLarge` and stops
 * instead of re-buffering the same bytes every poll.
 */
const MAX_DIFF_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * The whole diff, capped.
 *
 * `maxBytes` is the PROMPT budget and is applied after the fact; `MAX_DIFF_BUFFER_BYTES`
 * is the pipe budget. A response past the pipe budget comes back flagged `tooLarge`,
 * which is a different answer from an ordinary failure: retrying cannot produce fewer
 * bytes, so the tick parks the PR rather than paying for the same overflow every poll.
 */
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
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS, maxBuffer: MAX_DIFF_BUFFER_BYTES },
  );
  if (res.overflowed) {
    return {
      ok: false,
      tooLarge: true,
      error: `the diff is larger than ${Math.round(MAX_DIFF_BUFFER_BYTES / 1024 / 1024)}MB, which is too large to review`,
    };
  }
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

// There is deliberately NO "read back the ids GitHub minted" call here. Everything that
// needs one already works off the live `fetchPr` snapshot - replies use the newest
// comment's `databaseId`, resolution uses `ourThreads` - so a second paginated round
// trip per posted round only ever filled a column nothing read.

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
 *
 * The body is parsed for `errors` for the same reason `fetchPr` does it: GraphQL
 * reports failure in a 200, so a zero exit is not success on its own. Reporting a
 * refused mutation as `ok` would flip the ledger row to `resolved` while the thread
 * stayed open on GitHub - and the next round, seeing no open row, would post the same
 * finding again into the thread that never closed.
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
  try {
    const json = JSON.parse(res.stdout) as {
      data?: { resolveReviewThread?: { thread?: { isResolved?: unknown } | null } | null };
      errors?: { message?: string }[];
    };
    if (json.errors?.length) {
      return { ok: false, error: `graphql: ${json.errors.map((e) => e.message).join("; ")}` };
    }
    if (json.data?.resolveReviewThread?.thread?.isResolved !== true) {
      return { ok: false, error: "the thread did not come back resolved" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `could not parse gh output: ${String(err)}` };
  }
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
