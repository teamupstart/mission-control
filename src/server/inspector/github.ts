import { z } from "zod";
import { ghBin } from "../config.ts";
import { run } from "../util/exec.ts";
import type { RunResult } from "../util/exec.ts";
import { clipUtf8Bytes, utf8Bytes } from "../util/utf8.ts";
import {
  BODY_ONLY_FINDINGS_MARKER,
  isCleanReview,
  isOurBodyFindingsReview,
  isOurs,
  parseMarker,
  reviewHeader,
} from "./marker.ts";
import type { OurThread } from "./verdict.ts";
import type { PlannedComment } from "./verdict.ts";
import type { ChecksState, MergeableState, ReviewDecision } from "@shared/shipping.ts";
import type { InspectorComment } from "@shared/types.ts";
import { scrubSecrets } from "./scrub.ts";
import { CHECK_CONTEXTS, rollUpChecks } from "../github/check-rollup.ts";

// Everything that talks to GitHub, through the `gh` CLI.
//
// `gh` rather than the REST API directly, for the same reason `src/server/pr.ts` uses
// it: the operator is already authenticated to it, so there is no token for this app to
// ask for, store, or leak. The cost is that every call is a subprocess.
//
// Reads use GraphQL because one query answers everything a tick needs - PR state, head
// sha, every review thread with its comments, and recent top-level reviews - where REST
// would be three or four calls. Writes use REST except for resolving a thread, which
// only GraphQL can do.

/** Generous next to `pr.ts`'s 8s: these carry a whole PR's thread history or a review body. */
const GH_TIMEOUT_MS = 20_000;

/** Full GraphQL connection pages and their validation ceilings share one budget. */
export const GITHUB_PAGE_SIZE = 100;

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
  /**
   * Everything `gh` printed to stderr, unclipped. `error` keeps only its first 300 bytes for
   * the operator, and gh prints the HTTP status at the END of its message, so a long 422
   * would lose it there. `classifyReviewRefusal` reads this instead.
   */
  stderr?: string;
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
 *
 * `tooLarge` is excluded, and it is the one case where READING and WRITING draw opposite
 * conclusions from the same flag. On a read an overflow is a fact ABOUT THE RESPONSE -
 * the body will not fit, asking again cannot shrink it, so `fetchDiff` rightly declines
 * the PR. On a write the request completed and GitHub answered; the only thing that
 * failed is our own buffer, so the review DID land and calling that a refusal would
 * re-post every comment in it. The predicate lives on the write side, so it takes the
 * write side's reading; the read side inspects `tooLarge` directly.
 */
export function wasRefused(res: GhResult<unknown>): boolean {
  return !res.ok && res.outcomeUnknown === false && !res.tooLarge;
}

function fail<T>(what: string, res: RunResult): GhResult<T> {
  const detail = (res.stderr || res.stdout || "").trim().slice(0, 300);
  return {
    ok: false,
    error: `${what} failed (exit ${res.code}): ${detail}`,
    outcomeUnknown: res.outcomeUnknown,
    tooLarge: res.overflowed,
    stderr: res.stderr,
  };
}

/**
 * Why GitHub refused a review, as far as attributing the refusal goes.
 *
 * - `whole-review`: the refusal says nothing about any one comment in the review - a rate
 *   limit (429, or a 403 naming a secondary rate limit), an auth refusal (401), an organization's
 *   SAML SSO refusal (whatever status it carries), a server error (5xx), a head that moved under the
 *   review, and any other status that is not 422. No finding is ever charged for one.
 * - `validation`: a 422 on a head that has not moved. GitHub validated the review against
 *   the commit it names and rejected something in it, most often a line it cannot anchor.
 */
export type ReviewRefusalClass = "whole-review" | "validation";

/** gh's wording for an organization's SAML SSO refusal, which GraphQL can report as a 422. */
const SSO_REFUSAL_RE =
  /Resource protected by organization SAML enforcement|has enabled or enforced SAML SSO/i;

/**
 * GitHub's wording when one review comment cannot be anchored: its line, path or position
 * could not be resolved, or is not in the diff. Other 422s, such as the one-pending-review
 * limit, are about the review as a whole and say nothing about any draft.
 */
const ANCHOR_REFUSAL_RE =
  /\b(?:line|path|position|start[ _]line)\b[^()\n]*?\b(?:could not be resolved|must be part of the diff|is not part of the diff|is outside the diff|is invalid)/i;

/** gh ends an API error with `(HTTP nnn)`. The last one wins, in case a body quoted another. */
function httpStatus(stderr: string): number | null {
  const all = [...stderr.matchAll(/\(HTTP (\d{3})\)/g)];
  const last = all.at(-1);
  return last ? Number(last[1]) : null;
}

/**
 * Classify a review POST GitHub refused. The one place that decides it: the worker's
 * drafts-only path and its retry of a mixed review both ask here, and nothing else does.
 *
 * Reads the status from gh's stderr, where gh prints it last. A status it
 * cannot find is `whole-review`, so a change in gh's wording can make the refusal cap
 * engage less often but can never pin a refusal on the wrong finding. The same holds for
 * the message: a 422 is `validation` only when it names a comment that could not be
 * anchored (`ANCHOR_REFUSAL_RE`).
 *
 * `headUnmoved` is called only for a 422, and it is the only extra request a refusal costs:
 * GitHub also answers 422 for a review whose `commit_id` is no longer the pull request's
 * head, and that says nothing about any finding. A failed read is not proof the head stayed
 * put, so it reads as moved.
 *
 * A result that was not a refusal at all - a lost response, or a success - is
 * `whole-review` too. It should never be asked, and if it is, nothing gets counted.
 */
export async function classifyReviewRefusal(
  res: GhResult<unknown>,
  headUnmoved: () => Promise<boolean>,
): Promise<ReviewRefusalClass> {
  if (!wasRefused(res)) return "whole-review";
  const stderr = res.stderr ?? "";
  if (SSO_REFUSAL_RE.test(stderr)) return "whole-review";
  if (httpStatus(stderr) !== 422) return "whole-review";
  if (!ANCHOR_REFUSAL_RE.test(stderr)) return "whole-review";
  return (await headUnmoved()) ? "validation" : "whole-review";
}

/**
 * GitHub's reason for a refusal, as recorded on the finding it was pinned on: what gh
 * printed, with the `gh:` prefix dropped, whitespace collapsed, secrets scrubbed, and
 * clipped to 300 bytes like every other GitHub error this subsystem stores.
 */
