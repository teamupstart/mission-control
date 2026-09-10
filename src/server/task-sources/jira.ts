import type {
  JiraConfig,
  SweepContext,
  SweepResult,
  TaskCandidate,
  TaskSourceImpl,
  WritebackNotice,
  WritebackResult,
} from "@shared/task-source.ts";
import {
  DEFAULT_JIRA_SITE,
  JiraConfigSchema,
  TASK_SOURCE_KIND_INFO,
} from "@shared/task-source.ts";
import type { TaskPriority } from "@shared/types.ts";
import {
  runClaudeToolTrace,
  type ClaudeRunOptions,
  type ClaudeToolTrace,
} from "../claude-cli.ts";
import { jiraBin } from "../config.ts";
import { defaultEnvironmentDeps } from "../environment/index.ts";
import { upstartclawCoreReady } from "../environment/upstartclaw.ts";
import { hasBin, run } from "../util/exec.ts";
import type { RunResult } from "../util/exec.ts";

// The second task source: a JQL filter as a backlog queue.
//
// Auth is a LADDER, and no rung of it stores a secret. The operator's own `jira` CLI
// (`ankitpokhrel/jira-cli`) is tried first - it is the standard install in Upstart's
// onboarding docs, it already knows the site and the login, and using it is the same trade
// the GitHub source makes with `gh`. When it is absent (or present and unusable) the sweep
// falls back to Jira's REST API with `JIRA_API_TOKEN` + `JIRA_EMAIL` read from the daemon's
// own environment - the convention those same operators already have exported. A source can
// instead explicitly select UpstartClaw, which runs the same JQL through the installed Jira
// skill and its read-only Atlassian MCP search tool. Nothing is written to `app_config`, so
// there is no token in this app's database to leak.
//
// The rule the whole file is arranged around: a credential that is missing, half-set or
// rejected must arrive as a SENTENCE NAMING THE FIX, never as an empty sweep. An empty
// sweep is indistinguishable from a filter with no matching issues, and would sit there
// silently for as long as it takes somebody to wonder why the backlog stopped growing. So
// every failure below returns `{items: [], error}`, and `preflight` says which rung broke.
//
// Nothing here writes: `sweep` returns candidates and `ingest.ts` decides.

/** How long one Jira query may take before it is abandoned, on either rung. */
const JIRA_TIMEOUT_MS = 20_000;
/** A cold Claude run has to load one skill, discover one deferred tool, and call it. */
const UPSTARTCLAW_TIMEOUT_MS = 90_000;

/** Longest description carried into an intent, so one enormous issue can't fill a card. */
const BODY_LIMIT = 4000;

/** The fields the mapping below reads, and no more. */
const REST_FIELDS = "summary,description,priority";

/**
 * Jira's enhanced search endpoint.
 *
 * `/rest/api/3/search` - what a 2024 recipe reaches for, and what this phase's plan named -
 * is retired on Jira Cloud in favour of this one, which takes the same `jql` and returns
 * the same `{issues: […]}` envelope with token pagination instead of `startAt`.
 */
const REST_SEARCH_PATH = "/rest/api/3/search/jql";

/**
 * Most issues ONE sweep will look at, however many the filter matches.
 *
 * A REST sweep walks pages until the filter is exhausted rather than reading only the first one,
 * and this is why it can stop. The first draft did not page at all, which was wrong in a way
 * worth writing down: `cfg.limit` issues were fetched, `ingest.ts` de-duplicated them against
 * `task_source_seen`, and every later sweep re-fetched the SAME leading page and reported it
 * as already filed. A filter matching more than one page could never reach the rest of itself
 * - not slowly, but never - and since the sweep looked healthy and filed nothing, it was
 * indistinguishable from an upstream with no new work. That is the exact failure this whole
 * file is arranged against.
 *
 * A ceiling is still needed, because "walk until exhausted" against a filter matching 40,000
 * issues is not a background job. Hitting it is reported (`sweepResultFromWalk`) rather than
 * silently truncated, because a filter this source cannot see the end of has a tail that is
 * unreachable however many times it runs, and the fix - narrow the JQL - is the operator's.
 *
 * This is a HARD cap on what one sweep processes, and the advisory sentence quotes it, so nothing
 * may exceed it - which is why `appendCapped` clips a page on the way in rather than letting
 * `nextPage` notice one page too late.
 */
const MAX_SWEEP_ISSUES = 1000;

/**
 * Most PAGE requests one sweep may spend, whatever page size is configured.
 *
 * The issue ceiling alone is not a bound on work: at a page size of 1 it would authorise a
 * thousand round trips. Both bounds are needed, and whichever is reached first stops the walk and
 * reports the tail as out of reach.
 *
 * This bounds the REST and UpstartClaw rungs. The CLI reads once.
 */
const MAX_SWEEP_PAGES = 50;

/** What to say when there is no way to reach Jira at all. Names BOTH fixes. */
const NO_PATH =
  "no way to reach Jira: install the CLI (`brew install ankitpokhrel/jira-cli/jira-cli` " +
  "then `jira init`), or set JIRA_API_TOKEN and JIRA_EMAIL in the daemon's environment";

/** What to say about an empty filter, which is storable but unusable. */
const NO_JQL = "set a JQL query in this source's settings - an empty filter sweeps nothing";

/** The exact skill and compatible read-only JQL registrations shipped by Upstart extensions. */
export const UPSTARTCLAW_JIRA_SKILL = "upstartclaw-core:working-with-jira";
export const UPSTARTCLAW_JQL_TOOLS = [
  "mcp__plugin_upstartclaw-core_atlassian__searchJiraIssuesUsingJql",
  "mcp__atlassian__searchJiraIssuesUsingJql",
  "mcp__jira__searchJiraIssuesUsingJql",
  "mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql",
  "mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql",
] as const;
/** The original registration, retained as the default in fixtures and callers. */
export const UPSTARTCLAW_JQL_TOOL = UPSTARTCLAW_JQL_TOOLS[0];
const UPSTARTCLAW_JQL_TOOL_SET = new Set<string>(UPSTARTCLAW_JQL_TOOLS);
const UPSTARTCLAW_CLOUD_ID = "d30daf5c-29ad-4817-bd10-bdd85ae8455f";
const UPSTARTCLAW_TOOLS = ["Skill", "ToolSearch", ...UPSTARTCLAW_JQL_TOOLS].join(",");

/** One issue, as much of Jira's JSON as we read. Everything is optional: it is a wire shape. */
export interface JiraIssue {
  key?: unknown;
  /** The API URL of the issue. Read only for its HOST - see `browseUrlFor`. */
  self?: unknown;
  fields?: unknown;
}

/** The `JIRA_EMAIL` + `JIRA_API_TOKEN` pair the REST rung needs, when both are present. */
export interface JiraRestCredential {
  email: string;
  token: string;
}

/**
 * The REST credential in this environment, or null when it is not (fully) there.
 *
 * Takes the env as an argument rather than reading `process.env`, so the tests that pin
 * the half-configured cases do not have to mutate a global to state them.
 */
export function restCredentialFrom(env: NodeJS.ProcessEnv): JiraRestCredential | null {
  const token = (env.JIRA_API_TOKEN ?? "").trim();
  const email = (env.JIRA_EMAIL ?? "").trim();
  return token && email ? { email, token } : null;
}

/**
 * "One of the two is set" - the misconfiguration that looks like configuration.
 *
 * Half a credential is the case worth naming out loud: the operator believes Jira is wired
 * up, `restCredentialFrom` says no, and without this the panel would report the generic
 * "install the CLI or set both" and send them looking for something they already did.
 */
export function credentialGap(env: NodeJS.ProcessEnv): string | null {
  const token = (env.JIRA_API_TOKEN ?? "").trim();
  const email = (env.JIRA_EMAIL ?? "").trim();
  if (token && email) return null;
  if (token) return "JIRA_API_TOKEN is set but JIRA_EMAIL is not - Jira basic auth needs both";
  if (email) return "JIRA_EMAIL is set but JIRA_API_TOKEN is not - Jira basic auth needs both";
  return null;
}

/**
 * The host this source may send a credential to, or "" when the configured site is not one.
 *
 * Operators paste what their browser shows them - `https://acme.atlassian.net/jira/software/...`
 * - so a URL is accepted and reduced to its host, port included for a self-hosted instance.
 *
 * The reduction is done by `URL`, not by stripping with a regex, and that is a security
 * boundary rather than tidiness. `https://acme.atlassian.net@evil.example` looks like the
 * company's Jira and is not: the parser reads `acme.atlassian.net` as USERINFO and
 * `evil.example` as the host, so a regex that only removed the scheme and the path would hand
 * that whole string back, `https://${host}` would rebuild it unchanged, and the request -
 * carrying `JIRA_API_TOKEN` in an Authorization header - would go to `evil.example`. A
 * credential in a site field is never a legitimate configuration, so it is REFUSED here
 * rather than accepted in a reduced form. `siteProblem` is what says so out loud.
 */
export function siteHost(site: string): string {
  const raw = site.trim();
  if (!raw) return "";
  let url: URL;
  try {
    // The panel asks for a bare host; a pasted URL is what an operator has in hand.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return "";
  }
  if (url.username || url.password) return "";
  // `http://` is accepted as INPUT, because that is what a self-hosted instance's own links
  // look like, and the request is still built as `https://` below - this source never
  // downgrades a connection it is about to put a token on. Any other scheme is not a site.
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  return url.host;
}

/**
 * Why the configured site cannot be used, or null when it can.
 *
 * Three sentences rather than one, because "no site" and "that site would leak your token"
 * have nothing to do with each other and the second is the one nobody would guess.
 */
export function siteProblem(site: string): string | null {
  const raw = site.trim();
  if (!raw) {
    return "this source has no Jira site - set it to your Jira host, e.g. your-org.atlassian.net";
  }
  if (siteHost(site)) return null;
  if (raw.includes("@")) {
    return (
      "the Jira site must be a host, not a URL carrying a credential - a value like " +
      "`your-org.atlassian.net@elsewhere.example` names `elsewhere.example` as the server, " +
      "and JIRA_API_TOKEN would be sent there. Set it to your Jira host on its own"
    );
  }
  return `"${raw.slice(0, 60)}" is not a Jira host - set it to something like your-org.atlassian.net`;
}

/** The env var that widens the set of hosts the REST rung may authenticate to. */
const ALLOWED_HOSTS_VAR = "JIRA_ALLOWED_HOSTS";

/** The bare hostname of a `host[:port]`, lowercased. Ports do not change who is answering. */
function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

/** Jira Cloud - what this kind is built for, and where `DEFAULT_JIRA_SITE` lives. */
function isJiraCloud(host: string): boolean {
  return /(^|\.)atlassian\.net$/.test(hostnameOf(host));
}

/** Whether one allowlist entry names this host. `*.suffix` matches any subdomain of it. */
function hostAllowedBy(host: string, pattern: string): boolean {
  const name = hostnameOf(host);
  const want = hostnameOf(pattern.trim());
  if (!want) return false;
  if (want.startsWith("*.")) {
    const suffix = want.slice(1); // ".internal" - a dot-anchored suffix, never a bare substring
    return name.endsWith(suffix);
  }
  return name === want;
}

