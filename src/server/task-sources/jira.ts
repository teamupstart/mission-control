import type {
  JiraConfig,
  SweepContext,
  SweepResult,
  TaskCandidate,
  TaskSourceImpl,
} from "@shared/task-source.ts";
import { JiraConfigSchema, TASK_SOURCE_KIND_INFO } from "@shared/task-source.ts";
import type { TaskPriority } from "@shared/types.ts";
import { hasBin, run } from "../util/exec.ts";
import type { RunResult } from "../util/exec.ts";

// The second task source: a JQL filter as a backlog queue.
//
// Auth is a LADDER, and no rung of it stores a secret. The operator's own `jira` CLI
// (`ankitpokhrel/jira-cli`) is tried first - it is the standard install in Upstart's
// onboarding docs, it already knows the site and the login, and using it is the same trade
// the GitHub source makes with `gh`. When it is absent (or present and unusable) the sweep
// falls back to Jira's REST API with `JIRA_API_TOKEN` + `JIRA_EMAIL` read from the daemon's
// own environment - the convention those same operators already have exported. Nothing is
// written to `app_config`, so there is no token in this app's database to leak.
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
 * the same `{issues: […]}` envelope with token pagination instead of `startAt`. Pagination
 * is deliberately not used: one sweep asks for `limit` issues and files what it gets, and
 * the ledger in `task_source_seen` is what makes the next sweep pick up where this one
 * stopped.
 */
const REST_SEARCH_PATH = "/rest/api/3/search/jql";

/** What to say when there is no way to reach Jira at all. Names BOTH fixes. */
const NO_PATH =
  "no way to reach Jira: install the CLI (`brew install ankitpokhrel/jira-cli/jira-cli` " +
  "then `jira init`), or set JIRA_API_TOKEN and JIRA_EMAIL in the daemon's environment";

/** What to say about an empty filter, which is storable but unusable. */
const NO_JQL = "set a JQL query in this source's settings - an empty filter sweeps nothing";

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
 * The bare host of a configured site.
 *
 * Operators paste what their browser shows them - `https://acme.atlassian.net/jira/software/...`
 * - and a source configured that way must not build `https://https://acme…`. The scheme,
 * any path and any trailing slash are dropped; the port is kept, because a self-hosted
 * instance needs it.
 */
export function siteHost(site: string): string {
  return site
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\/+$/, "");
}

/**
 * The `jira issue list` argv for this config.
 *
 * `--raw` is the load-bearing flag: it prints the API's own JSON, which is the SAME
 * envelope the REST rung reads, so both rungs share one mapper and one set of tests rather
 * than adding a table-parser that would break on a truncated column. No limit flag is
 * passed - jira-cli has spelled that argument differently across versions, and an unknown
 * flag would take the CLI rung out entirely - so the cap is applied when reading instead
 * (`candidatesFrom`), which bounds both rungs identically.
 */
export function jiraIssueListArgs(cfg: JiraConfig): string[] {
  return ["issue", "list", "--jql", cfg.jql.trim(), "--raw"];
}

/**
 * The REST search URL for this config.
 *
 * Encoded with `encodeURIComponent` rather than `URLSearchParams`, which spells a space as
 * `+`: that is correct for a form body and merely conventional in a query string, and a JQL
 * query is mostly spaces. `%20` is unambiguous everywhere, including to whatever proxy sits
 * between the daemon and Jira.
 */