export function refusalReason(res: GhResult<unknown>): string {
  const raw = (res.stderr || res.error || "GitHub refused the review").replace(/^gh:\s*/, "");
  return clipUtf8Bytes(scrubSecrets(raw.replace(/\s+/g, " ").trim()), 300);
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
  const res = await run(ghBin(), ["api", "user", "--jq", ".login"], {
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

/** Latest ref update for the source branch of one open PR, including fork PRs. */
export interface InspectorBranchActivity {
  prKey: string;
  repository: string;
  ref: string;
  headSha: string;
  activityId: number;
  changedAt: number;
  verifiedForcePushId?: string;
  refHistory: { prCreatedAt: number; anchorActivityId: number; anchorChangedAt: number; updatesChecked: number };
}

const recoveryPullRequest = z.object({
  number: z.number().int(), state: z.enum(["open", "closed"]), created_at: z.iso.datetime(),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
  head: z.object({ ref: z.string().min(1), sha: z.string().min(1),
    repo: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }) }),
});

const refUpdate = z.object({
  id: z.number().int().positive(), ref: z.string(), before: z.string().min(1), after: z.string().min(1),
  timestamp: z.iso.datetime().optional(), pushed_at: z.iso.datetime().optional(), activity_type: z.string().optional(),
}).transform((row, ctx) => {
  const timestamp = row.timestamp ?? row.pushed_at;
  if (!timestamp || (row.timestamp && row.pushed_at && row.timestamp !== row.pushed_at)) {
    ctx.addIssue({ code: "custom", message: "Ambiguous branch activity time" });
    return z.NEVER;
  }
  return { ...row, changedAt: Date.parse(timestamp) };
});

function verifyRefHistory(
  updates: z.output<typeof refUpdate>[], ref: string, head: string, prCreatedAt: number,
): InspectorBranchActivity["refHistory"] | null {
  // Walk backwards from the current head. A pre-grant observation of this head
  // identifies its latest arrival only if the ref could not have left it since
  // the PR opened. Both the start boundary and the activity times are GitHub's.
  let expectedAfter = head;
  let newestTime = Infinity;
  const seen = new Set<number>();
  for (const update of updates) {
    if (update.ref !== ref || update.after !== expectedAfter || update.changedAt > newestTime
        || seen.has(update.id) || (seen.size > 0 && update.after === head)) return null;
    seen.add(update.id);
    if (update.changedAt + 1_000 <= prCreatedAt) {
      return { prCreatedAt, anchorActivityId: update.id, anchorChangedAt: update.changedAt, updatesChecked: seen.size };
    }
    if (update.before === head || /^0+$/.test(update.before) || /^0+$/.test(update.after)) return null;
    expectedAfter = update.before;
    newestTime = update.changedAt;
  }
  return null;
}

async function readRecoveryApi(endpoint: string, ...args: string[]) {
  try {
    const response = await run(ghBin(), ["api", "--hostname", "github.com", "-H", "Cache-Control: no-cache", endpoint, ...args], { timeoutMs: GH_TIMEOUT_MS });
    return response.overflowed || response.outcomeUnknown ? null : { code: response.code, body: JSON.parse(response.stdout) as unknown };
  } catch { return null; }
}

async function readRecoveryRest(endpoint: string) {
  const response = await readRecoveryApi(endpoint);
  return response?.code === 0 ? response.body : null;
}

function readRefActivity(repository: string, ref: string, count: number) {
  // Include force pushes, merges and branch recreation.
  const query = new URLSearchParams({ ref, direction: "desc", per_page: String(count) });
  return readRecoveryRest(`repos/${repository}/activity?${query}`);
}

async function readRecoveryPull(pr: NonNullable<ReturnType<typeof parsePrUrl>>) {
  const base = `${pr.owner}/${pr.repo}`;
  const pull = recoveryPullRequest.safeParse(await readRecoveryRest(`repos/${base}/pulls/${pr.number}`));
  if (!pull.success || pull.data.number !== pr.number || pull.data.base.repo.full_name.toLowerCase() !== base.toLowerCase()) return null;
  return pull.data;
}

const recoveryTip = z.object({
  prKey: z.string(), headSha: z.string(), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  ref: z.string().startsWith("refs/heads/"), activityId: z.number().int().positive(), changedAt: z.number(),
  verifiedForcePushId: z.string().min(1).optional(),
});

const recoveryPullQuery = `query RecoveryPull($owner:String!,$repo:String!,$number:Int!,$since:DateTime!){
  repository(owner:$owner,name:$repo){nameWithOwner pullRequest(number:$number){
    number state headRefName headRefOid headRepository{nameWithOwner}
    timelineItems(first:1,since:$since,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT,HEAD_REF_DELETED_EVENT,HEAD_REF_RESTORED_EVENT,CLOSED_EVENT,REOPENED_EVENT]){
      pageInfo{hasNextPage} nodes{__typename ... on Node{id}
        ... on HeadRefForcePushedEvent{createdAt beforeCommit{oid} afterCommit{oid} ref{prefix name repository{nameWithOwner}}}}
    }
  }}
}`;

const timelineEvent = z.object({ __typename: z.string(), id: z.string().min(1) }).loose();
const forcePushEvent = timelineEvent.extend({
  __typename: z.literal("HeadRefForcePushedEvent"), createdAt: z.iso.datetime(),
  beforeCommit: z.object({ oid: z.string() }), afterCommit: z.object({ oid: z.string() }),
  ref: z.object({ prefix: z.string(), name: z.string(), repository: z.object({ nameWithOwner: z.string() }) }),
});
const recoveryPullSnapshot = z.object({
  errors: z.array(z.object({ message: z.string(), path: z.array(z.union([z.string(), z.number()])).optional() })).optional(),
  data: z.object({ repository: z.object({ nameWithOwner: z.string(), pullRequest: z.looseObject({
    number: z.number().int(), state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  }) }) }),
});
const openRecoverySource = z.object({
  headRefName: z.string(), headRefOid: z.string(), headRepository: z.object({ nameWithOwner: z.string() }),
  timelineItems: z.object({ nodes: z.array(timelineEvent).max(1), pageInfo: z.object({ hasNextPage: z.boolean() }) }),
});

async function readRecoveryTimeline(pr: NonNullable<ReturnType<typeof parsePrUrl>>, changedAt: number) {
  // Ask GitHub about the entire timestamp bucket containing this ref update.
  const since = new Date(Math.floor(changedAt / 1_000) * 1_000 - 1);
  if (!Number.isFinite(since.getTime())) return null;
  const result = await readRecoveryApi("graphql", "-f", `query=${recoveryPullQuery}`,
    "-f", `owner=${pr.owner}`, "-f", `repo=${pr.repo}`, "-F", `number=${pr.number}`, "-f", `since=${since.toISOString()}`);
  if (!result || (result.code !== 0 && result.code !== 1)) return null;
  const response = recoveryPullSnapshot.safeParse(result.body);
  if (!response.success) return null;
  const base = response.data.data.repository;
  const matchesIdentity = base.nameWithOwner.toLowerCase() === `${pr.owner}/${pr.repo}`.toLowerCase() && base.pullRequest.number === pr.number;
  const errors = response.data.errors;
  if (result.code !== 0 || errors?.length) {
    // gh writes partial GraphQL data to stdout and exits 1 for field errors.
    // Only an identified closure survives errors confined to the source or timeline.
    const independentErrors = errors?.length && errors.every(({ path }) => path?.[0] === "repository"
      && path[1] === "pullRequest" && ["headRefName", "headRefOid", "headRepository", "timelineItems"].includes(String(path[2])));
    return independentErrors && matchesIdentity && base.pullRequest.state !== "OPEN" ? false : null;
  }
  if (!matchesIdentity || base.pullRequest.state !== "OPEN") return false;
  const source = openRecoverySource.safeParse(base.pullRequest);
  return source.success ? source.data : null;
}

/** Read the PR state, head and evidence of a ref rewrite together at final verification. */
export async function recheckInspectorRecoveryTip(prUrl: string, head: string, receipt: unknown): Promise<boolean | null> {
  const pr = parsePrUrl(prUrl);
  const saved = recoveryTip.safeParse(receipt);
  if (!pr || !saved.success || saved.data.prKey !== pr.key || saved.data.headSha !== head) return false;
  const { repository, ref, activityId, changedAt } = saved.data;
  for (let sample = 0; sample < 2; sample++) {
    const tip = z.tuple([refUpdate]).safeParse(await readRefActivity(repository, ref, 1));
    if (tip.success) {
      const [latest] = tip.data;
      if (latest.ref !== ref || latest.after !== head || latest.id !== activityId || latest.changedAt !== changedAt) return false;
    }
    const pull = await readRecoveryTimeline(pr, changedAt);
    if (pull === false) return false;
    if (!pull) return null;
    if (pull.headRepository.nameWithOwner.toLowerCase() !== repository.toLowerCase()
        || `refs/heads/${pull.headRefName}` !== ref || pull.headRefOid !== head || pull.timelineItems.pageInfo.hasNextPage) return false;
    const [event] = pull.timelineItems.nodes;
    if (event?.id !== saved.data.verifiedForcePushId || (event && event.__typename !== "HeadRefForcePushedEvent")) return false;
    if (!tip.success) return null;
  }
  return true;
}

export async function readInspectorBranchActivity(prUrl: string, expectedHead: string): Promise<InspectorBranchActivity | null> {
  const pr = parsePrUrl(prUrl);
  if (!pr) return null;
  const source = await readRecoveryPull(pr);
  if (source?.state !== "open" || source.head.sha !== expectedHead) return null;
  const repository = source.head.repo.full_name;
  const ref = `refs/heads/${source.head.ref}`;
  const first = z.tuple([refUpdate]).safeParse(await readRefActivity(repository, ref, 1));
  if (!first.success) return null;
  const [tip] = first.data;
  if (tip.ref !== ref || tip.after !== expectedHead) return null;
  let verifiedForcePushId: string | undefined;
  if (tip.activity_type === "force_push") {
    const snapshot = await readRecoveryTimeline(pr, tip.changedAt);
    if (!snapshot || snapshot.headRefOid !== expectedHead || snapshot.headRefName !== source.head.ref
        || snapshot.headRepository.nameWithOwner.toLowerCase() !== repository.toLowerCase()
        || snapshot.timelineItems.pageInfo.hasNextPage) return null;
    const event = forcePushEvent.safeParse(snapshot.timelineItems.nodes[0]);
    if (!event.success) return null;
    const push = event.data;
    if (Math.floor(Date.parse(push.createdAt) / 1_000) !== Math.floor(tip.changedAt / 1_000)
        || push.beforeCommit.oid !== tip.before || push.afterCommit.oid !== tip.after
        || push.ref.prefix + push.ref.name !== ref || push.ref.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()) return null;
    verifiedForcePushId = push.id;
  }
  const current = await readRecoveryPull(pr);
  if (current?.state !== "open" || current.head.sha !== expectedHead || current.head.repo.full_name.toLowerCase() !== repository.toLowerCase()
      || current.head.ref !== source.head.ref || current.created_at !== source.created_at) return null;

  const history = z.array(refUpdate).max(GITHUB_PAGE_SIZE).safeParse(await readRefActivity(repository, ref, GITHUB_PAGE_SIZE));
  if (!history.success) return null;
  const latest = history.data[0];
  if (!latest || latest.id !== tip.id || latest.changedAt !== tip.changedAt || latest.before !== tip.before
      || latest.activity_type !== tip.activity_type) return null;
  const refHistory = verifyRefHistory(history.data, ref, expectedHead, Date.parse(current.created_at));
  if (!refHistory) return null;
  return { prKey: pr.key, repository, ref, headSha: expectedHead, activityId: latest.id, changedAt: latest.changedAt, refHistory,
    ...(verifiedForcePushId && { verifiedForcePushId }) };
}

export interface GitHubRepositoryIdentity {
  owner: string;
  repo: string;
}

/** Read a GitHub repository identity from one configured git remote URL. */
export function parseGitHubRemoteUrl(url: string): GitHubRepositoryIdentity | null {
  const value = url.trim();
  const scp = /^(?:[^@\s]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value);
  if (scp) return { owner: scp[1]!, repo: scp[2]! };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * The GitHub repositories this checkout's git config names.
 *
 * Every configured fetch remote is considered rather than assuming one named `origin`:
 * forks cloned with `--origin upstream` and checkouts with a separate fork remote are both
 * ordinary. An unreadable config, a repository with no remotes, and non-GitHub remotes all
 * answer with an empty set, which makes the adoption caller abstain.
 */
export async function configuredGitHubRepositories(
  repoRoot: string,
): Promise<GitHubRepositoryIdentity[]> {
  const result = await run("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
    cwd: repoRoot,
  });
  if (result.outcomeUnknown || result.code !== 0) return [];

  const repositories = new Map<string, GitHubRepositoryIdentity>();
  for (const line of result.stdout.split("\n")) {
    const separator = line.search(/\s/);
    if (separator < 0) continue;
    const identity = parseGitHubRemoteUrl(line.slice(separator).trim());
    if (!identity) continue;
    const key = `${identity.owner}/${identity.repo}`.toLowerCase();
    repositories.set(key, identity);
  }
  return [...repositories.values()];
}

export interface PrSnapshot {
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  /**
   * The branch the pull request is opened FROM, or "" when GitHub did not report one.
   *
   * Read by the `pull_request` session action adapter, which proves its pull request by
   * repository AND branch. Empty is carried rather than defaulted: a blank branch matches
   * nothing, which is the fail-closed reading for a field that decides whether a workflow
   * lets downstream stages run.
   */
  headRefName: string;
  /**
   * The branch the pull request targets, the repository's default branch, and the merge
   * commit once it merged. Read for stacked pull requests: the merge gate's base checks, the
   * base-aware review record, and the stack release check. Empty strings / null mean GitHub
   * did not report one, which every reader treats as unknown. Optional only so hand-built
   * fixtures stay valid; `fetchPr` always fills them.
   */
  baseRefName?: string;
  /**
   * The base branch's tip as GitHub reports it for this pull request. Stacked reviews record
   * it, because a parent rebased under an unchanged child head changes the pull request's
   * diff without changing either branch name.
   */
  baseSha?: string;
  defaultBranch?: string;
  mergeCommitSha?: string | null;
  /** When it merged (epoch ms), or null. Read so a stacked child's stray merge can be dated. */
  mergedAt?: number | null;
  title: string;
  body: string;
  isDraft: boolean;
  threadError?: string | null;
  responseBytes?: number;
  threads: ThreadSnapshot[];
  /** Pagination state for the first review-thread page. */
  threadsPageInfo?: ThreadPageInfo;
  /** Requested only for enabled CodeRabbit follow-up, in the shared PR read. */
  issueComments?: IssueCommentPage;
  /** Latest top-level reviews, used to recover an interrupted clean-review post. */
  reviews: ReviewSnapshot[];
  reviewsPageInfo: ReviewPageInfo;
  /**
   * When the PR was opened, epoch ms, or null when GitHub's timestamp did not parse.
   *
   * Read for the auto-merge soak, which is the window a colleague has to object. Null is
   * carried rather than defaulted to "now" or to zero: the first would make the soak
   * unfinishable and the second would make it already over, and the gate has to be able
   * to tell "not long enough yet" from "we don't know".
   */
  createdAt: number | null;
  /** GitHub's own mergeability verdict. `UNKNOWN` while it is still computing one. */
  mergeable: MergeableState;
  /** The human review verdict, when the repo or a reviewer has produced one. */
  reviewDecision: ReviewDecision;
  /** CI on the head commit, rolled up. `none` is "nothing reported", not "passing". */
  checks: ChecksState;
}

export interface ThreadSnapshot {
  id: string;
  isResolved: boolean;
  path: string | null;
  comments: {
    id?: string;
    updatedAt?: string;
    actorType?: string | null;
    databaseId: number | null;
    /** The comment's GitHub link, or null when GitHub did not report one. */
    url: string | null;
    body: string;
    author: string;
    createdAt: string;
  }[];
}

export interface ReviewSnapshot {
  /** The review's GitHub link, or null when GitHub did not report one. */
  url: string | null;
  body: string;
  author: string;
  headSha: string;
}

export interface ReviewPageInfo {
  hasPreviousPage: boolean;
  startCursor: string | null;
}

export interface ThreadPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ReviewPage {
  reviews: ReviewSnapshot[];
  pageInfo: ReviewPageInfo;
}

export interface ThreadPage {
  error?: string | null;
  responseBytes?: number;
  threads: ThreadSnapshot[];
  pageInfo: ThreadPageInfo;
}

const IssueCommentSchema = z.object({
  id: z.string().min(1), url: z.string().url(), body: z.string(), updatedAt: z.string().datetime(),
  author: z.object({ __typename: z.string().min(1), login: z.string().min(1) }),
});
export type IssueCommentSnapshot = z.infer<typeof IssueCommentSchema>;
export interface IssueCommentPage {
  comments: IssueCommentSnapshot[];
  pageInfo: ThreadPageInfo;
  error?: string | null;
  responseBytes?: number;
}
const ISSUE_COMMENT_FIELDS = `nodes{ id url body updatedAt author{ __typename login } }
  pageInfo{ hasNextPage endCursor }`;

const PR_QUERY = (includeCodeRabbitComments: boolean) => `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      state headRefOid headRefName isDraft title body createdAt mergeable reviewDecision
      baseRefName baseRefOid mergeCommit{ oid } mergedAt repository{ defaultBranchRef{ name } }
      commits(last:1){ nodes{ commit{ statusCheckRollup{ state ${CHECK_CONTEXTS} } } } }
      reviewThreads(first:${GITHUB_PAGE_SIZE}){
        nodes{
          id isResolved path
          comments(first:${GITHUB_PAGE_SIZE}){
            nodes{ id url databaseId body createdAt updatedAt author{ __typename login } }
          }
        }
        pageInfo{ hasNextPage endCursor }
      }
      ${includeCodeRabbitComments ? `comments(first:${GITHUB_PAGE_SIZE}){ ${ISSUE_COMMENT_FIELDS} }` : ""}
      reviews(last:${GITHUB_PAGE_SIZE}){
        nodes{ url body author{ login } commit{ oid } }
        pageInfo{ hasPreviousPage startCursor }
      }
    }
  }
}`;

const REVIEW_PAGE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$before:String!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviews(last:${GITHUB_PAGE_SIZE},before:$before){
        nodes{ url body author{ login } commit{ oid } }
        pageInfo{ hasPreviousPage startCursor }
      }
    }
  }
}`;

const THREAD_PAGE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:${GITHUB_PAGE_SIZE},after:$after){
        nodes{ id isResolved path comments(first:1){ nodes{ id url databaseId body createdAt updatedAt author{ __typename login } } } }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}`;