/**
 * Why this site may not be sent `JIRA_API_TOKEN`, or null when it may.
 *
 * A SEPARATE question from `siteProblem`, which asks whether a value is a host at all. This one
 * asks whether it is a host this daemon is willing to authenticate to, and it exists because the
 * userinfo refusal only closed one deceptive spelling: `evil.example` and
 * `acme.atlassian.net.evil.example` are perfectly well-formed hosts, and the REST rung would put a
 * Basic Authorization header on a request to either.
 *
 * "The operator typed it" is not the whole threat model. `PUT /api/task-sources/config` is a
 * localhost route, and this daemon dispatches agents that run on that same machine - so a config
 * write is a way to aim the credential, and a prompt-injected agent writing one would be
 * exfiltrating a token rather than merely misconfiguring a source. A lookalike host in a pasted
 * runbook does the same thing more slowly.
 *
 * Jira Cloud is allowed by default because that is what this kind is for. Anything else needs the
 * operator to say so out loud in `JIRA_ALLOWED_HOSTS`, in the daemon's own environment - the same
 * place the credential itself comes from, so widening the target and holding the token are the same
 * act of trust.
 *
 * Scoped to the REST rung on purpose: the `jira` CLI authenticates with its OWN configuration and
 * never receives this token, so a self-hosted instance reached through the CLI needs no allowlist
 * entry and is not affected by this at all.
 */
export function credentialTargetProblem(site: string, env: NodeJS.ProcessEnv): string | null {
  const host = siteHost(site);
  // Not a host at all is `siteProblem`'s answer to give, not this one's.
  if (!host) return null;
  if (isJiraCloud(host)) return null;
  const allowed = (env[ALLOWED_HOSTS_VAR] ?? "").split(",").filter((p) => p.trim().length > 0);
  if (allowed.some((pattern) => hostAllowedBy(host, pattern))) return null;
  return (
    `refusing to send JIRA_API_TOKEN to ${host}: it is not a Jira Cloud host (*.atlassian.net). ` +
    `If that really is your Jira, name it in ${ALLOWED_HOSTS_VAR} in the daemon's environment ` +
    "(comma-separated, `*.example.internal` allowed) - the jira CLI rung is unaffected either way, " +
    "since it uses its own credentials"
  );
}

/**
 * The `jira issue list` argv for this config - ONE request, and never an offset.
 *
 * `--raw` is the load-bearing flag: it prints the API's own JSON, which is the SAME envelope the
 * REST rung reads, so both rungs share one mapper and one set of tests rather than adding a
 * table-parser that would break on a truncated column.
 *
 * The offset half of `--paginate` is deliberately always `0`, because current jira-cli IGNORES it
 * against Jira's enhanced search - that API is cursor-paginated and has no `startAt` for an
 * offset to reach. A walk built on it does not advance: the second request returns the first page
 * again. This source used to do exactly that, detect the repeat, and stop with an error - which
 * meant a CLI-only machine filed NOTHING out of a filter bigger than one page.
 *
 * So this rung reads one request and hands the rest to REST (`ladder`). The `limit + 1` it asks
 * for is the whole completeness test, and it is exact rather than inferred: the LIMIT half of the
 * argument IS honoured, so "did more than `limit` come back" answers "is there anything after
 * this" with no offset, no cursor, no lookahead request, and no guessing from a page that happens
 * to be full.
 */
export function jiraIssueListArgs(cfg: JiraConfig): string[] {
  return [
    "issue",
    "list",
    "--jql",
    cfg.jql.trim(),
    "--paginate",
    `0:${cfg.limit + 1}`,
    "--raw",
  ];
}

/**
 * The REST search URL for one page of this config's filter.
 *
 * Encoded with `encodeURIComponent` rather than `URLSearchParams`, which spells a space as
 * `+`: that is correct for a form body and merely conventional in a query string, and a JQL
 * query is mostly spaces. `%20` is unambiguous everywhere, including to whatever proxy sits
 * between the daemon and Jira.
 *
 * `nextPageToken` is the enhanced endpoint's cursor, echoed back from the previous page. It
 * is Jira's own opaque string and is never constructed here.
 */
export function searchUrl(cfg: JiraConfig, pageToken: string | null = null): string {
  const query = [
    `jql=${encodeURIComponent(cfg.jql.trim())}`,
    `maxResults=${encodeURIComponent(String(cfg.limit))}`,
    `fields=${encodeURIComponent(REST_FIELDS)}`,
    ...(pageToken ? [`nextPageToken=${encodeURIComponent(pageToken)}`] : []),
  ].join("&");
  return `https://${siteHost(cfg.site)}${REST_SEARCH_PATH}?${query}`;
}

/**
 * The issue key - `PROJ-1234` - which is Jira's own stable identity for the issue.
 *
 * Nothing is derived and nothing is composed from the config, for the reason the GitHub
 * source reads its id off the issue URL: a changed `externalId` re-files an item that is
 * already in the backlog. A row with no key cannot be de-duplicated at all, so it is not a
 * candidate (`candidateFrom` refuses it) rather than being filed under something invented.
 */
export function externalIdFor(issue: JiraIssue): string | null {
  const key = typeof issue.key === "string" ? issue.key.trim() : "";
  return key || null;
}

/** An issue's `fields` object, or an empty one. */
function fieldsOf(issue: JiraIssue): Record<string, unknown> {
  const f = issue.fields;
  return typeof f === "object" && f !== null ? (f as Record<string, unknown>) : {};
}

/**
 * Where a human clicks to read the issue.
 *
 * The host comes from the issue's own `self` URL when Jira sent one, and only falls back to
 * the configured site. That is what keeps the link right when the CLI rung is pointed at a
 * different site than this source's `site` field - which is easy to do, since the CLI keeps
 * its own configuration and this source cannot see it.
 */
export function browseUrlFor(issue: JiraIssue, cfg: JiraConfig): string | null {
  const key = externalIdFor(issue);
  if (!key) return null;
  const host = hostOfSelf(issue.self) || siteHost(cfg.site);
  return host ? `https://${host}/browse/${key}` : null;
}

function hostOfSelf(self: unknown): string {
  if (typeof self !== "string") return "";
  try {
    const url = new URL(self);
    // Same refusal as `siteHost`, for a smaller stake: no credential rides a browse link, but
    // a userinfo host in a response would put a link to somebody else's server on a card.
    return url.username || url.password ? "" : url.host;
  } catch {
    return "";
  }
}

/** ADF node types that end a block, so their text does not run into the next one's. */
const ADF_BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "panel",
  "rule",
  "tableRow",
  "taskItem",
]);

/**
 * An issue description as plain text, whichever shape Jira sent it in.
 *
 * Jira Cloud's v3 API returns a description as ADF - a nested document tree - where v2 and
 * older on-premise instances return a string. The agent's first prompt has to carry the
 * text either way, and pasting `{"type":"doc","content":[…]}` into it would be worse than
 * carrying nothing: a model would spend its first turn deciding whether the JSON was the
 * task. Unknown node types recurse rather than being dropped, so an ADF extension this
 * build has never heard of still contributes its text.
 */
export function plainTextFrom(description: unknown): string {
  if (typeof description === "string") return description.trim();
  return adfText(description).replace(/\n{3,}/g, "\n\n").trim();
}

function adfText(node: unknown): string {
  if (Array.isArray(node)) return node.map(adfText).join("");
  if (typeof node !== "object" || node === null) return "";
  const n = node as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown };
  if (typeof n.text === "string") return n.text;
  if (n.type === "hardBreak") return "\n";
  // A mention renders as a chip with no text node under it, so its display name lives in
  // `attrs`. Without this an "@someone, please look" description loses the person.
  const attrs = n.attrs as { text?: unknown } | undefined;
  if (n.type === "mention" && typeof attrs?.text === "string") return attrs.text;
  const inner = adfText(n.content);
  if (!ADF_BLOCKS.has(String(n.type))) return inner;
  return inner ? `${inner}\n\n` : "";
}

/**
 * Jira priority NAME -> task priority, matched case-insensitively.
 *
 * Jira's scheme is per-project and renameable, so this covers the default cloud scheme
 * plus the two renamings that are everywhere (`P0…P4`, and the Bugzilla-descended
 * `Critical/Major/Minor/Trivial`). A name that is not here leaves the priority OPEN, which
 * is what lets the source's own default apply - see `candidateFrom`.
 */
export const JIRA_PRIORITY_TO_TASK: Record<string, TaskPriority> = {
  highest: "blocker",
  blocker: "blocker",
  critical: "blocker",
  p0: "blocker",
  high: "high",
  major: "high",
  p1: "high",
  medium: "med",
  normal: "med",
  p2: "med",
  low: "low",
  minor: "low",
  p3: "low",
  lowest: "low",
  trivial: "low",
  p4: "low",
};

/** The priority this issue asks for, or null to fall back to the source's default. */
export function priorityFor(name: unknown, cfg: JiraConfig): TaskPriority | null {
  if (!cfg.priorityFromJira) return null;
  if (typeof name !== "string") return null;
  return JIRA_PRIORITY_TO_TASK[name.trim().toLowerCase()] ?? null;
}

/**
 * One issue as a candidate task.
 *
 * The intent is a BRIEF, not the raw record: it names the issue by key and summary, links
 * it, and carries its description, so the agent's first prompt has the actual text rather
 * than a key it would have to go and look up.
 */
export function candidateFrom(
  issue: JiraIssue,
  cfg: JiraConfig,
  ctx: SweepContext,
): TaskCandidate | null {
  const key = externalIdFor(issue);
  const fields = fieldsOf(issue);
  const summary = typeof fields.summary === "string" ? fields.summary.trim() : "";
  // A row we cannot identify or cannot name is not a task: without a key it cannot be
  // de-duplicated, and without a summary the card would be untraceable to anything.
  if (!key || !summary) return null;

  const url = browseUrlFor(issue, cfg);
  const body = plainTextFrom(fields.description);
  const trimmed =
    body.length > BODY_LIMIT
      ? `${body.slice(0, BODY_LIMIT)}\n\n[issue description truncated]`
      : body;
  // OMITTED, not null, when nothing matched - and the difference is the whole behaviour of
  // the source's default priority. `null` on a candidate means "this item deliberately has
  // no priority" and ingest honours it; an absent key means "I have no opinion", which is
  // what lets the default apply (`ingest.ts` tests `!== undefined`).
  const mapped = priorityFor((fields.priority as { name?: unknown } | undefined)?.name, cfg);

  return {
    ref: { sourceId: ctx.sourceId, externalId: key, url },
    title: summary,
    intent: [
      `Jira issue ${key}: ${summary}`,
      ...(url ? [url] : []),
      "",
      trimmed || "(the issue has no description)",
    ].join("\n"),
    repoRoot: ctx.repoRoot,
    ...(mapped ? { priority: mapped } : {}),
  };
}