export function searchUrl(cfg: JiraConfig): string {
  const query = [
    `jql=${encodeURIComponent(cfg.jql.trim())}`,
    `maxResults=${encodeURIComponent(String(cfg.limit))}`,
    `fields=${encodeURIComponent(REST_FIELDS)}`,
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
    return new URL(self).host;
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

/** Map a page of issues, dropping the ones we cannot name, and honour the configured cap. */
function candidatesFrom(issues: JiraIssue[], cfg: JiraConfig, ctx: SweepContext): TaskCandidate[] {
  return issues
    .slice(0, cfg.limit)
    .map((i) => candidateFrom(i, cfg, ctx))
    .filter((c): c is TaskCandidate => c !== null);
}

/**
 * Read a JSON body as a list of issues.
 *
 * One reader for both rungs: `jira issue list --raw` prints the API's own
 * `{"issues": […]}` envelope, and a bare array is accepted too so a wrapper or a future
 * CLI version that unwraps it does not read as "no work".
 */
export function issuesFrom(text: string): { issues: JiraIssue[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() || "{}");
  } catch {
    return { error: "Jira returned output that is not JSON" };
  }
  const envelope = (parsed as { issues?: unknown } | null)?.issues;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(envelope) ? envelope : null;
  // Malformed output is an anomaly, not "no issues" - the same reading the GitHub source
  // takes of a `gh` that answered with something unexpected.
  if (!list) return { error: "Jira returned an unexpected shape" };
  return { issues: list as JiraIssue[] };
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

/**
 * Read one `jira issue list --raw` run as a sweep result.
 *
 * The rule this holds, on every branch: a non-zero exit, unparseable output or an
 * abandoned run becomes `{items: [], error}` and NEVER an empty success.
 */
export function sweepResultFromCli(res: CliRun, cfg: JiraConfig, ctx: SweepContext): SweepResult {
  if (res.code !== 0) {
    // The one non-zero exit that is not a failure: the CLI's way of saying the filter
    // matched nothing. Reporting it would make a healthy, up-to-date source look broken.
    if (CLI_EMPTY.test(`${res.stderr}\n${res.stdout}`)) return { items: [], error: null };
    return { items: [], error: cliFailure(res) };
  }
  if (ctx.signal.aborted) return { items: [], error: "the sweep was abandoned" };
  const read = issuesFrom(res.stdout);
  if ("error" in read) return { items: [], error: read.error };
  return { items: candidatesFrom(read.issues, cfg, ctx), error: null };
}

/** Read one REST search as a sweep result, under the same rule. */
export function sweepResultFromRest(
  res: RestAnswer,
  cfg: JiraConfig,
  ctx: SweepContext,
): SweepResult {
  if (!res.ok) return { items: [], error: restFailure(res, cfg) };
  if (ctx.signal.aborted) return { items: [], error: "the sweep was abandoned" };
  const read = issuesFrom(res.body);
  if ("error" in read) return { items: [], error: read.error };
  return { items: candidatesFrom(read.issues, cfg, ctx), error: null };
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
): Promise<RestAnswer> {
  const basic = Buffer.from(`${cred.email}:${cred.token}`, "utf8").toString("base64");
  try {
    const res = await fetch(searchUrl(cfg), {
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
 * Sweep the configured JQL, climbing the auth ladder.
 *
 * CLI first when it is installed, REST when it is not - and REST as a RETRY when the CLI is
 * installed but could not answer, which is the common half-configured machine (jira-cli on
 * PATH, `jira init` never run, tokens exported for the shell helpers). Reporting a broken
 * source while a working path sits unused would be accurate and useless. If both rungs
 * fail, both reasons are reported: the operator has two things to look at and needs to know
 * which is which.
 */
async function sweep(cfg: JiraConfig, ctx: SweepContext): Promise<SweepResult> {
  if (!cfg.jql.trim()) return { items: [], error: NO_JQL };
  if (!siteHost(cfg.site)) return { items: [], error: noSite() };

  const cred = restCredentialFrom(process.env);
  // The CLI inherits the daemon's environment, which is where `JIRA_API_TOKEN` already is
  // for the operators who have one - so nothing has to be passed through explicitly.
  if (await hasBin(JIRA_BIN)) {
    const viaCli = sweepResultFromCli(
      await run(JIRA_BIN, jiraIssueListArgs(cfg), { timeoutMs: JIRA_TIMEOUT_MS }),
      cfg,
      ctx,
    );
    if (!viaCli.error || !cred || ctx.signal.aborted) return viaCli;
    const viaRest = sweepResultFromRest(await restSearch(cfg, cred, ctx), cfg, ctx);
    if (!viaRest.error) return viaRest;
    return { items: [], error: `${viaCli.error}; the REST fallback also failed: ${viaRest.error}` };
  }

  if (!cred) return { items: [], error: credentialGap(process.env) ?? NO_PATH };
  return sweepResultFromRest(await restSearch(cfg, cred, ctx), cfg, ctx);
}

function noSite(): string {
  return "this source has no Jira site - set it to your Jira host, e.g. your-org.atlassian.net";
}

/**
 * "Can this run at all?" - null when fine, else a sentence naming the fix.
 *
 * Ordered so the cheapest and most common misconfigurations answer without spending a
 * subprocess or a round trip, and so each answer names ONE thing to go and do:
 *
 *  1. an empty filter, which is storable and sweeps nothing;
 *  2. no site to ask;
 *  3. no rung at all - neither the CLI nor a (whole) credential;
 *  4. whatever the real query says, which is what separates "not authenticated" from
 *     "cannot run this JQL". It runs the operator's own filter bounded to one issue, so it
 *     exercises the same ladder, the same auth and the same JQL the sweep will, and files
 *     nothing - a sweep RETURNS candidates, and only `ingest.ts` writes.
 */
async function preflight(cfg: JiraConfig, ctx: SweepContext): Promise<string | null> {
  if (!cfg.jql.trim()) return NO_JQL;
  if (!siteHost(cfg.site)) return noSite();

  const cred = restCredentialFrom(process.env);
  if (!cred && !(await hasBin(JIRA_BIN))) return credentialGap(process.env) ?? NO_PATH;

  return (await sweep({ ...cfg, limit: 1 }, ctx)).error;
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