const ISSUE_COMMENT_PAGE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    comments(first:${GITHUB_PAGE_SIZE},after:$after){ ${ISSUE_COMMENT_FIELDS} }
  } }
}`;

/**
 * One read per PR per tick: state, head sha, every review thread, and everything the
 * auto-merge gate weighs (CI rollup, mergeability, review decision, when it was opened).
 *
 * The head sha is why there is no separate `gh pr view` anywhere in this subsystem -
 * and why the Inspector needs no new `Session` field to know when to re-review.
 *
 * YOLO mode adds fields to this ONE query rather than a second call of its own: the tick
 * already pays for a round trip per PR, and a separate `gh pr checks` would let the
 * merge decision be made from a CI answer read at a different instant than the head sha
 * it is supposed to be about.
 */
export async function fetchPr(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  includeCodeRabbitComments = false,
): Promise<GhResult<PrSnapshot>> {
  const res = await run(
    ghBin(),
    [
      "api",
      "graphql",
      "-f",
      `query=${PR_QUERY(includeCodeRabbitComments)}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${repo}`,
      "-F",
      `number=${number}`,
    ],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  if (res.code !== 0 || res.overflowed) return fail("gh api graphql", res);
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
    // A read that cannot say which state the pull request is in observed nothing. Defaulting
    // it to CLOSED retired an open pull request's row for good: the tick stops polling a
    // retired row, and the workflow gate pinned to it blocked as closed.
    if (!isPrState(pr.state)) {
      return { ok: false, error: "GitHub's answer did not say whether the pull request is open" };
    }
    return { ok: true, value: { ...toSnapshot(pr, pr.state),
      ...(includeCodeRabbitComments ? { issueComments: issueCommentPage(pr.comments) } : {}),
      responseBytes: utf8Bytes(res.stdout) } };
  } catch (err) {
    return { ok: false, error: `could not parse gh output: ${String(err)}` };
  }
}

/**
 * GitHub's status rollup, in the four words the merge gate speaks.
 *
 * `EXPECTED` is a check GitHub knows is coming but has not started, so it groups with
 * `PENDING`. A MISSING rollup - no workflow, or none triggered on this commit - is
 * `none`, never `passing`: see `mergeVerdict`, where that distinction is the difference
 * between "merge what CI approves" and "merge whatever nobody objected to".
 */
function toChecks(state: unknown): ChecksState {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "ERROR":
    case "FAILURE":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/**
 * The head commit's CI, for the merge gate: GitHub's own rollup, except where GitHub says
 * failing only because of a run a later run of the same check has since re-checked.
 *
 * GitHub's aggregate counts every check run the commit ever had, so a title check that failed
 * and then passed after the title was edited reads FAILURE for good, and the gate held the pull
 * request on "CI is failing" while GitHub's checks list was green. The override is narrow on
 * purpose, because this verdict lets a pull request merge itself: it only ever clears a failure,
 * only when the page of checks is complete, only when a failing run was re-checked by a later run
 * of the same check - a GitHub Actions run of the same workflow file, triggering event and name, so a
 * passing `pull_request` run never clears a failed `push` run and another app's failed check is
 * never cleared at all - and only when every run still counting has a result
 * `rollUpChecks` recognises: a conclusion GitHub calls a failure and this code does not know
 * must not read as a pass here.
 */
function checksOf(rollup: { state?: unknown; contexts?: unknown } | null | undefined): ChecksState {
  const github = toChecks(rollup?.state);
  if (github !== "failing") return github;
  const contexts = rollup?.contexts as { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | null | undefined;
  if (contexts?.pageInfo?.hasNextPage !== false || !Array.isArray(contexts.nodes)) return github;
  const current = rollUpChecks(contexts.nodes);
  return current.retriedFailure && current.recognized && current.checks !== null ? current.checks : github;
}

function isPrState(value: unknown): value is PrSnapshot["state"] {
  return value === "OPEN" || value === "CLOSED" || value === "MERGED";
}

function toSnapshot(pr: Record<string, unknown>, state: PrSnapshot["state"]): PrSnapshot {
  const reviewPage = toReviewPage(pr.reviews);
  const firstThreads = threadPage(pr.reviewThreads);
  const headCommit = (
    ((pr.commits as { nodes?: unknown[] } | undefined)?.nodes ?? []) as {
      commit?: { statusCheckRollup?: { state?: unknown; contexts?: unknown } | null };
    }[]
  )[0]?.commit;
  const createdAt = Date.parse(String(pr.createdAt ?? ""));
  return {
    state,
    headSha: typeof pr.headRefOid === "string" ? pr.headRefOid : "",
    headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "",
    ...refFields(pr),
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    isDraft: pr.isDraft === true,
    createdAt: Number.isNaN(createdAt) ? null : createdAt,
    // An unrecognised value is UNKNOWN, which the gate refuses to merge on - the same
    // answer as GitHub still computing it, and the right one for a value we cannot read.
    mergeable:
      pr.mergeable === "MERGEABLE" || pr.mergeable === "CONFLICTING"
        ? (pr.mergeable as MergeableState)
        : "UNKNOWN",
    reviewDecision:
      pr.reviewDecision === "APPROVED" ||
      pr.reviewDecision === "CHANGES_REQUESTED" ||
      pr.reviewDecision === "REVIEW_REQUIRED"
        ? (pr.reviewDecision as ReviewDecision)
        : null,
    checks: checksOf(headCommit?.statusCheckRollup),
    threads: firstThreads.threads,
    threadError: firstThreads.error
      ?? (typeof pr.isDraft !== "boolean"
        || typeof pr.headRefOid !== "string" || !pr.headRefOid ? "Missing PR identity or state" : null),
    threadsPageInfo: threadPageInfo(pr.reviewThreads),
    reviews: reviewPage.reviews,
    reviewsPageInfo: reviewPage.pageInfo,
  };
}

/** The base, default branch and merge commit of one GraphQL pull request node. */
function refFields(
  pr: Record<string, unknown>,
): { baseRefName: string; baseSha: string; defaultBranch: string; mergeCommitSha: string | null; mergedAt: number | null } {
  const mergeCommit = (pr.mergeCommit as { oid?: unknown } | null | undefined)?.oid;
  const defaultBranch = (
    (pr.repository as { defaultBranchRef?: { name?: unknown } | null } | null | undefined)?.defaultBranchRef
  )?.name;
  const mergedAt = typeof pr.mergedAt === "string" ? Date.parse(pr.mergedAt) : Number.NaN;
  return {
    baseRefName: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
    baseSha: typeof pr.baseRefOid === "string" ? pr.baseRefOid : "",
    defaultBranch: typeof defaultBranch === "string" ? defaultBranch : "",
    mergeCommitSha: typeof mergeCommit === "string" && mergeCommit ? mergeCommit : null,
    mergedAt: Number.isFinite(mergedAt) ? mergedAt : null,
  };
}

/**
 * The few facts about a pull request that stacking needs, without its threads or reviews.
 *
 * Read for a pull request the Inspector does not otherwise poll this instant: a stacked
 * dispatch revalidating its parent, the release check reading the current parent, and base
 * correction on adoption. One small GraphQL call each.
 */
export interface PrRefs {
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headSha: string;
  headRefName: string;
  baseRefName: string;
  /** The base branch's tip. Optional only so hand-built fixtures stay valid. */
  baseSha?: string;
  defaultBranch: string;
  mergeCommitSha: string | null;
  /** When it merged (epoch ms). Optional only so hand-built fixtures stay valid. */
  mergedAt?: number | null;
}

const PR_REFS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      state isDraft headRefOid headRefName baseRefName baseRefOid mergeCommit{ oid } mergedAt
      repository{ defaultBranchRef{ name } }
    }
  }
}`;