/**
 * Map issues to candidates, dropping the ones we cannot name.
 *
 * No cap here. `cfg.limit` is the PAGE SIZE - what one request asks Jira for - and the walk
 * is what bounds the total, at `MAX_SWEEP_ISSUES`. Capping here as well used to be how the
 * source silently discarded everything after the first page.
 *
 * Returning more than the source will file is deliberate and is the whole repair: `ingest.ts`
 * drops what `task_source_seen` already holds and only THEN applies `maxPerSweep`, so a
 * filter with 400 already-filed issues and 3 new ones files the 3.
 */
function candidatesFrom(issues: JiraIssue[], cfg: JiraConfig, ctx: SweepContext): TaskCandidate[] {
  return issues
    .map((i) => candidateFrom(i, cfg, ctx))
    .filter((c): c is TaskCandidate => c !== null);
}

/**
 * Read a JSON body as one page of issues.
 *
 * One reader for both rungs: `jira issue list --raw` prints the API's own
 * `{"issues": […]}` envelope, and a bare array is accepted too so a wrapper or a future
 * CLI version that unwraps it does not read as "no work".
 *
 * `nextPageToken` is carried through when the enhanced endpoint sent one. It is absent on the
 * last page, absent from a bare array, and absent from the CLI's output, so a rung that has
 * no cursor simply reports none and the walk falls back to its own page arithmetic.
 *
 * This is where the wire meets the types, so it is the last place a lie is affordable. Each ENTRY
 * is checked, not only the envelope: `{"issues":[null]}` is a shape a JSON array permits, and the
 * `as JiraIssue[]` this used to end with was an assertion that would have `candidateFrom`
 * dereference `null.key` and THROW. `sweepSource` catches that, so the daemon survives - but the
 * sweep dies whole, every good issue beside the bad row is lost, and the operator reads "Cannot
 * read properties of null" instead of a sentence about their Jira. A row that is not an object
 * cannot be an issue under any reading, so it is dropped here exactly as the GitHub source drops
 * a row it cannot name.
 */
export function issuesFrom(
  text: string,
): { issues: JiraIssue[]; nextPageToken: string | null } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() || "{}");
  } catch {
    return { error: "Jira returned output that is not JSON" };
  }
  const envelope = parsed as { issues?: unknown; nextPageToken?: unknown } | null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(envelope?.issues) ? envelope.issues : null;
  // Malformed output is an anomaly, not "no issues" - the same reading the GitHub source
  // takes of a `gh` that answered with something unexpected.
  if (!list) return { error: "Jira returned an unexpected shape" };
  const token = typeof envelope?.nextPageToken === "string" ? envelope.nextPageToken.trim() : "";
  return {
    issues: list.filter(
      (row): row is JiraIssue => typeof row === "object" && row !== null && !Array.isArray(row),
    ),
    nextPageToken: token || null,
  };
}

