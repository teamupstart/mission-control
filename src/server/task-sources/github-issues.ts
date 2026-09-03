import type {
  GithubIssuesConfig,
  PushContext,
  PushDraft,
  PushResult,
  SweepContext,
  SweepResult,
  TaskCandidate,
  TaskSourceImpl,
} from "@shared/task-source.ts";
import { GithubIssuesConfigSchema, TASK_SOURCE_KIND_INFO } from "@shared/task-source.ts";
import type { TaskPriority } from "@shared/types.ts";
import { ghBin } from "../config.ts";
import { githubIssueCreateOutcome } from "../github/issue-create.ts";
import { run } from "../util/exec.ts";
import type { RunResult } from "../util/exec.ts";

// The first task source, and the proof the interface is the right shape.
//
// Auth is the `gh` CLI, run with `cwd` set to the repo - exactly what `src/server/pr.ts`
// already does, which lets `gh` resolve both the repo and the operator's existing
// `gh auth`. This feature therefore adds NO token storage, no OAuth flow and no new
// secret that can leak, which is worth more than the flexibility of an API client.
//
// Nothing here writes to OUR database: `sweep` returns candidates for `ingest.ts` to
// decide on, and `push` returns the ref GitHub minted for its own chokepoint to record.
// That is what keeps this file a pure function over a subprocess's stdout, and testable
// as one.

/** How long one `gh` call may take before it is abandoned. */
const GH_TIMEOUT_MS = 20_000;

/** The fields the mapping below reads, and no more - `gh` returns exactly what you ask for. */
const JSON_FIELDS = "number,title,body,url,labels,assignees,updatedAt";

/** Longest issue body carried into an intent, so one enormous issue can't fill a card. */
const BODY_LIMIT = 4000;

/** One issue, as much of `gh`'s JSON as we read. Everything is optional: it is a wire shape. */
interface GhIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  url?: unknown;
  labels?: unknown;
}

/**
 * The `gh issue list` argv for this config.
 *
 * Split out and exported because it is the half worth testing: a filter that quietly
 * matches nothing looks exactly like a repo with no open issues, and a background sweep
 * gives nobody the chance to notice. The awkward part is that `--label` is AND (an issue
 * must carry every one you pass), while the config asks for ANY - so more than one label
 * has to go through `--search`, where GitHub's comma is OR.
 */
export function ghIssueListArgs(cfg: GithubIssuesConfig): string[] {
  const args = ["issue", "list", "--state", "open", "--limit", String(cfg.limit)];
  if (cfg.repo) args.push("--repo", cfg.repo);

  const search: string[] = [];
  if (cfg.labelsAny.length === 1) {
    // One label needs no search syntax, so it also needs no quoting rules - and a label
    // with a comma in it (`Type: Bug, maybe`) survives here where `label:a,b` would split it.
    args.push("--label", cfg.labelsAny[0]!);
  } else if (cfg.labelsAny.length > 1) {
    search.push(`label:${cfg.labelsAny.map(quoteTerm).join(",")}`);
  }
  if (cfg.assignedToMe) args.push("--assignee", "@me");
  // `--assignee` has no "nobody" spelling, so the unassigned sweep is a search term. The
  // schema has already refused the pair, so this can never fight the flag above.
  if (cfg.unassignedOnly) search.push("no:assignee");
  if (cfg.milestone) args.push("--milestone", cfg.milestone);
  if (search.length > 0) args.push("--search", search.join(" "));

  args.push("--json", JSON_FIELDS);
  return args;
}