export async function fetchPrRefs(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
): Promise<GhResult<PrRefs>> {
  const res = await run(
    ghBin(),
    ["api", "graphql", "-f", `query=${PR_REFS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api graphql (pull request refs)", res);
  try {
    const json = JSON.parse(res.stdout) as {
      data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null };
      errors?: { message?: string }[];
    };
    if (json.errors?.length) return { ok: false, error: `graphql: ${json.errors.map((e) => e.message).join("; ")}` };
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return { ok: false, error: "no such pull request" };
    const state = pr.state;
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
      return { ok: false, error: "the pull request state was not reported" };
    }
    if (typeof pr.headRefOid !== "string" || !pr.headRefOid || typeof pr.isDraft !== "boolean") {
      return { ok: false, error: "the pull request head was not reported" };
    }
    return {
      ok: true,
      value: {
        state,
        isDraft: pr.isDraft,
        headSha: pr.headRefOid,
        headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "",
        ...refFields(pr),
      },
    };
  } catch (err) {
    return { ok: false, error: `could not parse gh output: ${String(err)}` };
  }
}

/**
 * Is `ancestor` in `head`'s history? GitHub's compare API answers from the remote, so no
 * git runs in any worktree: `ahead` or `identical` means yes, `behind` or `diverged` means
 * no, and anything else (a failed call, a commit GitHub does not know) is unknown.
 */
export async function isAncestor(
  cwd: string | null,
  owner: string,
  repo: string,
  ancestor: string,
  head: string,
): Promise<GhResult<boolean>> {
  const res = await run(
    ghBin(),
    ["api", `repos/${owner}/${repo}/compare/${ancestor}...${head}`, "--jq", ".status"],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api (compare)", res);
  const status = res.stdout.trim();
  if (status === "ahead" || status === "identical") return { ok: true, value: true };
  if (status === "behind" || status === "diverged") return { ok: true, value: false };
  return { ok: false, error: `compare reported an unrecognized status "${status.slice(0, 40)}"` };
}

/**
 * How far `head` is from `base`, per GitHub's compare API: whether `base` is in `head`'s
 * history (`ahead` or `identical`), and how many of `base`'s commits `head` lacks.
 *
 * Generic on purpose - a stacked child behind its parent's branch and a pull request behind
 * its default branch are the same question - so nothing here names a stack. `behindBy` is null
 * when GitHub did not report a count. A read; no git runs in any worktree.
 */
export interface BaseComparison {
  /** Is `base` in `head`'s history? */
  contains: boolean;
  behindBy: number | null;
}

export async function compareCommits(
  cwd: string | null,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<GhResult<BaseComparison>> {
  const res = await run(
    ghBin(),
    ["api", `repos/${owner}/${repo}/compare/${base}...${head}`, "--jq", '.status + " " + (.behind_by | tostring)'],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api (compare)", res);
  const [status = "", count = ""] = res.stdout.trim().split(/\s+/);
  const behindBy = /^\d+$/.test(count) ? Number(count) : null;
  if (status === "ahead" || status === "identical") return { ok: true, value: { contains: true, behindBy: behindBy ?? 0 } };
  if (status === "behind" || status === "diverged") return { ok: true, value: { contains: false, behindBy } };
  return { ok: false, error: `compare reported an unrecognized status "${status.slice(0, 40)}"` };
}

/**
 * The merge base of two commits, per GitHub's compare API: the commit a pull request from
 * `head` onto `base` is diffed from. A read; no git runs in any worktree. An unknown commit
 * or an answer that is not a commit id is a failure, never a guess.
 */
export async function mergeBase(
  cwd: string | null,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<GhResult<string>> {
  const res = await run(
    ghBin(),
    ["api", `repos/${owner}/${repo}/compare/${base}...${head}`, "--jq", ".merge_base_commit.sha"],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api (compare merge base)", res);
  const sha = res.stdout.trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    return { ok: false, error: `compare reported no merge base ("${sha.slice(0, 40)}")` };
  }
  return { ok: true, value: sha };
}

/**
 * Change the branch a pull request targets. Metadata only: it writes no commit and moves no
 * branch, so it is the one GitHub write stacking makes on its own. REST, in the same `gh api`
 * style as `mergePr`.
 */
export async function retargetPr(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  base: string,
): Promise<GhResult<void>> {
  const res = await run(
    ghBin(),
    ["api", "--method", "PATCH", `repos/${owner}/${repo}/pulls/${number}`, "--input", "-"],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS, input: JSON.stringify({ base }) },
  );
  if (res.code !== 0) return fail("gh api (retarget pull request)", res);
  return { ok: true };
}

/** A link GitHub reported, or null for anything that is not a non-empty string. */
function linkOf(raw: unknown): string | null {
  return typeof raw === "string" && raw ? raw : null;
}

function threadPageInfo(raw: unknown): ThreadPageInfo {
  const pageInfo = (raw as { pageInfo?: Record<string, unknown> } | null)?.pageInfo;
  return {
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : null,
  };
}

function issueCommentPage(raw: unknown): IssueCommentPage {
  const parsed = z.object({
    nodes: z.array(IssueCommentSchema).max(GITHUB_PAGE_SIZE),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }).safeParse(raw);
  return parsed.success
    ? { comments: parsed.data.nodes, pageInfo: parsed.data.pageInfo }
    : { comments: [], pageInfo: { hasNextPage: false, endCursor: null }, error: "Incomplete issue-comment connection or identity" };
}

const ThreadRootCommentSchema = z.object({
  id: z.string().min(1), url: z.string().url(), body: z.string(), updatedAt: z.string().datetime(),
  author: z.object({ __typename: z.string().min(1), login: z.string().min(1) }),
});
const ThreadConnectionSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1), isResolved: z.boolean(), path: z.string().nullable(),
    // The first snapshot requests a full page; later pages request only the root.
    // Later comments may have deleted authors, so only root identity is required.
    comments: z.object({ nodes: z.array(z.unknown()).min(1).max(GITHUB_PAGE_SIZE)
      .refine(nodes => ThreadRootCommentSchema.safeParse(nodes[0]).success, "Invalid review-thread root identity") }),
  })).max(GITHUB_PAGE_SIZE),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});

function threadPage(raw: unknown): ThreadPage {
  const connection = (raw ?? {}) as { nodes?: unknown[] };
  const parsed = ThreadConnectionSchema.safeParse(raw);
  // Refuse oversized pages before the tolerant history projection copies their entries.
  // Other malformed pages still retain partial history, with an explicit read error.
  if (!parsed.success && parsed.error.issues.some(issue => issue.code === "too_big")) {
    return { threads: [], pageInfo: threadPageInfo(connection), error: "Incomplete review-thread connection or root identity" };
  }
  const threads = (connection.nodes ?? []).filter(Boolean).map((rawThread) => {
    const thread = rawThread as Record<string, unknown>;
    const comments = ((thread.comments as { nodes?: unknown[] } | undefined)?.nodes ?? []) as unknown[];
    return {
      id: String(thread.id ?? ""),
      isResolved: thread.isResolved === true,
      path: typeof thread.path === "string" ? thread.path : null,
      comments: comments.filter(Boolean).map((rawComment) => {
        const comment = rawComment as Record<string, unknown>;
        return {
          id: typeof comment.id === "string" ? comment.id : undefined,
          updatedAt: typeof comment.updatedAt === "string" ? comment.updatedAt : undefined,
          actorType: typeof (comment.author as { __typename?: unknown } | null)?.__typename === "string"
            ? (comment.author as { __typename: string }).__typename : null,
          databaseId: typeof comment.databaseId === "number" ? comment.databaseId : null,
          url: linkOf(comment.url),
          body: typeof comment.body === "string" ? comment.body : "",
          author: String((comment.author as { login?: unknown } | null)?.login ?? "unknown"),
          createdAt: String(comment.createdAt ?? ""),
        };
      }),
    } satisfies ThreadSnapshot;
  });
  return { threads, pageInfo: threadPageInfo(connection), error: parsed.success ? null : "Incomplete review-thread connection or root identity" };
}

function toReviewPage(raw: unknown): ReviewPage {
  const connection = (raw ?? {}) as {
    nodes?: unknown[];
    pageInfo?: { hasPreviousPage?: unknown; startCursor?: unknown };
  };
  if (Array.isArray(connection.nodes) && connection.nodes.length > GITHUB_PAGE_SIZE) {
    throw new Error(`Pull request review page exceeds ${GITHUB_PAGE_SIZE} entries`);
  }
  return {
    reviews: (connection.nodes ?? []).filter(Boolean).map((item) => {
      const review = item as Record<string, unknown>;
      return {
        url: linkOf(review.url),
        body: typeof review.body === "string" ? review.body : "",
        author: String((review.author as { login?: unknown } | null)?.login ?? "unknown"),
        headSha: String((review.commit as { oid?: unknown } | null)?.oid ?? ""),
      };
    }),
    pageInfo: {
      hasPreviousPage: connection.pageInfo?.hasPreviousPage === true,
      startCursor:
        typeof connection.pageInfo?.startCursor === "string"
          ? connection.pageInfo.startCursor
          : null,
    },
  };
}

/**
 * One earlier page of reviews, for the traversals that read past the snapshot's newest
 * hundred. Exported so the worker can see the pages its clean-review traversals load,
 * and take the links on them, without reading any page a second time.
 */
export async function fetchReviewPage(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  before: string,
): Promise<GhResult<ReviewPage>> {
  const res = await run(
    ghBin(),
    [
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_PAGE_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${repo}`,
      "-F",
      `number=${number}`,
      "-F",
      `before=${before}`,
    ],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api graphql (reviews)", res);
  try {
    const json = JSON.parse(res.stdout) as {
      data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null };
      errors?: { message?: string }[];
    };
    if (json.errors?.length) {
      return { ok: false, error: `graphql: ${json.errors.map((e) => e.message).join("; ")}` };
    }
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return { ok: false, error: "no such pull request" };
    return { ok: true, value: toReviewPage(pr.reviews) };
  } catch (err) {
    return { ok: false, error: `could not parse gh review output: ${String(err)}` };
  }
}