/** First non-empty line of some output, for a one-line "why". */
function firstLine(text: string): string {
  return text.trim().split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

/**
 * Whether a failure is Jira refusing the CALLER rather than refusing the query.
 *
 * Deliberately narrow. "You do not have permission to view this issue" is Jira's answer to
 * a perfectly authenticated request for something out of reach, so matching the word
 * "permission" would send an operator to re-check a credential that is fine.
 */
function looksUnauthenticated(text: string): boolean {
  return /\b401\b|\b403\b|unauthoriz|unauthentic|authenticat|invalid token|not logged in/i.test(
    text,
  );
}

/**
 * jira-cli that is installed but has never been pointed at a site.
 *
 * A third diagnosis, because it has a third fix: not "install it", not "your token is
 * wrong", but "run `jira init`". It is also the common state on a machine where the shell
 * helpers were set up from `JIRA_API_TOKEN` and the CLI itself never was - which is exactly
 * when the REST rung takes over, so this sentence names that route too.
 */
function looksUnconfigured(text: string): boolean {
  return /jira init|config file|configuration file|\.config\.yml/i.test(text);
}

/**
 * jira-cli's own spelling of "your query matched nothing".
 *
 * It says so on stderr and exits NON-ZERO, which would otherwise be reported as a broken
 * source on every sweep of a filter that is simply up to date - the exact inversion of the
 * failure this file exists to prevent, and just as misleading.
 */
const CLI_EMPTY = /no result found/i;

/** What one `jira` run reported, as much of it as any of these decisions need. */
type CliRun = Pick<RunResult, "stdout" | "stderr" | "code" | "outcomeUnknown">;

/**
 * What a failed `jira` run says about the CLI ITSELF, rather than about the request.
 *
 * ONE owner for a judgement two callers need and must never disagree about. `cliFailure`
 * turns it into the sentence an operator reads; `cliRungUnusable` turns it into a routing
 * decision - whether a failed write may be retried on the REST rung. They used to classify
 * separately, so adding a diagnosis meant remembering to edit both, and missing one silently
 * changed whether a comment could be posted twice. The two are now the same answer, read
 * differently.
 *
 * `refused` is the consequential one: the CLI RAN and something on the other side said no.
 * That request reached Jira, so it must never be replayed on another rung.
 */
export type CliFault =
  | "no-answer"
  | "not-installed"
  | "unconfigured"
  | "unauthenticated"
  | "unsupported-flag"
  | "refused";

export function cliFault(res: CliRun): CliFault {
  // The child DIED rather than answering. Whether it did its work first is unknowable.
  if (res.outcomeUnknown) return "no-answer";
  const said = `${res.stderr}\n${res.stdout}`;
  // `run` reports a missing binary through the callback with Node's own message, so this
  // covers a `jira` that vanished between the PATH check and the spawn. Matched narrowly:
  // a bare /not found/ also matches jira-cli's own "config file not found", which is a
  // different state with a different fix and is classified below.
  if (res.code === 127 || /ENOENT|command not found|No such file or directory/i.test(res.stderr)) {
    return "not-installed";
  }
  if (looksUnconfigured(said)) return "unconfigured";
  if (looksUnauthenticated(said)) return "unauthenticated";
  if (/unknown flag|unknown shorthand|flag provided but not defined/i.test(res.stderr)) {
    return "unsupported-flag";
  }
  return "refused";
}

/**
 * Whether a failed CLI run means the CLI is unusable, rather than that it refused this write.
 *
 * The REST fallback is only correct for the first kind: the half-configured machine the
 * sweep's ladder was built for, where `jira` is on PATH and `jira init` was never run. A CLI
 * that ran and was REFUSED must not be retried on the other rung - that request reached Jira
 * once already, and a second one is how a single comment becomes two. `no-answer` is
 * excluded for the same reason and a stronger one: it may have succeeded.
 */
function cliRungUnusable(res: CliRun): boolean {
  const fault = cliFault(res);
  return fault === "not-installed"
    || fault === "unconfigured"
    || fault === "unauthenticated"
    || fault === "unsupported-flag";
}

/**
 * Why one `jira` run failed, in the operator's terms - naming the fix where we can tell.
 *
 * The formatting half of `cliFault`. `verb` names the subcommand for the fallback sentence
 * only; every other branch describes the CLI rather than the request, and reads identically
 * whether the run was a sweep or a write-back.
 */
export function cliFailure(res: CliRun, verb = "jira issue list"): string {
  const why = firstLine(res.stderr || res.stdout);
  switch (cliFault(res)) {
    case "no-answer":
      // No stderr to quote, so a bare "failed" would be the whole diagnosis. The usual cause
      // is a CLI waiting on a prompt it will never get - it has a terminal's habits and this
      // process has no terminal.
      return `the jira CLI did not answer within ${Math.round(JIRA_TIMEOUT_MS / 1000)}s${
        why ? ` - ${why}` : ""
      } - it may be waiting for input, which a background sweep cannot give it`;
    case "not-installed":
      return "the jira CLI could not be run - reinstall it (`brew install ankitpokhrel/jira-cli/jira-cli`), or set JIRA_API_TOKEN and JIRA_EMAIL to use the REST fallback";
    case "unconfigured":
      return `the jira CLI is installed but not configured${why ? ` - ${why}` : ""} - run \`jira init\`, or set JIRA_API_TOKEN and JIRA_EMAIL to use the REST fallback`;
    case "unauthenticated":
      return `the jira CLI is not authenticated${why ? ` - ${why}` : ""} - export JIRA_API_TOKEN and run \`jira init\` if you have not`;
    case "unsupported-flag":
      // A CLI that does not know `--paginate` cannot be asked for a bounded page, and a sweep
      // that cannot page cannot reach past the first one. Named as its own state because the
      // fix is neither the token nor the query: upgrade it, or let REST do the paging. Any
      // OTHER unknown flag is the generic sentence, which quotes what the CLI actually said.
      return /paginate/i.test(res.stderr)
        ? `this jira CLI does not support \`--paginate\`${why ? ` - ${why}` : ""} - upgrade it (\`brew upgrade jira-cli\`), or set JIRA_API_TOKEN and JIRA_EMAIL so the REST rung can page`
        : `${verb} failed${why ? `: ${why}` : ""}`;
    default:
      return `${verb} failed${why ? `: ${why}` : ""}`;
  }
}

/** The first thing Jira's error envelope actually says, or the body's first line. */
export function restMessage(body: string): string {
  try {
    const parsed = JSON.parse(body.trim() || "{}") as {
      errorMessages?: unknown;
      errors?: unknown;
      message?: unknown;
    };
    const messages = Array.isArray(parsed.errorMessages) ? parsed.errorMessages : [];
    const first = messages.find((m): m is string => typeof m === "string" && m.trim().length > 0);
    if (first) return first.trim();
    const errors = parsed.errors;
    if (typeof errors === "object" && errors !== null) {
      const value = Object.values(errors).find(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      if (value) return value.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // Not JSON: an HTML error page from a proxy, or nothing at all.
  }
  return firstLine(body).slice(0, 200);
}

/** One REST attempt's outcome. `status: 0` is "we never got an answer at all". */
export interface RestAnswer {
  ok: boolean;
  status: number;
  body: string;
}

/** Why a REST attempt failed, in the operator's terms - naming which fix applies. */
export function restFailure(res: RestAnswer, cfg: JiraConfig): string {
  const why = restMessage(res.body);
  const host = siteHost(cfg.site) || "the configured site";
  if (res.status === 0) {
    return `could not reach Jira at ${host}${why ? ` - ${why}` : ""}`;
  }
  if (res.status === 401 || res.status === 403) {
    return `Jira rejected the JIRA_API_TOKEN / JIRA_EMAIL credential (HTTP ${res.status})${
      why ? ` - ${why}` : ""
    } - check both, and that the token belongs to ${host}`;
  }
  if (res.status === 404) {
    return `Jira has no search API at ${host} (HTTP 404)${why ? ` - ${why}` : ""} - check the site`;
  }
  return `Jira could not run this query (HTTP ${res.status})${why ? ` - ${why}` : ""}`;
}

/** One page a rung returned: what it held, whether there is a cursor, and why it failed. */
export interface JiraPage {
  issues: JiraIssue[];
  nextPageToken: string | null;
  error: string | null;
}

/**
 * Read one `jira issue list --raw` run as a page.
 *
 * The rule this holds, on every branch: a non-zero exit or unparseable output becomes an
 * ERROR and NEVER an empty page, because an empty page ends the walk and would read as
 * "there is no more work".
 */
export function pageFromCli(res: CliRun): JiraPage {
  const empty = { issues: [], nextPageToken: null };
  if (res.code !== 0) {
    // The one non-zero exit that is not a failure: the CLI's way of saying the filter matched
    // nothing. Reporting it would make a healthy, up-to-date source look broken - and past
    // the first page it is simply how the walk learns it has reached the end.
    if (CLI_EMPTY.test(`${res.stderr}\n${res.stdout}`)) return { ...empty, error: null };
    return { ...empty, error: cliFailure(res) };
  }
  const read = issuesFrom(res.stdout);
  if ("error" in read) return { ...empty, error: read.error };
  return { ...read, error: null };
}

/** Read one REST search as a page, under the same rule. */
export function pageFromRest(res: RestAnswer, cfg: JiraConfig): JiraPage {
  const empty = { issues: [], nextPageToken: null };
  if (!res.ok) return { ...empty, error: restFailure(res, cfg) };
  const read = issuesFrom(res.body);
  if ("error" in read) return { ...empty, error: read.error };
  return { ...read, error: null };
}

/** What one rung's read produced. */
export interface JiraWalk {
  issues: JiraIssue[];
  /** A rung failure. Always fatal for the sweep - a partial page is not "no work". */
  error: string | null;
  /**
   * The issues are good AND the tail of this filter is out of reach, which is a different state
   * from a failure: it arrives WITH candidates worth filing. Two things reach it - a filter
   * larger than one sweep may read, and a rung that cannot page one this size - and the fix for
   * each is the operator's, so the sentence is the point rather than a flag would be.
   *
   * `sweepResultFromWalk` puts it on `SweepResult.error`, which is where the panel shows it. That
   * reads oddly for a second and is the honest state: real candidates, and a source that cannot
   * see the end of its own filter.
   */
  advisory: string | null;
}

/**
 * Whether to ask for another page, and if not, why the walk stopped.
 *
 * Pure and exported because the two bounds it holds are the whole correctness of paging, and
 * neither is cheap to reach through a real walk: `done` is a filter that has been read to its
 * end, and `truncated` is one that has not and never will be.
 */
export function nextPage(
  state: { fetched: number; pagesUsed: number; hasMore: boolean },
  maxPages: number,
): "more" | "done" | "truncated" {
  if (!state.hasMore) return "done";
  if (state.pagesUsed >= maxPages || state.fetched >= MAX_SWEEP_ISSUES) return "truncated";
  return "more";
}

/**
 * How many of this page's issues the walk had not already collected - counting them INTO
 * `seen`, which is what makes the next page's answer meaningful.
 *
 * The walk needs this to tell "another page" from "the same page again". A rung that accepts a
 * pagination argument and ignores it - an older CLI, a proxy that caches, a server that keeps
 * echoing one cursor - would otherwise be walked until the ceiling and then reported as a
 * filter too broad to read, which is a true sentence about the wrong thing: the operator would
 * go and narrow a JQL that was never the problem.
 */
export function freshKeys(page: JiraIssue[], seen: Set<string>): number {
  let fresh = 0;
  for (const issue of page) {
    const key = externalIdFor(issue);
    if (key && !seen.has(key)) {
      seen.add(key);
      fresh += 1;
    }
  }
  return fresh;
}

/**
 * Append what fits under the cap, and say whether anything had to be left behind.
 *
 * `nextPage` checks the total AFTER a page has been added, which is one page too late to be a
 * cap: at a page size of 199 the budget allows six requests, so six full pages put 1,194 issues
 * in hand while every sentence about them quotes 1,000. The page is therefore clipped on the way
 * in, and the clip is also the most reliable tail signal there is - rows this walk SAW and could
 * not keep prove the filter continues, with no lookahead and no inference from a full page.
 */
export function appendCapped(
  issues: JiraIssue[],
  page: JiraIssue[],
): { kept: JiraIssue[]; clipped: boolean } {
  const room = Math.max(0, MAX_SWEEP_ISSUES - issues.length);
  const kept = page.slice(0, room);
  issues.push(...kept);
  return { kept, clipped: page.length > kept.length };
}

/**
 * What to say when Jira keeps answering with the page the walk already has.
 *
 * REST-only, and it stayed after the CLI rung stopped paging: this is a cursor that does not
 * advance, which means something between here and Jira is repeating itself. The page and issue
 * ceilings would stop the walk anyway - this is about not reporting that as "your filter is too
 * broad", which would send an operator to narrow a JQL that was never the problem.
 */
function notAdvancing(): string {
  return (
    "Jira returned the same page again instead of the next one, so this filter cannot be read " +
    "past its first page - check whether a proxy is caching the search request"
  );
}

/**
 * How many requests one REST walk may spend, given the page size the operator chose.
 *
 * Only that rung pages - the CLI reads once (`readCli`) - so this is the only place the two
 * ceilings meet. A preflight probe passes 1 instead: it asks whether Jira answers this filter at
 * all, and where the filter ENDS is not its question.
 */
function sweepPages(cfg: JiraConfig): number {
  return Math.max(1, Math.min(MAX_SWEEP_PAGES, Math.ceil(MAX_SWEEP_ISSUES / cfg.limit)));
}

/**
 * What to say when a filter needs more than one request and this rung cannot make a second one.
 *
 * The CLI is that rung: it ignores the offset half of `--paginate`. Reported WITH the request it
 * did read still filed, because the alternative - which this source did until Inspector round 9 -
 * was a CLI-only operator getting nothing at all out of a large filter. That is a loud empty
 * sweep, which is better than a silent one and still not work arriving.
 */
function cliCannotPage(cfg: JiraConfig): string {
  return (
    `this filter has more issues than the ${cfg.limit} one jira CLI request returns, and that CLI ` +
    "cannot be asked for a second page (it ignores the offset in `--paginate`) - the newest " +
    `${cfg.limit} are filed, and to reach the rest either set JIRA_API_TOKEN and JIRA_EMAIL so the ` +
    "REST rung can page, or narrow the JQL to fit one request"
  );
}

/**
 * What to say when the filter is broader than one sweep can read.
 *
 * Two fixes, because there are two bounds. A genuinely enormous filter needs narrowing; a
 * filter that merely outran a small page size needs a bigger page.
 */
function tooBroad(cfg: JiraConfig): string {
  return (
    `this filter is larger than one sweep can read (${MAX_SWEEP_ISSUES} issues or ` +
    `${MAX_SWEEP_PAGES} requests, whichever comes first), so its tail can never be filed - ` +
    "narrow the JQL with a status, a project or a date bound" +
    (cfg.limit < 50 ? ", or raise Issues per page" : "")
  );
}

/**
 * Turn a walk into a sweep result.
 *
 * Truncation is reported as an ERROR while the items are still returned, which looks odd for
 * about a second and is the honest reading: those candidates are real and `ingest.ts` should
 * file the unseen ones, AND this source cannot see the end of its own filter, which is a
 * misconfiguration the operator has to fix. Silence there would be the same failure as an
 * empty sweep on a broken credential - work that never arrives, with nothing saying why.
 */
export function sweepResultFromWalk(
  walk: JiraWalk,
  cfg: JiraConfig,
  ctx: SweepContext,
): SweepResult {
  if (walk.error) return { items: [], error: walk.error };
  if (ctx.signal.aborted) return { items: [], error: "the sweep was abandoned" };
  return { items: candidatesFrom(walk.issues, cfg, ctx), error: walk.advisory };
}

/**
 * Ask Jira's REST API directly, with the env credential.
 *
 * Never resolves to a throw: a DNS failure, a refused connection or a TLS rejection is an
 * answer this source has to report as its own error, exactly like a non-zero CLI exit.
 * TLS verification is NOT relaxed - behind a TLS-inspecting VPN the fix is the operator's
 * `NODE_EXTRA_CA_CERTS`, and disabling verification here would silently apply to a daemon
 * doing much more than this one query.
 */
async function restSearch(
  cfg: JiraConfig,
  cred: JiraRestCredential,
  ctx: SweepContext,
  pageToken: string | null = null,
): Promise<RestAnswer> {
  const basic = Buffer.from(`${cred.email}:${cred.token}`, "utf8").toString("base64");
  try {
    const res = await fetch(searchUrl(cfg, pageToken), {
      headers: { authorization: `Basic ${basic}`, accept: "application/json" },
      // Both bounds, together: the sweeper's own signal (so a shutdown or its 60s cap cuts
      // this off) and this source's 20s budget.
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(JIRA_TIMEOUT_MS)]),
    });
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
  } catch (err) {
    // The message, never the request: a thrown fetch must not carry the Authorization
    // header into a panel or a log line.
    //
    // The cause's code is appended because Node's own message for every transport failure
    // is the same three words, "fetch failed", and the three failures underneath it have
    // three different fixes: ECONNREFUSED is the wrong host or port, ENOTFOUND is a typo,
    // and a certificate error behind a TLS-inspecting VPN is `NODE_EXTRA_CA_CERTS`.
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
    const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: `${message}${code}` };
  }
}

/**
 * Read the CLI rung: ONE request, and what it says about completeness.
 *
 * This rung does not page, and that is not a limitation being papered over - it is the only
 * correct reading of the tool. Current jira-cli ignores the offset half of `--paginate` against
 * Jira's enhanced search, so a second request returns the first page again. The version of this
 * file that advanced an offset detected the repeat and stopped with an error, which meant a
 * CLI-only machine filed NOTHING out of any filter bigger than one page - loud, but no work
 * arriving either.
 *
 * `hasMore` is exact rather than inferred, because the request asked for `limit + 1`: more than
 * `limit` came back means there is something after them, full stop. No cursor, no lookahead
 * request, no guessing from a page that happens to be full - which is also why this rung needs
 * none of `nextPage`, `appendCapped`, `freshKeys` or a page budget, and why the multi-page
 * machinery those exist for now lives only on the REST rung.
 *
 * `ladder` decides what to do about `hasMore`: page it properly over REST when there is a
 * credential, or file this request and say so when there is not.
 */
async function readCli(
  cfg: JiraConfig,
  ctx: SweepContext,
): Promise<{ issues: JiraIssue[]; error: string | null; hasMore: boolean }> {
  if (ctx.signal.aborted) return { issues: [], error: "the sweep was abandoned", hasMore: false };
  // The CLI inherits the daemon's environment, which is where `JIRA_API_TOKEN` already is for the
  // operators who have one - so nothing has to be passed through explicitly.
  const page = pageFromCli(await run(jiraBin(), jiraIssueListArgs(cfg), { timeoutMs: JIRA_TIMEOUT_MS }));
  if (page.error) return { issues: [], error: page.error, hasMore: false };
  // The extra row is a probe, not a candidate: it answers the question and is then dropped, so a
  // sweep files exactly the page size it was configured for.
  return {
    issues: page.issues.slice(0, cfg.limit),
    error: null,
    hasMore: page.issues.length > cfg.limit,
  };
}