/** Quote a search term when it holds anything GitHub's query syntax would split on. */
function quoteTerm(t: string): string {
  return /[\s,":]/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
}

/**
 * `owner/repo#123` from an issue URL.
 *
 * Taken from the URL rather than composed from the configured `repo` so the id is stable
 * even if `repo` is later reconfigured or left empty - and identity is the one thing that
 * must not move, since a changed `externalId` re-files an issue that is already in the
 * backlog. An unparseable URL falls back to the URL ITSELF, which is equally stable and
 * unique; anything derived from the issue number alone would not be.
 */
export function externalIdFor(url: string): string {
  const m = /github\.[^/]+\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
}

/** An issue's label names, in the order GitHub returned them. */
function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (l as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * The priority this issue's labels ask for, or null to fall back to the source's default.
 *
 * The ISSUE's label order decides, not the map's: an issue carrying both `P0` and `P1`
 * has whichever GitHub lists first, and iterating the map instead would make the answer
 * depend on key insertion order in a config blob nobody thinks of as ordered. Matched
 * case-insensitively, because a mapping typed as `p0` should still catch `P0`.
 */
export function priorityFor(
  labels: string[],
  map: Record<string, TaskPriority>,
): TaskPriority | null {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  for (const l of labels) {
    const hit = lower.get(l.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * One issue as a candidate task.
 *
 * The intent is a BRIEF, not the raw record: it names the issue, links it, and carries
 * its body, so the agent's first prompt has the actual text rather than a number it would
 * have to go and look up. Deciding what an issue's intent should say is the part that
 * needs judgement, and it is the part a source is uniquely able to do.
 */
export function candidateFrom(
  issue: GhIssue,
  cfg: GithubIssuesConfig,
  ctx: SweepContext,
): TaskCandidate | null {
  const url = typeof issue.url === "string" ? issue.url : "";
  const title = typeof issue.title === "string" ? issue.title.trim() : "";
  if (!url || !title) return null; // a row we cannot name or link back is not a task

  const number = typeof issue.number === "number" ? issue.number : null;
  const body = typeof issue.body === "string" ? issue.body.trim() : "";
  const labels = labelNames(issue.labels);
  const head = number === null ? `GitHub issue: ${title}` : `GitHub issue #${number}: ${title}`;
  const trimmed =
    body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n\n[issue body truncated]` : body;

  // OMITTED, not null, when no mapping matched - and the difference is the whole
  // behaviour of the source's default priority. `null` on a candidate means "this item
  // deliberately has no priority" and ingest honours it; an absent key means "I have no
  // opinion", which is what lets the source's default apply. Setting null here made every
  // swept task unset no matter what the operator chose.
  const mapped = priorityFor(labels, cfg.priorityFrom);

  return {
    ref: { sourceId: ctx.sourceId, externalId: externalIdFor(url), url },
    title,
    intent: [head, url, "", trimmed || "(the issue has no description)"].join("\n"),
    repoRoot: ctx.repoRoot,
    ...(mapped ? { priority: mapped } : {}),
    // `normalizeLabels` runs on the way in through `DispatchSchema` (see `ingest.ts`), and
    // it preserves case on purpose - `Type: Bug` has to keep matching the issue it came from.
    labels: cfg.copyLabels ? labels : [],
  };
}

/**
 * Read one `gh issue list` run as a sweep result.
 *
 * The half worth testing, and the rule it exists to hold: a non-zero exit becomes
 * `{items: [], error}` and NEVER an empty success. A `gh` that is missing,
 * unauthenticated or rate-limited must not read as "there is no work" - an empty sweep is
 * indistinguishable from a healthy quiet one, and would sit there silently for as long as
 * it takes somebody to wonder why the backlog stopped growing.
 */
export function sweepResultFrom(
  res: Pick<RunResult, "stdout" | "stderr" | "code">,
  cfg: GithubIssuesConfig,
  ctx: SweepContext,
): SweepResult {
  if (res.code !== 0) {
    const why = (res.stderr || res.stdout).trim().split("\n")[0] ?? "";
    return { items: [], error: `gh issue list failed${why ? `: ${why}` : ""}` };
  }
  if (ctx.signal.aborted) return { items: [], error: "the sweep was abandoned" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout || "[]");
  } catch {
    return { items: [], error: "gh returned output that is not JSON" };
  }
  // Malformed output is an anomaly, not "no issues" - the same reading `pr.ts` takes.
  if (!Array.isArray(parsed)) return { items: [], error: "gh returned an unexpected shape" };

  const items = parsed
    .map((i) => candidateFrom(i as GhIssue, cfg, ctx))
    .filter((c): c is TaskCandidate => c !== null);
  return { items, error: null };
}

/** Ask `gh` for the open issues this config selects, from inside the repo's checkout. */
async function sweep(cfg: GithubIssuesConfig, ctx: SweepContext): Promise<SweepResult> {
  const res = await run(ghBin(), ghIssueListArgs(cfg), {
    cwd: ctx.repoRoot,
    timeoutMs: GH_TIMEOUT_MS,
  });
  return sweepResultFrom(res, cfg, ctx);
}

/**
 * "Can this run at all?" - null when fine, else a sentence naming the fix.
 *
 * Separate from `sweep` so the settings panel can tell a MISCONFIGURED source from an
 * empty one, which is the difference between "you have nothing to do" and "this has been
 * silently broken since you set it up".
 */
async function preflight(cfg: GithubIssuesConfig, ctx: SweepContext): Promise<string | null> {
  const auth = await run(ghBin(), ["auth", "status"], { cwd: ctx.repoRoot, timeoutMs: 10_000 });
  if (auth.code !== 0) {
    return auth.stderr.includes("not found") || auth.code === 127
      ? "the gh CLI is not installed - install it and run `gh auth login`"
      : "gh is not authenticated - run `gh auth login`";
  }
  // Ask for zero issues: this proves the repo resolves and is readable under that auth
  // without spending a page of results, and it exercises the same filters the sweep will.
  const probe = await run(ghBin(), [...ghIssueListArgs({ ...cfg, limit: 1 })], {
    cwd: ctx.repoRoot,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (probe.code !== 0) {
    const why = (probe.stderr || probe.stdout).trim().split("\n")[0] ?? "";
    return `gh cannot list issues here${why ? ` - ${why}` : ""}`;
  }
  return null;
}

// ---- the outward half: one of our tasks, filed as an issue ----

/**
 * The `gh issue create` argv for this config and draft.
 *
 * The labels are the source's OWN sweep filter (`labelsAny`), which is the point rather
 * than a convenience: an issue created without them would not match the filter this
 * source sweeps, so the same repo would show the issue to everyone else and hide it from
 * the source that filed it. Here `--label` repeated is exactly right - the sweep needs
 * ANY of the labels and had to fight the flag's AND semantics, but a created issue simply
 * carries all of them.
 *
 * An argv ARRAY, handed to `execFile`, so no shell parses it: a title with a backtick, a
 * body with `$(…)`, a label with a space are all passed through as written. There are no
 * quoting rules to get wrong because there is no quoting.
 *
 * A label the repo does not define makes `gh` fail the whole command rather than create
 * an unlabelled issue, and that is the behaviour we want - nothing was published, the
 * error names the label, and the operator fixes either the repo or the source's filter.
 */
export function ghIssueCreateArgs(cfg: GithubIssuesConfig, draft: PushDraft): string[] {
  return [
    "issue",
    "create",
    "--title",
    draft.title,
    "--body",
    draft.intent,
    ...(cfg.repo ? ["--repo", cfg.repo] : []),
    ...cfg.labelsAny.flatMap((l) => ["--label", l]),
  ];
}

/**
 * Read one `gh issue create` run as a push result.
 *
 * The half worth testing, and unlike `sweepResultFrom` it has THREE outcomes to tell
 * apart rather than two. A sweep that fails retracts nothing, so "it failed" is a
 * complete answer. A create that fails either published an issue or did not, and the
 * caller's correct response differs: retry, or go and look. Mapping a dead `gh` to a
 * plain refusal is how a retry files the same issue twice.
 *
 * The rules, in order:
 *
 *  1. The child never reported its own exit (`outcomeUnknown`) - our timeout, the OOM
 *     killer, a signal. GitHub may well have taken the request first. Unknown.
 *  2. A URL for the target repository on stdout proves creation. This includes gh 2.99's
 *     non-zero partial-attachment outcome; task-source pushes do not attach files, but the
 *     shared classifier must preserve the external side effect if one is reported.
 *  3. A non-zero exit without that URL is a refusal, so a retry is safe. This is where a
 *     nonexistent `--label` surfaces, loudly.
 *  4. Exit 0 with a matching URL on stdout. The URL is the identity - read
 *     through `externalIdFor`, the same function the sweep uses, so an issue pushed today
 *     and swept tomorrow has one id and is not filed twice.
 *  5. Exit 0 with no matching issue URL. `gh` says it worked, so the issue almost
 *     certainly exists, but we cannot name it - which is a worse position than a failure,
 *     not a better one. Unknown, never success and never a retryable refusal.
 */
export function pushResultFrom(
  res: RunResult,
  ctx: PushContext,
  expectedRepo: string,
): PushResult {
  const outcome = githubIssueCreateOutcome(res, expectedRepo);
  switch (outcome.kind) {
    case "created":
      return {
        ref: {
          sourceId: ctx.sourceId,
          externalId: externalIdFor(outcome.url),
          url: outcome.url,
        },
        error: null,
        outcomeUnknown: false,
      };
    case "refused":
      return {
        ref: null,
        error: `gh issue create failed${outcome.detail ? `: ${outcome.detail}` : ""}`,
        outcomeUnknown: false,
      };
    case "unknown":
      return {
        ref: null,
        error:
          outcome.reason === "process"
            ? "gh issue create did not report back - the issue may exist; check GitHub before retrying"
            : "gh issue create reported success but printed no issue URL - the issue may exist; check GitHub before retrying",
        outcomeUnknown: true,
      };
  }
}

/**
 * File one task as an open issue, from inside the repo's checkout.
 *
 * `ctx.signal` is deliberately NOT read, and the omission is the careful choice rather
 * than the lazy one. `sweep` checks it after its subprocess returns because a sweep that
 * arrives late can simply be dropped - it retracted nothing. A push cannot be dropped
 * that way: by the time an abort could be observed, `gh` has already run, and an issue
 * may exist. `run()` has no cancellation parameter either, so a signal check could only
 * ever mislabel a completed action. `GH_TIMEOUT_MS` and the caller's in-flight guard are
 * the real bounds.
 *
 * If a post-run aborted check is ever added here, it must read as `outcomeUnknown: true`
 * - the create may have landed - and never as a refusal.
 */
async function push(
  cfg: GithubIssuesConfig,
  draft: PushDraft,
  ctx: PushContext,
): Promise<PushResult> {
  const res = await run(ghBin(), ghIssueCreateArgs(cfg, draft), {
    cwd: ctx.repoRoot,
    timeoutMs: GH_TIMEOUT_MS,
  });
  return pushResultFrom(res, ctx, cfg.repo);
}

export const githubIssues: TaskSourceImpl<GithubIssuesConfig> = {
  // Spread rather than restated: the kind, the name and the blurb are the half the
  // settings panel renders in the browser, and it cannot import this file. The schema is
  // re-named only to recover its type - it is the same object.
  ...TASK_SOURCE_KIND_INFO["github-issues"],
  configSchema: GithubIssuesConfigSchema,
  preflight,
  sweep,
  // Present because the kind's `canPush` says so - the contract test holds the two
  // together in both directions.
  push,
};