/**
 * One later page of review threads, past the snapshot's first hundred. Exported for the
 * same reason as `fetchReviewPage`.
 */
export async function fetchThreadPage(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  after: string,
  timeoutMs = GH_TIMEOUT_MS,
): Promise<GhResult<ThreadPage>> {
  const res = await run(
    ghBin(),
    [
      "api", "graphql", "-f", `query=${THREAD_PAGE_QUERY}`, "-F", `owner=${owner}`,
      "-F", `name=${repo}`, "-F", `number=${number}`, "-F", `after=${after}`,
    ],
    { cwd: cwd ?? undefined, timeoutMs: Math.min(timeoutMs, GH_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024 },
  );
  if (res.code !== 0 || res.overflowed) return fail("gh api graphql (review threads)", res);
  try {
    const json = JSON.parse(res.stdout) as {
      data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null };
      errors?: { message?: string }[];
    };
    if (json.errors?.length) return { ok: false, error: `graphql: ${json.errors.map((e) => e.message).join("; ")}` };
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return { ok: false, error: "no such pull request" };
    return { ok: true, value: { ...threadPage(pr.reviewThreads), responseBytes: utf8Bytes(res.stdout) } };
  } catch (err) {
    return { ok: false, error: `could not parse gh review-thread output: ${String(err)}` };
  }
}