/** Walk the REST rung's pages, following the cursor Jira hands back. */
async function walkRest(
  cfg: JiraConfig,
  cred: JiraRestCredential,
  ctx: SweepContext,
  maxPages: number,
): Promise<JiraWalk> {
  // The authoritative check, at the rung that actually attaches the credential. `ladder` asks the
  // same predicate to decide whether this rung exists at all, and that is routing; this is the
  // control. A security refusal enforced only by its caller is one refactor from being gone.
  const target = credentialTargetProblem(cfg.site, process.env);
  if (target) return { issues: [], error: target, advisory: null };

  const issues: JiraIssue[] = [];
  const keys = new Set<string>();
  let token: string | null = null;
  for (let pagesUsed = 0; ; pagesUsed += 1) {
    if (ctx.signal.aborted) return { issues, error: "the sweep was abandoned", advisory: null };
    const page = pageFromRest(await restSearch(cfg, cred, ctx, token), cfg);
    if (page.error) return { issues, error: page.error, advisory: null };
    const { kept, clipped } = appendCapped(issues, page.issues);
    const fresh = freshKeys(kept, keys);
    // Rows this page held that the cap had no room for: `maxResults` is what the operator asked
    // Jira for, and a final page of it can land astride the ceiling. The clip is also the tail
    // proof - rows seen and not kept - so nothing has to be inferred from a full page.
    if (clipped) return { issues, error: null, advisory: tooBroad(cfg) };
    if (pagesUsed > 0 && kept.length > 0 && fresh === 0) {
      return { issues, error: notAdvancing(), advisory: null };
    }
    token = page.nextPageToken;
    const step = nextPage(
      {
        fetched: issues.length,
        pagesUsed: pagesUsed + 1,
        // A cursor AND something on this page. A token with an empty page would otherwise
        // loop against a server that keeps handing one back.
        //
        // No lookahead is needed on this rung, unlike the CLI's: the cursor is Jira SAYING
        // there is another page, and it is absent on the last one - so truncation here is
        // established rather than inferred from a full page.
        hasMore: token !== null && page.issues.length > 0,
      },
      maxPages,
    );
    if (step !== "more") {
      return { issues, error: null, advisory: step === "truncated" ? tooBroad(cfg) : null };
    }
  }
}

/** The two external seams behind an UpstartClaw query, explicit so tests spend no tokens. */
export interface JiraUpstartClawDeps {
  ready(): Promise<boolean>;
  run(prompt: string, opts: ClaudeRunOptions): Promise<ClaudeToolTrace>;
}

const DEFAULT_UPSTARTCLAW_DEPS: JiraUpstartClawDeps = {
  ready: async () => upstartclawCoreReady(defaultEnvironmentDeps()),
  run: runClaudeToolTrace,
};

/**
 * The complete instruction for one skill-backed JQL query.
 *
 * The JQL is JSON-encoded rather than interpolated as prose, so quotes and newlines retain their
 * exact bytes. The tool grant is the security boundary, but the prompt also states the intended
 * route so a malformed query cannot redirect the model toward Glean or a general web search.
 */
export function upstartClawPrompt(cfg: JiraConfig, maxIssues: number): string {
  return [
    "Query Upstart Jira. Mission Control reads the Jira tool results directly, not your summary.",
    `First invoke the ${UPSTARTCLAW_JIRA_SKILL} skill.`,
    "Then use ToolSearch to load one of these approved JQL search registrations and call it directly:",
    ...UPSTARTCLAW_JQL_TOOLS.map((tool) => `- ${tool}`),
    "Do not use Glean, web search, or any other Jira query. Do not change or augment the JQL.",
    `Use this exact cloudId: ${JSON.stringify(UPSTARTCLAW_CLOUD_ID)}`,
    `Run this exact JQL string: ${JSON.stringify(cfg.jql)}`,
    `Set maxResults to at most ${Math.min(cfg.limit, maxIssues)} on each call.`,
    `Collect matching issues through pagination, stopping after ${maxIssues} issues or ${MAX_SWEEP_PAGES} calls.`,
    "After every call, read issues.pageInfo.hasNextPage from the tool result.",
    "When it is true and the bound is not reached, call the same tool again with nextPageToken set to the exact issues.pageInfo.endCursor value.",
    "Stop only when hasNextPage is false or a stated bound is reached. Never infer completion from the number of issues returned.",
    "Finish with a brief confirmation. Do not repeat or transform the issue data in the final answer.",
  ].join("\n");
}

