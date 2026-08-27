import type {
  JiraConfig,
  SweepContext,
  SweepResult,
  TaskCandidate,
  TaskSourceImpl,
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

/** The CLI this source prefers, when the operator has it. */
export const JIRA_BIN = "jira";

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

/** The exact skill and deferred MCP tool observed in a working Upstart Jira query. */
export const UPSTARTCLAW_JIRA_SKILL = "upstartclaw-core:working-with-jira";
export const UPSTARTCLAW_JQL_TOOL =
  "mcp__plugin_upstartclaw-core_atlassian__searchJiraIssuesUsingJql";
const UPSTARTCLAW_CLOUD_ID = "d30daf5c-29ad-4817-bd10-bdd85ae8455f";
const UPSTARTCLAW_TOOLS = `Skill,ToolSearch,${UPSTARTCLAW_JQL_TOOL}`;

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

/** Why one `jira` run failed, in the operator's terms - naming the fix where we can tell. */
export function cliFailure(res: CliRun): string {
  const why = firstLine(res.stderr || res.stdout);
  // The child DIED rather than answering, so there is no stderr to quote and a bare "failed"
  // would be the whole diagnosis. The usual cause is a CLI waiting on a prompt it will never
  // get - it has a terminal's habits and this one has no terminal.
  if (res.outcomeUnknown) {
    return `the jira CLI did not answer within ${Math.round(JIRA_TIMEOUT_MS / 1000)}s${
      why ? ` - ${why}` : ""
    } - it may be waiting for input, which a background sweep cannot give it`;
  }
  // `run` reports a missing binary through the callback with Node's own message, so this
  // covers a `jira` that vanished between the PATH check and the spawn. Matched narrowly:
  // a bare /not found/ also matches jira-cli's own "config file not found", which is a
  // different state with a different fix and is diagnosed below.
  if (res.code === 127 || /ENOENT|command not found|No such file or directory/i.test(res.stderr)) {
    return "the jira CLI could not be run - reinstall it (`brew install ankitpokhrel/jira-cli/jira-cli`), or set JIRA_API_TOKEN and JIRA_EMAIL to use the REST fallback";
  }
  if (looksUnconfigured(`${res.stderr}\n${res.stdout}`)) {
    return `the jira CLI is installed but not configured${why ? ` - ${why}` : ""} - run \`jira init\`, or set JIRA_API_TOKEN and JIRA_EMAIL to use the REST fallback`;
  }
  if (looksUnauthenticated(`${res.stderr}\n${res.stdout}`)) {
    return `the jira CLI is not authenticated${why ? ` - ${why}` : ""} - export JIRA_API_TOKEN and run \`jira init\` if you have not`;
  }
  // A CLI that does not know `--paginate` cannot be asked for a bounded page, and a sweep
  // that cannot page cannot reach past the first one. Named as its own state because the fix
  // is neither the token nor the query: upgrade it, or let the REST rung do the paging.
  if (/unknown flag|unknown shorthand|flag provided but not defined|--paginate/i.test(res.stderr)) {
    return `this jira CLI does not support \`--paginate\`${why ? ` - ${why}` : ""} - upgrade it (\`brew upgrade jira-cli\`), or set JIRA_API_TOKEN and JIRA_EMAIL so the REST rung can page`;
  }
  return `jira issue list failed${why ? `: ${why}` : ""}`;
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
  const page = pageFromCli(await run(JIRA_BIN, jiraIssueListArgs(cfg), { timeoutMs: JIRA_TIMEOUT_MS }));
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
    `Then use ToolSearch to load ${UPSTARTCLAW_JQL_TOOL} and call that tool directly.`,
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
  const calls = trace.toolCalls.filter((call) => call.name === UPSTARTCLAW_JQL_TOOL);
  if (calls.length === 0) {
    return upstartClawFailure("UpstartClaw did not call its Atlassian JQL search tool");
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

  if (await hasBin(JIRA_BIN)) {
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
  if (!cred && !(await hasBin(JIRA_BIN))) return credentialGap(process.env) ?? NO_PATH;

  return (await ladder({ ...cfg, limit: 1 }, ctx, 1)).error;
}

export const jira: TaskSourceImpl<JiraConfig> = {
  // Spread rather than restated: the kind, the name, the blurb and the success sentence are
  // the half the settings panel renders in the browser, and it cannot import this file. The
  // schema is re-named only to recover its type - it is the same object.
  ...TASK_SOURCE_KIND_INFO["jira"],
  configSchema: JiraConfigSchema,
  preflight,
  sweep,
};