export async function fetchIssueCommentPage(
  cwd: string | null, owner: string, repo: string, number: number, after: string,
  timeoutMs = GH_TIMEOUT_MS,
): Promise<GhResult<IssueCommentPage>> {
  const res = await run(ghBin(), [
    "api", "graphql", "-f", `query=${ISSUE_COMMENT_PAGE_QUERY}`, "-F", `owner=${owner}`,
    "-F", `name=${repo}`, "-F", `number=${number}`, "-F", `after=${after}`,
  ], { cwd: cwd ?? undefined, timeoutMs: Math.min(timeoutMs, GH_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024 });
  if (res.code !== 0 || res.overflowed) return fail("gh api graphql (issue comments)", res);
  try {
    const json = JSON.parse(res.stdout);
    if (json.errors?.length) return { ok: false, error: "graphql: could not read issue comments" };
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return { ok: false, error: "no such pull request" };
    return { ok: true, value: { ...issueCommentPage(pr.comments), responseBytes: utf8Bytes(res.stdout) } };
  } catch {
    return { ok: false, error: "could not parse gh issue-comment output" };
  }
}

type ReviewPageLoader = (before: string) => Promise<GhResult<ReviewPage>>;

export async function cleanReviewExists(
  input: {
    cwd: string | null;
    owner: string;
    repo: string;
    number: number;
    snapshot: Pick<PrSnapshot, "reviews" | "reviewsPageInfo">;
    login: string;
    headSha: string;
  },
  loadPrevious: ReviewPageLoader = (before) =>
    fetchReviewPage(input.cwd, input.owner, input.repo, input.number, before),
): Promise<GhResult<boolean>> {
  let page: ReviewPage = {
    reviews: input.snapshot.reviews,
    pageInfo: input.snapshot.reviewsPageInfo,
  };
  const cursors = new Set<string>();
  while (true) {
    if (page.reviews.some((review) => isCleanReview(review, input.login, input.headSha))) {
      return { ok: true, value: true };
    }
    if (!page.pageInfo.hasPreviousPage) return { ok: true, value: false };
    const cursor = page.pageInfo.startCursor;
    if (!cursor || cursors.has(cursor)) {
      return { ok: false, error: "could not traverse the complete pull request review history" };
    }
    cursors.add(cursor);
    const previous = await loadPrevious(cursor);
    if (!previous.ok || !previous.value) {
      return {
        ok: false,
        error: previous.error ?? "could not read an earlier pull request review page",
        outcomeUnknown: previous.outcomeUnknown,
        tooLarge: previous.tooLarge,
      };
    }
    page = previous.value;
  }
}

/**
 * Body-only findings cannot be resolved as GitHub threads. Their durable marker makes
 * a later clean verdict fail closed, including after the local provenance ledger was
 * lost. The old rendered separator protects reviews created before the marker existed.
 */
export async function hasBodyOnlyFindings(
  input: Parameters<typeof cleanReviewExists>[0],
  loadPrevious: ReviewPageLoader = (before) =>
    fetchReviewPage(input.cwd, input.owner, input.repo, input.number, before),
): Promise<GhResult<boolean>> {
  let page: ReviewPage = {
    reviews: input.snapshot.reviews,
    pageInfo: input.snapshot.reviewsPageInfo,
  };
  const cursors = new Set<string>();
  while (true) {
    const found = page.reviews.some(
      (review) =>
        (isOurs(review, input.login) && review.body.includes(BODY_ONLY_FINDINGS_MARKER)) ||
        (review.author === input.login &&
          (
            review.body.startsWith("**⌕ Inspector** · round") ||
            review.body.startsWith("**⌕ GitHub Inspector** · round")
          ) &&
          review.body.includes("\n---\n")),
    );
    if (found) return { ok: true, value: true };
    if (!page.pageInfo.hasPreviousPage) return { ok: true, value: false };
    const cursor = page.pageInfo.startCursor;
    if (!cursor || cursors.has(cursor)) {
      return { ok: false, error: "could not traverse the complete pull request review history" };
    }
    cursors.add(cursor);
    const previous = await loadPrevious(cursor);
    if (!previous.ok || !previous.value) {
      return { ok: false, error: previous.error ?? "could not read an earlier pull request review page" };
    }
    page = previous.value;
  }
}

export function allOwnedThreadsResolved(
  snapshot: PrSnapshot,
  login: string,
  resolvedThreadIds: ReadonlySet<string> = new Set(),
): boolean {
  return snapshot.threads.every((thread) => {
    if (thread.isResolved || resolvedThreadIds.has(thread.id)) return true;
    const first = thread.comments[0];
    return !first || !isOurs(first, login);
  });
}

type ThreadPageLoader = (after: string) => Promise<GhResult<ThreadPage>>;

/** Check every owned thread, not merely GitHub's first page, before claiming safety. */
export async function ownedThreadsResolved(
  input: {
    cwd: string | null;
    owner: string;
    repo: string;
    number: number;
    snapshot: Pick<PrSnapshot, "threads" | "threadsPageInfo">;
    login: string;
    resolvedThreadIds: ReadonlySet<string>;
  },
  loadNext: ThreadPageLoader = (after) =>
    fetchThreadPage(input.cwd, input.owner, input.repo, input.number, after),
): Promise<GhResult<boolean>> {
  let threads = input.snapshot.threads;
  let pageInfo = input.snapshot.threadsPageInfo ?? { hasNextPage: false, endCursor: null };
  const cursors = new Set<string>();
  while (true) {
    if (!allOwnedThreadsResolved({ threads } as PrSnapshot, input.login, input.resolvedThreadIds)) {
      return { ok: true, value: false };
    }
    if (!pageInfo.hasNextPage) return { ok: true, value: true };
    const cursor = pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) {
      return { ok: false, error: "could not traverse the complete pull request review-thread history" };
    }
    cursors.add(cursor);
    const next = await loadNext(cursor);
    if (!next.ok || !next.value) {
      return { ok: false, error: next.error ?? "could not read an additional pull request review-thread page" };
    }
    threads = next.value.threads;
    pageInfo = next.value.pageInfo;
  }
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

/** What `findingUrls` needs from a ledger row. */
export type FindingLinkRow = Pick<InspectorComment, "fingerprint" | "line" | "round" | "githubUrl">;

/**
 * The GitHub link each ledger row should now hold, for only the rows whose stored link is
 * missing or different. Read from pages the tick has already loaded, so it costs no call.
 *
 * - **A thread finding** links to the first comment of our thread carrying its marker,
 *   owned by the same two-part `isOurs` rule as `ourThreads`. A finding raised again after
 *   it was resolved has a thread per post, so the one with the highest marker round wins:
 *   the newest post, whatever order GitHub lists the threads in.
 * - **A demoted finding** (`line` null) links to our review for that row's round that
 *   carries the body-only findings marker (`isOurBodyFindingsReview`). The newest one wins
 *   if a round somehow has two. A demoted row with no such review in the snapshot falls
 *   back to its marker thread, which a version raised earlier with a line may have left.
 *
 * A row that matches nothing is left out, so its stored link stays as it is. That is what
 * carries a link forward to a drafted row whose earlier version was posted: the earlier
 * comment either is still seen, giving the same link, or is not, and nothing overwrites it.
 * A null `login` matches nothing, the same fail-closed answer as `ourThreads`.
 *
 * **Partial reads.** `sources` may hold only some of a pull request's threads or reviews:
 * the snapshot's first page, plus whatever continuation pages the tick happened to load.
 * Such a set always FILLS a missing link, but it REPLACES a stored one only when no unread
 * page could change the answer. Otherwise a finding whose older thread is on the first
 * page and newer one on a later page would have its link rewritten back and forth, once
 * per read. The answer is settled when:
 * - a demoted finding's review for its round was found, since a round has one such review;
 * - the newest thread seen carries the row's own round, since no later post can exist;
 * - or every page of that kind was read.
 * A demoted finding falls back to its thread only once every review has been read, because
 * an unread page may still hold its review.
 */
export function findingUrls(
  sources: LinkSources,
  login: string | null,
  rows: Iterable<FindingLinkRow>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!login) return out;
  const threads = newestOwnThreads(sources.threads, login);
  const threadsComplete = sources.threadsComplete ?? true;
  const reviewsComplete = sources.reviewsComplete ?? true;
  for (const row of rows) {
    const review = row.line === null ? bodyFindingsReviewUrl(sources.reviews, login, row.round) : null;
    const thread = threads.get(row.fingerprint);
    let url: string | null;
    let settled: boolean;
    if (review) {
      url = review;
      settled = true;
    } else if (row.line === null && !reviewsComplete) {
      url = null;
      settled = false;
    } else {
      url = thread?.url ?? null;
      settled = threadsComplete || (thread !== undefined && thread.round >= row.round);
    }
    if (!url || url === row.githubUrl) continue;
    if (row.githubUrl && !settled) continue;
    out.set(row.fingerprint, url);
  }
  return out;
}