interface UpstartClawPage {
  issues: JiraIssue[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Read the Atlassian MCP provider's page, not Claude's model-facing tool text or summary. */
function pageFromUpstartClawTool(output: unknown): UpstartClawPage | { error: string } {
  const answer = recordFrom(output);
  const issues = recordFrom(answer?.issues);
  const pageInfo = recordFrom(issues?.pageInfo);
  if (!Array.isArray(issues?.nodes) || typeof pageInfo?.hasNextPage !== "boolean") {
    return { error: "UpstartClaw's Jira tool returned an unexpected pagination shape" };
  }
  const read = issuesFrom(JSON.stringify({ issues: issues.nodes }));
  if ("error" in read) return { error: `UpstartClaw's Jira tool failed validation - ${read.error}` };
  const cursor =
    typeof pageInfo.endCursor === "string" && pageInfo.endCursor.length > 0
      ? pageInfo.endCursor
      : null;
  if (pageInfo.hasNextPage && cursor === null) {
    return { error: "UpstartClaw's Jira tool reported another page without an endCursor" };
  }
  return { issues: read.issues, hasNextPage: pageInfo.hasNextPage, endCursor: cursor };
}

function upstartClawFailure(error: string): JiraWalk {
  return { issues: [], error, advisory: null };
}

/**
 * Walk the exact MCP calls Claude made, using Jira's `hasNextPage` and cursor as the authority.
 * A final model answer is deliberately ignored: it can explain a run, but cannot prove that the
 * provider's result set ended.
 */
export function walkFromUpstartClawTrace(
  trace: ClaudeToolTrace,
  cfg: JiraConfig,
  maxIssues: number,
): JiraWalk {
  const jqlCalls = trace.toolCalls.filter((call) =>
    call.name.endsWith("__searchJiraIssuesUsingJql")
  );
  const unsupported = jqlCalls.find((call) => !UPSTARTCLAW_JQL_TOOL_SET.has(call.name));
  if (unsupported) {
    return upstartClawFailure(
      `UpstartClaw used an unsupported Atlassian JQL registration: ${unsupported.name}`,
    );
  }
  const calls = jqlCalls.filter((call) => UPSTARTCLAW_JQL_TOOL_SET.has(call.name));
  if (calls.length === 0) {
    return upstartClawFailure("UpstartClaw did not call its Atlassian JQL search tool");
  }
  const selectedTool = calls[0]!.name;
  if (calls.some((call) => call.name !== selectedTool)) {
    return upstartClawFailure(
      "UpstartClaw changed Atlassian JQL registrations while paginating",
    );
  }

  const collected: JiraIssue[] = [];
  const issueKeys = new Set<string>();
  const cursors = new Set<string>();
  let expectedToken: string | null = null;

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const input = recordFrom(call.input);
    const token =
      typeof input?.nextPageToken === "string" && input.nextPageToken.length > 0
        ? input.nextPageToken
        : null;
    const maxResults = input?.maxResults;
    if (
      input?.cloudId !== UPSTARTCLAW_CLOUD_ID ||
      input.jql !== cfg.jql ||
      !Number.isInteger(maxResults) ||
      (maxResults as number) < 1 ||
      (maxResults as number) > Math.min(cfg.limit, maxIssues)
    ) {
      return upstartClawFailure(
        "UpstartClaw called Jira with a different cloud, JQL, or page size than configured",
      );
    }
    if (token !== expectedToken) {
      return upstartClawFailure(
        "UpstartClaw did not pass Jira's exact endCursor back as nextPageToken",
      );
    }

    const page = pageFromUpstartClawTool(call.output);
    if ("error" in page) return upstartClawFailure(page.error);
    const room = Math.max(0, maxIssues - collected.length);
    const kept = page.issues.slice(0, room);
    const clipped = kept.length < page.issues.length;
    collected.push(...kept);
    const fresh = freshKeys(kept, issueKeys);
    if (index > 0 && kept.length > 0 && fresh === 0) {
      return upstartClawFailure(notAdvancing());
    }

    const reachedBound = clipped || collected.length >= maxIssues || index + 1 >= MAX_SWEEP_PAGES;
    if (!page.hasNextPage && !clipped) {
      if (index + 1 !== calls.length) {
        return upstartClawFailure("UpstartClaw queried Jira again after Jira reported its last page");
      }
      return { issues: collected, error: null, advisory: null };
    }
    if (reachedBound) {
      if (index + 1 !== calls.length) {
        return upstartClawFailure("UpstartClaw continued querying Jira after the sweep bound");
      }
      return { issues: collected, error: null, advisory: tooBroad(cfg) };
    }

    const cursor = page.endCursor!;
    if (cursors.has(cursor)) return upstartClawFailure(notAdvancing());
    cursors.add(cursor);
    expectedToken = cursor;
  }

  return upstartClawFailure(
    "UpstartClaw stopped before Jira's next page, so this filter's result is incomplete",
  );
}

/** Run the selected JQL through the installed UpstartClaw Jira skill and read-only MCP tool. */
export async function readUpstartClaw(
  cfg: JiraConfig,
  ctx: SweepContext,
  maxIssues: number,
  deps: JiraUpstartClawDeps = DEFAULT_UPSTARTCLAW_DEPS,
): Promise<JiraWalk> {
  if (!cfg.jql.trim()) {
    return { issues: [], error: NO_JQL, advisory: null };
  }
  if (ctx.signal.aborted) {
    return { issues: [], error: "the sweep was abandoned", advisory: null };
  }
  if (siteHost(cfg.site).toLowerCase() !== DEFAULT_JIRA_SITE) {
    return {
      issues: [],
      error: `UpstartClaw queries Upstart Jira only - set the site to ${DEFAULT_JIRA_SITE} or select the local Jira query method`,
      advisory: null,
    };
  }
  const ready = await deps.ready();
  if (ctx.signal.aborted) {
    return { issues: [], error: "the sweep was abandoned", advisory: null };
  }
  if (!ready) {
    return {
      issues: [],
      error:
        "UpstartClaw is not installed and fully set up - install upstartclaw-core and run /upstartclaw-core:setup in an interactive Claude Code session",
      advisory: null,
    };
  }
  try {
    const trace = await deps.run(upstartClawPrompt(cfg, maxIssues), {
      timeoutMs: UPSTARTCLAW_TIMEOUT_MS,
      tools: UPSTARTCLAW_TOOLS,
      allowedTools: UPSTARTCLAW_TOOLS,
      settingSources: ["user"],
      cwd: ctx.repoRoot,
      signal: ctx.signal,
    });
    if (ctx.signal.aborted) {
      return { issues: [], error: "the sweep was abandoned", advisory: null };
    }
    return walkFromUpstartClawTrace(trace, cfg, maxIssues);
  } catch (error) {
    if (ctx.signal.aborted) {
      return { issues: [], error: "the sweep was abandoned", advisory: null };
    }
    const why = error instanceof Error ? error.message : String(error);
    return {
      issues: [],
      error: `UpstartClaw could not run this JQL${why ? ` - ${why}` : ""}`,
      advisory: null,
    };
  }
}

/**
 * Climb the auth ladder, and let the rung that can page do the paging.
 *
 * CLI first when it is installed - it needs no token and already knows the site, which is the
 * whole reason decision 9 preferred it. REST when the CLI is absent, when it failed (the
 * half-configured machine: `jira` on PATH, `jira init` never run, tokens exported for the shell
 * helpers), and now also when the CLI answered fine but the filter is BIGGER than the one request
 * that rung can make. That last case is the repair for Inspector rounds 7 and 9: an offset the
 * CLI ignores used to leave a CLI-only source filing nothing at all out of a large filter.
 *
 * With no credential to fall back on, the CLI's one request is still filed - work an operator
 * wants, deduped by the ledger like any other - alongside a sentence saying the tail is out of
 * reach and naming the two ways to change that. Loud AND useful, rather than loud instead of
 * useful.
 *
 * `maxPages` separates a sweep from a preflight probe: a probe spends one request and asks only
 * whether Jira answers this filter at all.
 */
async function ladder(cfg: JiraConfig, ctx: SweepContext, maxPages: number): Promise<JiraWalk> {
  const cred = restCredentialFrom(process.env);
  // Whether there IS a credential and whether it may be sent HERE are two questions, and the
  // second one decides whether the REST rung exists for this source at all. Keeping them separate
  // is what lets a self-hosted CLI operator who happens to have a token set carry on working: the
  // token simply is not a rung for their host, and the CLI still is.
  const targetProblem = cred ? credentialTargetProblem(cfg.site, process.env) : null;
  const restCred = cred && !targetProblem ? cred : null;

  if (await hasBin(jiraBin())) {
    const viaCli = await readCli(cfg, ctx);
    if (!viaCli.error) {
      // Complete in one request - the common case, and the cheapest.
      if (!viaCli.hasMore) return { issues: viaCli.issues, error: null, advisory: null };
      // There is a tail this rung cannot reach. Hand the whole filter to REST, which can - and
      // start it from the beginning rather than stitching, since its cursor is the authority on
      // ordering and the ledger makes a re-read of the first page free.
      if (restCred && !ctx.signal.aborted) return await walkRest(cfg, restCred, ctx, maxPages);
      // No usable REST rung. File what the one request read, and say which wall was hit - a
      // credential that may not be sent here is a different sentence from having none.
      return {
        issues: viaCli.issues,
        error: null,
        advisory: targetProblem ?? cliCannotPage(cfg),
      };
    }
    if (!restCred || ctx.signal.aborted) {
      // The CLI failed and there is no second rung to try. A credential that exists but may not be
      // used for this host is worth saying alongside the CLI's own failure, since the operator
      // would otherwise reasonably assume the fallback was attempted.
      return {
        issues: [],
        error: targetProblem ? `${viaCli.error}; ${targetProblem}` : viaCli.error,
        advisory: null,
      };
    }
    const viaRest = await walkRest(cfg, restCred, ctx, maxPages);
    if (!viaRest.error) return viaRest;
    return {
      issues: [],
      error: `${viaCli.error}; the REST fallback also failed: ${viaRest.error}`,
      advisory: null,
    };
  }
  if (!restCred) {
    return {
      issues: [],
      error: targetProblem ?? credentialGap(process.env) ?? NO_PATH,
      advisory: null,
    };
  }
  return walkRest(cfg, restCred, ctx, maxPages);
}

/** Sweep the configured JQL: every page of it, up to what one sweep may read. */
async function sweep(cfg: JiraConfig, ctx: SweepContext): Promise<SweepResult> {
  if (!cfg.jql.trim()) return { items: [], error: NO_JQL };
  const site = siteProblem(cfg.site);
  if (site) return { items: [], error: site };

  const walk =
    cfg.queryVia === "upstartclaw"
      ? await readUpstartClaw(cfg, ctx, MAX_SWEEP_ISSUES)
      : await ladder(cfg, ctx, sweepPages(cfg));
  return sweepResultFromWalk(walk, cfg, ctx);
}

/**
 * "Can this run at all?" - null when fine, else a sentence naming the fix.
 *
 * Ordered so the cheapest and most common misconfigurations answer without spending a
 * subprocess or a round trip, and so each answer names ONE thing to go and do:
 *
 *  1. an empty filter, which is storable and sweeps nothing;
 *  2. a site that is missing, malformed, or carrying a credential;
 *  3. no rung at all - neither the CLI nor a (whole) credential;
 *  4. whatever the real query says, which is what separates "not authenticated" from
 *     "cannot run this JQL". It runs the operator's own filter for ONE issue on ONE page, so
 *     it exercises the same ladder, the same auth and the same JQL the sweep will, and files
 *     nothing - a sweep RETURNS candidates, and only `ingest.ts` writes.
 *
 * Truncation is deliberately not consulted: a probe asks whether Jira answers, and a filter
 * being broader than one sweep is the sweep's report to make, not this one's.
 */
async function preflight(cfg: JiraConfig, ctx: SweepContext): Promise<string | null> {
  if (!cfg.jql.trim()) return NO_JQL;
  const site = siteProblem(cfg.site);
  if (site) return site;

  if (cfg.queryVia === "upstartclaw") {
    return (await readUpstartClaw({ ...cfg, limit: 1 }, ctx, 1)).error;
  }

  const cred = restCredentialFrom(process.env);
  if (!cred && !(await hasBin(jiraBin()))) return credentialGap(process.env) ?? NO_PATH;

  return (await ladder({ ...cfg, limit: 1 }, ctx, 1)).error;
}

// ---- writing back onto the issue a task was swept from ----
//
// Everything above this line READS. Everything below it WRITES onto a ticket in somebody's
// project, which is why it is arranged around a different rule than the sweep's.
//
// A sweep's worst failure is silence. A write-back's worst failure is a REPEAT: a comment
// posted twice is noise, and a transition applied twice undoes whoever moved the issue back.
// So three things are load-bearing here and nowhere above:
//
//   1. The remote link carries `globalId`, which makes it idempotent UPSTREAM - posting it
//      again updates the one link rather than adding a second. It therefore goes FIRST, so a
//      retry of a half-delivered annotate re-posts it for free while retrying the comment.
//   2. A run whose outcome cannot be READ reports `outcomeUnknown`, and the ledger never
//      retries one of those automatically. A timeout is not a refusal.
//   3. A resolve reads what the issue can actually do before it does anything, and refuses
//      with the names it found rather than guessing at a transition.
//
// Both verbs reuse the sweep's auth ladder rather than growing their own, and they must:
// `credentialTargetProblem` is the thing that stops `JIRA_API_TOKEN` being sent to a host
// that merely looks like Jira, and a write path with its own host handling would be a second
// place to get that wrong.

/** What to say when there is no rung that can write at all. Names BOTH fixes. */
const NO_WRITE_PATH =
  "no way to write to Jira: install the CLI (`brew install ankitpokhrel/jira-cli/jira-cli` " +
  "then `jira init`), or set JIRA_API_TOKEN and JIRA_EMAIL in the daemon's environment";

/**
 * What to say when a source that writes back queries through the read-only rung.
 *
 * `UPSTARTCLAW_JQL_TOOLS` is one search tool and nothing else, deliberately. Widening that
 * allowlist to a write tool is a separate consent decision - somebody's Claude plugin
 * gaining permission to move tickets - so a source on this rung refuses and names the two
 * rungs that can write, rather than failing obscurely at delivery.
 */
const UPSTARTCLAW_READ_ONLY =
  "the UpstartClaw connection is read-only - write-back needs the jira CLI, or " +
  "JIRA_API_TOKEN and JIRA_EMAIL in the daemon's environment";

/**
 * What to say when this machine cannot meet the refusal contract a resolve is held to.
 *
 * A misconfigured resolve owes the operator the transitions the issue can ACTUALLY reach,
 * and only a read of Jira produces that list. `jira issue move` can move an issue but cannot
 * be asked what an issue can do - jira-cli ships no command that lists transitions, and the
 * move's own error text lists them on recent versions and not on older ones. So on a machine
 * with no credential the good case works and the bad case is unactionable: "it would not
 * move", with nothing to do about it.
 *
 * Rather than discover that per issue, a resolve refuses UP FRONT when the read is not
 * available - before a subprocess, before anything upstream is touched, and naming the one
 * thing that fixes it. That is a narrower resolve than the phase file drew, which had both
 * rungs resolving; it is the honest shape once the listing contract is taken seriously.
 * `annotate` is unaffected and still works on the CLI alone.
 */
const RESOLVE_NEEDS_READ =
  "resolving an issue needs JIRA_API_TOKEN and JIRA_EMAIL in the daemon's environment: the " +
  "jira CLI can move an issue but cannot be asked which moves are available, so when a " +
  "target status does not fit, a refusal from that rung could not tell you what this issue " +
  "can reach instead. Set them, or turn this source's resolve switch off";

/** What to say when a source resolves issues without naming where they should land. */
const NO_TARGET_STATUS =
  "this source resolves issues but names no target status - set it to the status a finished " +
  "issue should land in, e.g. Done";

/**
 * A Jira issue key, and nothing that merely resembles one.
 *
 * `externalId` is whatever the sweep recorded, and it becomes a PATH SEGMENT on every write
 * below. Validated rather than escaped, because there is no such thing as a Jira key
 * carrying a slash or a query string: a value that is not one names no issue, so there is
 * nothing to write to and the right answer is to say so.
 */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** The issue this notice is about, or null when its id is not a Jira key at all. */
export function issueKeyFor(notice: WritebackNotice): string | null {
  const key = notice.externalId.trim();
  return ISSUE_KEY.test(key) ? key : null;
}

/** Longest a remote link title may be before Jira starts refusing it. */
const TITLE_LIMIT = 250;

function clipTo(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * What one write-back says, as the blocks a reader sees.
 *
 * One list rather than two renderings, because the REST rung needs ADF and the CLI rung
 * needs plain text, and "both say the same thing" is only checkable if there is one place
 * the words come from.
 *
 * Nothing about our internals goes in: no task id, no worktree, no status - the same
 * restraint the GitHub source's comment keeps, for the same reason. The person reading this
 * on their ticket is entitled to know what wrote it, and entitled to nothing else.
 */
export function writebackBlocks(notice: WritebackNotice): string[] {
  const blocks: string[] = [];
  if (notice.signal === "pr-opened") {
    blocks.push("Mission Control opened a pull request for this issue.");
    if (notice.prUrl) blocks.push(notice.prUrl);
  } else {
    blocks.push("Mission Control finished the task for this issue.");
    // The completion's OWN words when it left any. A completion with nothing to say gets no
    // invented sentence - the reader can see the pull request, which is the fact.
    if (notice.outcome?.trim()) blocks.push(notice.outcome.trim());
    if (notice.prUrl) blocks.push(`Pull request: ${notice.prUrl}`);
  }
  blocks.push(`Task: ${notice.taskTitle}`);
  return blocks;
}

/** The comment as the `jira` CLI takes it: plain text, one blank line between blocks. */
export function commentBodyText(notice: WritebackNotice): string {
  return writebackBlocks(notice).join("\n\n");
}

/**
 * The comment as Jira Cloud's v3 API takes it: ADF, a document tree rather than a string.
 *
 * The pull request url becomes a `link` mark rather than bare text, because an ADF comment
 * does NOT auto-link the way the older wiki-markup one did - a url posted as plain text
 * stays plain text, and the whole point of this comment is that somebody can click it.
 */
export function commentBodyAdf(notice: WritebackNotice): unknown {
  const url = notice.prUrl ?? "";
  const paragraph = (block: string): unknown => {
    const at = url ? block.indexOf(url) : -1;
    if (at < 0) return { type: "paragraph", content: [{ type: "text", text: block }] };
    const before = block.slice(0, at);
    const after = block.slice(at + url.length);
    return {
      type: "paragraph",
      content: [
        ...(before ? [{ type: "text", text: before }] : []),
        { type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] },
        ...(after ? [{ type: "text", text: after }] : []),
      ],
    };
  };
  return { type: "doc", version: 1, content: writebackBlocks(notice).map(paragraph) };
}

/**
 * The remote link one write-back puts on the issue.
 *
 * `globalId` is the whole reason a remote link is worth posting at all, and it is the pull
 * request's url on purpose: Jira treats that string as the link's identity, so POSTing this
 * a second time UPDATES the one link instead of adding another. That is the only idempotent
 * write in this file, which is why the annotate below does it first - a retry after a failed
 * comment re-posts the link for free rather than accumulating one per attempt.
 */
export function remoteLinkPayload(notice: WritebackNotice): unknown {
  const url = notice.prUrl ?? "";
  return {
    globalId: url,
    application: { type: "com.mission-control.task-sources", name: "Mission Control" },
    relationship: "mentioned in",
    object: {
      url,
      title: clipTo(`Pull request - ${notice.taskTitle}`, TITLE_LIMIT),
      summary: "Opened by Mission Control",
    },
  };
}

/**
 * The `jira issue comment add` argv.
 *
 * `--no-input` is not decoration. Without it the CLI asks for a confirmation, or opens an
 * editor, against a process that has no terminal - and the failure that produces is the
 * worst one available here: a 20s timeout with an unreadable outcome, which the ledger must
 * then refuse to retry.
 */
export function jiraCommentArgs(key: string, notice: WritebackNotice): string[] {
  return ["issue", "comment", "add", key, commentBodyText(notice), "--no-input"];
}

/** The `jira issue move` argv. The state is a positional, so this rung prompts for nothing. */
export function jiraMoveArgs(key: string, wanted: string): string[] {
  return ["issue", "move", key, wanted];
}

/** One transition Jira offers from where the issue is standing right now. */
export interface JiraTransition {
  id: string;
  name: string;
  /** The status it lands in, which is often what an operator typed instead of the name. */
  to: string;
}

function stringAt(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The transitions in a `GET /issue/{key}?expand=transitions` answer. */
export function transitionsFrom(body: unknown): JiraTransition[] {
  const rows = recordFrom(body)?.transitions;
  if (!Array.isArray(rows)) return [];
  const out: JiraTransition[] = [];
  for (const row of rows) {
    const t = recordFrom(row);
    if (!t) continue;
    const id =
      typeof t.id === "string" ? t.id.trim() : typeof t.id === "number" ? String(t.id) : "";
    if (!id) continue;
    out.push({ id, name: stringAt(t, "name"), to: stringAt(recordFrom(t.to), "name") });
  }
  return out;
}

/** Where the issue is standing right now, or "" when Jira did not say. */
export function currentStatusFrom(body: unknown): string {
  return stringAt(recordFrom(recordFrom(recordFrom(body)?.fields)?.status), "name");
}

/**
 * The transition that reaches the status this source names, or why none does.
 *
 * Matched against the transition's own NAME first and its target STATUS second, because an
 * operator reading their Jira board sees the status ("Done") while the workflow's button may
 * be called something else ("Finish work"), and both are reasonable things to have typed.
 * Case-insensitive for the same reason.
 *
 * The no-match sentence is this phase's main product, and it lists what IS available on
 * purpose. Guessing at a nearby transition would move somebody's ticket somewhere they did
 * not ask for; a bare "transition failed" would send them to Jira's workflow admin screens
 * to work out what this source should have been set to. The names Jira just handed back are
 * the answer, and they are specific to where the issue is standing - which is why they
 * cannot be listed once in a settings panel and have to arrive at the moment of refusal.
 */
export function transitionFor(
  available: unknown,
  wanted: string,
  issue: { key: string; status: string },
): { id: string } | { problem: string } {
  const want = wanted.trim().toLowerCase();
  const rows = transitionsFrom(available);
  const hit =
    rows.find((t) => t.name.toLowerCase() === want) ??
    rows.find((t) => t.to.toLowerCase() === want);
  if (hit) return { id: hit.id };

  const from = issue.status ? ` from "${issue.status}"` : "";
  const offered = rows
    .map((t) =>
      t.to && t.to.toLowerCase() !== t.name.toLowerCase() ? `${t.name} (to ${t.to})` : t.name,
    )
    .filter((name) => name.length > 0);
  if (offered.length === 0) {
    return {
      problem:
        `${issue.key} offers no transitions${from}, so it cannot be moved to "${wanted}" - ` +
        "check the Jira workflow, and that this account is allowed to transition the issue",
    };
  }
  return {
    problem:
      `${issue.key} cannot move to "${wanted}"${from} - available from here: ` +
      `${offered.join(", ")}. Set this source's resolve status to one of those`,
  };
}

/**
 * `credentialTargetProblem`'s own refusal, recognised on the way back out.
 *
 * It travels as a `status: 0` answer so one reader handles every failure, and it must not
 * then be dressed up as a transport failure: nothing was sent, so "could not reach Jira" is
 * both wrong and the opposite of the point.
 */
const EGRESS_REFUSAL = /^refusing to send JIRA_API_TOKEN/i;

/**
 * Transport failures that PROVE the request never arrived.
 *
 * Everything else that throws out of `fetch` is UNKNOWN, and the distinction is the whole
 * reason this list exists. A refused connection or an unresolvable host cannot have been
 * read by Jira. A timeout, an aborted socket or a connection reset can have been - the
 * request may have been read and acted on, and only the answer went missing. Calling that
 * one a refusal would let the ledger retry a transition that already happened.
 */
const NEVER_ARRIVED =
  /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_TLS|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i;

/** Why one REST write failed, in the operator's terms. `restFailure`'s sibling for writes. */
export function restWriteFailure(res: RestAnswer, cfg: JiraConfig): string {
  const why = restMessage(res.body);
  const host = siteHost(cfg.site) || "the configured site";
  if (res.status === 0) {
    if (EGRESS_REFUSAL.test(res.body)) return res.body;
    return `could not reach Jira at ${host}${why ? ` - ${why}` : ""}`;
  }
  if (res.status === 401 || res.status === 403) {
    return (
      `Jira refused this write (HTTP ${res.status})${why ? ` - ${why}` : ""} - check that ` +
      "JIRA_EMAIL is allowed to comment on and transition this issue"
    );
  }
  if (res.status === 404) {
    return `Jira has no such issue at ${host} (HTTP 404)${why ? ` - ${why}` : ""}`;
  }
  // A 400 is where a transition screen's required field shows up, and Jira's own first error
  // message is the only place that information exists - so it is quoted, not summarised.
  return `Jira refused this write (HTTP ${res.status})${why ? ` - ${why}` : ""}`;
}

/** A write-back that never left the process. `outcomeUnknown: false` is a fact, not a hope. */
function writebackRefusal(error: string): WritebackResult {
  return { error, outcomeUnknown: false, detail: null };
}

/** A write-back that landed, with the one line the panel shows for it. */
function writebackDone(detail: string): WritebackResult {
  return { error: null, outcomeUnknown: false, detail };
}

/**
 * The hedge a write that MAY have landed carries. See `WritebackResult.outcomeUnknown`.
 */
const UNKNOWN_OUTCOME = " - the write may have landed; check the issue in Jira before retrying";

/**
 * Read one failed REST write.
 *
 * `outcomeUnknown` means "Jira MAY have done this and we cannot tell", and it is the only
 * answer the ledger will not retry on its own. A status at all means Jira ANSWERED: it read
 * the request and refused it, so nothing was written and a retry is safe once the
 * configuration is fixed. Only a total absence of an answer is ambiguous, and even then the
 * cause code often settles it.
 *
 * Takes the config because a REST failure names the HOST it could not reach. Its CLI sibling
 * below deliberately does not: the CLI authenticates against whatever site its own
 * configuration points at, which this source cannot see, so there is no host for it to name
 * and nothing for it to want from a `JiraConfig`.
 */
export function restWritebackFailure(
  res: RestAnswer,
  cfg: JiraConfig,
  label: string,
): WritebackResult {
  const unknown =
    res.status === 0 && !NEVER_ARRIVED.test(res.body) && !EGRESS_REFUSAL.test(res.body);
  return {
    error: `${label} - ${restWriteFailure(res, cfg)}${unknown ? UNKNOWN_OUTCOME : ""}`,
    outcomeUnknown: unknown,
    detail: null,
  };
}

/** Read one failed CLI write, under the same rule. A child that never reported is unknown. */
export function cliWritebackFailure(
  res: CliRun,
  label: string,
  verb: string,
): WritebackResult {
  const unknown = cliFault(res) === "no-answer";
  return {
    error: `${label} - ${cliFailure(res, verb)}${unknown ? UNKNOWN_OUTCOME : ""}`,
    outcomeUnknown: unknown,
    detail: null,
  };
}

/** Read one `jira issue move` run. */
export function cliMoveResult(res: CliRun, key: string, wanted: string): WritebackResult {
  // Only two answers reach here. A resolve requires the read rung (`RESOLVE_NEEDS_READ`), so
  // a CLI move that RAN and refused is handed to that rung instead - it can say what the
  // issue reaches, which is the sentence the operator is owed and this one cannot produce.
  if (res.outcomeUnknown) {
    return cliWritebackFailure(res, `${key} could not be moved to "${wanted}"`, "jira issue move");
  }
  return writebackDone(`moved to "${wanted}"`);
}

/** Which rungs may write for this source, and why the REST one may not when it may not. */
interface WriteRungs {
  /** The `jira` CLI, when it resolves. It authenticates with its OWN configuration. */
  cli: boolean;
  /** The env credential, when there is a whole one AND it may be sent to this site. */
  rest: JiraRestCredential | null;
  /** Why there is no REST rung, in the operator's terms. Empty when there is one. */
  restProblem: string;
}

async function writeRungs(cfg: JiraConfig): Promise<WriteRungs> {
  const cred = restCredentialFrom(process.env);
  // The same two questions the sweep's `ladder` keeps apart, for the same reason: a
  // self-hosted operator working through the CLI is unaffected by a token that may not be
  // sent to their host, because that token simply is not a rung for them.
  const target = cred ? credentialTargetProblem(cfg.site, process.env) : null;
  return {
    cli: await hasBin(jiraBin()),
    rest: cred && !target ? cred : null,
    restProblem: target ?? credentialGap(process.env) ?? (cred ? "" : NO_WRITE_PATH),
  };
}

/**
 * One authenticated request against the issue, on the REST rung. Never throws.
 *
 * `ctx.signal` is deliberately NOT consulted, unlike `restSearch`'s. The contract says
 * nothing cancels a write that has already left, and honouring an abort here would turn a
 * daemon shutdown into an unreadable outcome on a request Jira was about to answer - which
 * the ledger would then refuse to retry. The 20s budget is the real bound, and the only one.
 */
async function restIssueCall(
  cfg: JiraConfig,
  cred: JiraRestCredential,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<RestAnswer> {
  // The authoritative check, at the rung that actually attaches the credential. `writeRungs`
  // asks the same predicate to decide whether this rung exists, and that is routing; this is
  // the control. A security refusal enforced only by its caller is one refactor from gone.
  const target = credentialTargetProblem(cfg.site, process.env);
  if (target) return { ok: false, status: 0, body: target };

  const basic = Buffer.from(`${cred.email}:${cred.token}`, "utf8").toString("base64");
  const json = init.body === undefined ? null : JSON.stringify(init.body);
  try {
    const res = await fetch(`https://${siteHost(cfg.site)}${path}`, {
      method: init.method,
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/json",
        ...(json === null ? {} : { "content-type": "application/json" }),
      },
      ...(json === null ? {} : { body: json }),
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
  } catch (err) {
    // The message and the cause code, never the request: a thrown fetch must not carry the
    // Authorization header into a panel or a log line. `restSearch`'s rule, and it matters
    // more here, because a write's error text is what the operator is sent to go and read.
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
    const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: `${message}${code}` };
  }
}

/** The checks both verbs make before anything leaves the process. */
function writeTarget(
  cfg: JiraConfig,
  notice: WritebackNotice,
): { key: string } | { problem: string } {
  if (cfg.queryVia === "upstartclaw") return { problem: UPSTARTCLAW_READ_ONLY };
  const site = siteProblem(cfg.site);
  if (site) return { problem: site };
  const key = issueKeyFor(notice);
  if (!key) {
    return {
      problem: `"${clipTo(notice.externalId, 60)}" is not a Jira issue key, so there is nothing here to write to`,
    };
  }
  return { key };
}

/** Post the comment: the CLI when it can, the credential when it cannot. */
async function postComment(
  cfg: JiraConfig,
  rungs: WriteRungs,
  key: string,
  notice: WritebackNotice,
): Promise<WritebackResult> {
  if (rungs.cli) {
    const res = await run(jiraBin(), jiraCommentArgs(key, notice), { timeoutMs: JIRA_TIMEOUT_MS });
    if (res.code === 0) return writebackDone("commented");
    // Fall through to REST only when the CLI itself is the problem. A CLI that ran and was
    // refused has already been to Jira once, and a second attempt is a second comment.
    if (!rungs.rest || res.outcomeUnknown || !cliRungUnusable(res)) {
      return cliWritebackFailure(res, "the comment could not be posted", "jira issue comment add");
    }
  }
  if (!rungs.rest) {
    return writebackRefusal(
      `the comment could not be posted - ${rungs.restProblem || NO_WRITE_PATH}`,
    );
  }
  const res = await restIssueCall(cfg, rungs.rest, `/rest/api/3/issue/${key}/comment`, {
    method: "POST",
    body: { body: commentBodyAdf(notice) },
  });
  if (!res.ok) return restWritebackFailure(res, cfg, "the comment could not be posted");
  return writebackDone("commented");
}

/**
 * Put the pull request onto the issue: a remote link, a comment, or both.
 *
 * The two halves answer different questions, which is why `linkVia` offers both and defaults
 * to it: the remote link is where a person looks for "what work touched this ticket", and
 * the comment is what reaches the activity feed and a notification.
 *
 * The remote link is REST-only, and that is a property of jira-cli rather than a decision -
 * it has no remote-link command at all. On a CLI-only machine that half is reported as
 * UNAVAILABLE rather than failed, and the comment still goes. Failing the whole delivery
 * would retry a comment that has no idempotency of its own, so a machine that can never post
 * the link would accumulate one comment per attempt while still never posting it.
 *
 * `ctx` is not read, so it is not taken. Nothing cancels a write that has already left, and
 * the CLI rung reads its own configuration rather than the repo's - the two things a
 * `WritebackContext` could offer.
 */
async function annotate(cfg: JiraConfig, notice: WritebackNotice): Promise<WritebackResult> {
  const target = writeTarget(cfg, notice);
  if ("problem" in target) return writebackRefusal(target.problem);
  const rungs = await writeRungs(cfg);
  if (!rungs.cli && !rungs.rest) return writebackRefusal(rungs.restProblem || NO_WRITE_PATH);

  const wantLink = cfg.linkVia !== "comment";
  const wantComment = cfg.linkVia !== "remote-link";
  /** What landed, in the order it landed. */
  const done: string[] = [];
  /** Halves with nothing to do, which is not a failure and not fixable by retrying. */
  const idle: string[] = [];
  /** Halves this machine cannot perform, which IS fixable and says how. */
  const unavailable: string[] = [];

  if (wantLink) {
    if (!notice.prUrl) {
      idle.push("no pull request to link");
    } else if (!rungs.rest) {
      unavailable.push(
        `the remote link needs the REST rung (the jira CLI cannot post one) - ${rungs.restProblem || NO_WRITE_PATH}`,
      );
    } else {
      const res = await restIssueCall(
        cfg,
        rungs.rest,
        `/rest/api/3/issue/${target.key}/remotelink`,
        { method: "POST", body: remoteLinkPayload(notice) },
      );
      // Reported before the comment is attempted, so a retry repeats a link that updates in
      // place rather than a comment that duplicates.
      if (!res.ok) return restWritebackFailure(res, cfg, "the remote link could not be posted");
      done.push("linked");
    }
  }

  if (wantComment) {
    const res = await postComment(cfg, rungs, target.key, notice);
    if (res.error) {
      // The link's state is worth saying out loud on the way out, because it changes what a
      // retry does: it re-posts one link rather than adding a second.
      return done.length === 0
        ? res
        : {
            ...res,
            error: `${res.error} (the remote link is posted; a retry updates it in place rather than adding a second)`,
          };
    }
    done.push("commented");
  }

  if (done.length === 0) {
    // Nothing TO do is a delivery, and marking it one is what stops the ledger retrying a
    // notice that will never have anything to say. Nothing POSSIBLE is a refusal.
    if (unavailable.length === 0) return writebackDone(idle.join("; ") || "nothing to write");
    return writebackRefusal(`nothing could be written to ${target.key} - ${unavailable.join("; ")}`);
  }
  return writebackDone([done.join(" and "), ...idle, ...unavailable].join("; "));
}

/** Move the issue on the REST rung: read what it can do, match, then do exactly that. */
async function restResolve(
  cfg: JiraConfig,
  cred: JiraRestCredential,
  key: string,
  wanted: string,
): Promise<WritebackResult> {
  // One request for both facts: `expand=transitions` returns what the issue can do and
  // `fields=status` where it is standing - and the refusal sentence has to name both.
  const read = await restIssueCall(
    cfg,
    cred,
    `/rest/api/3/issue/${key}?fields=status&expand=transitions`,
    { method: "GET" },
  );
  if (!read.ok) return restWritebackFailure(read, cfg, `${key} could not be read`);
  let body: unknown;
  try {
    body = JSON.parse(read.body);
  } catch {
    return writebackRefusal(
      `Jira's answer for ${key} was not JSON, so its transitions could not be read`,
    );
  }

  const status = currentStatusFrom(body);
  // Already there. Reported as success rather than moved again, for the reason the GitHub
  // source treats an already-closed issue as success: the desired state holds, and applying
  // a transition to reach a status the issue is already in is at best a no-op and at worst
  // an extra entry in somebody's history.
  if (status && status.toLowerCase() === wanted.toLowerCase()) {
    return writebackDone(`already "${status}"`);
  }

  const match = transitionFor(body, wanted, { key, status });
  if ("problem" in match) return writebackRefusal(match.problem);

  const post = await restIssueCall(cfg, cred, `/rest/api/3/issue/${key}/transitions`, {
    method: "POST",
    body: { transition: { id: match.id } },
  });
  if (!post.ok) return restWritebackFailure(post, cfg, `${key} could not be moved to "${wanted}"`);
  return writebackDone(`moved to "${wanted}"`);
}

/**
 * Move the issue to the status this source names.
 *
 * The one verb in this feature that changes an item's STATE, which sets the standard for
 * every refusal in it: an empty target status is answered before anything leaves the
 * process, and a target the issue cannot reach is answered with the ones it can. Guessing
 * would move somebody's ticket somewhere they did not ask for.
 *
 * The CLI rung goes first, exactly as a sweep's does and for the same reason - it needs no
 * token and already knows the site. It hands off to REST only when the CLI itself is
 * unusable, never when Jira refused the move: that request already arrived.
 */
async function resolve(cfg: JiraConfig, notice: WritebackNotice): Promise<WritebackResult> {
  const wanted = cfg.resolveTransition.trim();
  // First, and without a subprocess or a round trip: a resolve with nowhere to go is a
  // misconfiguration, and no amount of asking Jira will discover what the operator meant.
  if (!wanted) return writebackRefusal(NO_TARGET_STATUS);
  const target = writeTarget(cfg, notice);
  if ("problem" in target) return writebackRefusal(target.problem);
  const rungs = await writeRungs(cfg);
  // Before a subprocess and before anything upstream is touched: this verb's refusal owes the
  // operator the transitions the issue can actually reach, and only a read of Jira produces
  // that list. Without the read rung the good case would work and the bad case would be
  // unactionable, so the capability is required rather than discovered one issue at a time.
  if (!rungs.rest) {
    return writebackRefusal(
      rungs.restProblem
        ? `${RESOLVE_NEEDS_READ} (${rungs.restProblem})`
        : RESOLVE_NEEDS_READ,
    );
  }

  if (rungs.cli) {
    const res = await run(jiraBin(), jiraMoveArgs(target.key, wanted), {
      timeoutMs: JIRA_TIMEOUT_MS,
    });
    // Moved, or we cannot tell whether it moved. An unreadable outcome must never be retried
    // on the other rung: this is the verb that changes state, and a second attempt at a
    // transition that already happened is the one mistake this feature must not make.
    if (res.code === 0 || res.outcomeUnknown) return cliMoveResult(res, target.key, wanted);
    // The CLI ran and did not move the issue - a refused transition is not a partial one, so
    // nothing changed upstream and the read rung takes over. It is preferred even when the
    // CLI merely refused, because the refusal has to name what the issue CAN reach and only
    // a read produces that; jira-cli sometimes prints its own list and sometimes just says no.
  }
  return restResolve(cfg, rungs.rest, target.key, wanted);
}

export const jira: TaskSourceImpl<JiraConfig> = {
  // Spread rather than restated: the kind, the name, the blurb and the success sentence are
  // the half the settings panel renders in the browser, and it cannot import this file. The
  // schema is re-named only to recover its type - it is the same object.
  ...TASK_SOURCE_KIND_INFO["jira"],
  configSchema: JiraConfigSchema,
  preflight,
  sweep,
  // Present because the kind's `canAnnotate` / `canResolve` say so - the contract test holds
  // the two together in both directions, so neither half may land without the other.
  annotate,
  resolve,
};