/**
 * The threads and reviews a tick has read, for `findingUrls`. The completeness flags default
 * to true, which is right for a snapshot that GitHub reported as a single page.
 */
export interface LinkSources {
  threads: readonly ThreadSnapshot[];
  reviews: readonly ReviewSnapshot[];
  /** Every page of review threads was read. */
  threadsComplete?: boolean;
  /** Every page of reviews was read, back to the first. */
  reviewsComplete?: boolean;
}

/** A snapshot's first page as link sources, complete only where GitHub said there is no more. */
export function snapshotLinkSources(snapshot: PrSnapshot): Required<LinkSources> {
  return {
    threads: [...snapshot.threads],
    reviews: [...snapshot.reviews],
    threadsComplete: !snapshot.threadsPageInfo?.hasNextPage,
    reviewsComplete: !snapshot.reviewsPageInfo.hasPreviousPage,
  };
}

/** Our threads with a link, keyed by fingerprint, keeping the highest marker round. */
function newestOwnThreads(
  threads: readonly ThreadSnapshot[],
  login: string,
): Map<string, { url: string; round: number }> {
  const out = new Map<string, { url: string; round: number }>();
  for (const t of threads) {
    const first = t.comments[0];
    if (!first?.url || !isOurs(first, login)) continue;
    const marker = parseMarker(first.body)!;
    const seen = out.get(marker.fingerprint);
    if (!seen || marker.round >= seen.round) out.set(marker.fingerprint, { url: first.url, round: marker.round });
  }
  return out;
}

/** The link of our body-only findings review for `round`, the newest if there are two. */
function bodyFindingsReviewUrl(
  reviews: readonly ReviewSnapshot[],
  login: string,
  round: number,
): string | null {
  let url: string | null = null;
  for (const review of reviews) {
    if (review.url && isOurBodyFindingsReview(review, login, round)) url = review.url;
  }
  return url;
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
    ghBin(),
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
  // BYTES, not code units: `full.slice(0, maxBytes)` charged one unit for a character
  // costing three or four on the wire, so a diff of CJK, emoji or box-drawing content
  // passed 3x the advertised cap into the prompt. See `util/utf8.ts`.
  return {
    ok: true,
    value: { diff: clipUtf8Bytes(full, maxBytes), truncated: utf8Bytes(full) > maxBytes },
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
    ghBin(),
    ["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS, input: payload },
  );
  if (res.code !== 0) return fail("gh api (create review)", res);
  return { ok: true };
}

/**
 * The pull request's current head sha, and nothing else.
 *
 * Exists for one caller: `classifyReviewRefusal`'s moved-head check, made only after GitHub
 * refused a review with a 422. The tick's own `fetchPr` is far larger, and its answer is
 * from before the POST, which is exactly the instant this question is not about.
 */
export async function fetchHeadSha(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
): Promise<GhResult<string>> {
  const res = await run(
    ghBin(),
    ["api", `repos/${owner}/${repo}/pulls/${number}`, "--jq", ".head.sha"],
    { cwd: cwd ?? undefined, timeoutMs: GH_TIMEOUT_MS },
  );
  if (res.code !== 0) return fail("gh api (head)", res);
  const sha = res.stdout.trim();
  return sha ? { ok: true, value: sha } : { ok: false, error: "gh api (head) returned no sha" };
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
    ghBin(),
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
    ghBin(),
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

/**
 * Merge a pull request. The most consequential call in this file by a wide margin.
 *
 * REST rather than `gh pr merge`, for the `sha` parameter alone: it makes the merge a
 * compare-and-swap against the head we evaluated. Without it there is a window - the
 * seconds between the snapshot the gate decided on and this call - in which a push can
 * land, and the merge would take code that no CI run has passed and no review has seen.
 * GitHub answers 409 instead, and the next sweep re-decides against the new head.
 *
 * A refusal (405 "not mergeable", 409 stale sha, branch protection) is reported as an
 * ordinary error and left to the caller to record: unlike a review post, there is no
 * partial state to reconcile - the PR either merged or it did not, and the next sweep
 * reads which from GitHub rather than from anything we stored.
 */
export async function mergePr(
  cwd: string | null,
  owner: string,
  repo: string,
  number: number,
  sha: string,
  method: "squash" | "merge" | "rebase",
): Promise<GhResult<void>> {
  const res = await run(
    ghBin(),
    ["api", "--method", "PUT", `repos/${owner}/${repo}/pulls/${number}/merge`, "--input", "-"],
    {
      cwd: cwd ?? undefined,
      timeoutMs: GH_TIMEOUT_MS,
      input: JSON.stringify({ sha, merge_method: method }),
    },
  );
  if (res.code !== 0) return fail("gh api (merge)", res);
  return { ok: true };
}

/** Render one finding as a comment body: marker first, at column 0. See `marker.ts`. */
export function renderComment(marker: string, c: PlannedComment): string {
  return [
    marker,
    `**⌕ GitHub Inspector** · \`${c.severity}\` · ${c.title}`,
    "",
    c.body,
    "",
    "<sub>Automated review from Mission Control against `INSPECTOR.md`. Reply here to ask a follow-up.</sub>",
  ].join("\n");
}

/** Render the generic top-level review for a round with no remaining findings. */
export function renderCleanReview(marker: string, round: number): string {
  return [
    marker,
    reviewHeader(round),
    "",
    "No further issues found. This pull request is safe to merge.",
  ].join("\n");
}
