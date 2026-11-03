import type { JiraConfig, SweepContext, WritebackNotice, WritebackResult } from "@shared/task-source.ts";
import { acliBin } from "../config.ts";
import { run, type RunResult } from "../util/exec.ts";
import {
  commentBodyAdf, currentStatusFrom, issuesFrom, MAX_SWEEP_ISSUES, NO_TARGET_STATUS,
  siteHost, tooBroad, transitionFor, transitionsFrom, UNKNOWN_OUTCOME,
  writebackDone, writebackRefusal, writeTarget, type JiraWalk,
} from "./jira.ts";

/** Status, search and status again fit inside the sweeper's 60-second deadline. */
const ACLI_TIMEOUT_MS = 15_000;

export interface JiraAcliDeps {
  run: typeof run;
}
const defaultDeps: JiraAcliDeps = { run };

const SERVICE_ISSUE_URL = /^https:\/\/jira-prod-[a-z]{2}-\d+-\d+\.prod\.atl-paas\.net(\/rest\/api\/3\/issue\/\d+)$/;
/** The status and category self URLs in the captured view are also tenant-neutral. */
const SERVICE_STATUS_URL = /^https:\/\/jira-prod-[a-z]{2}-\d+-\d+\.prod\.atl-paas\.net\/rest\/api\/3\/(?:status|statuscategory)\/\d+$/;

/** --paginate honors --limit as a total ceiling, verified against six matching issues. */
export function acliSearchArgs(cfg: JiraConfig, limit: number): string[] {
  return [
    "jira", "workitem", "search", "--jql", cfg.jql.trim(),
    "--fields", "key,summary,description,priority", "--json",
    "--limit", String(limit + 1), "--paginate",
  ];
}

export type AcliFault =
  | "no-answer"
  | "not-installed"
  | "unauthenticated"
  | "unsupported-flag"
  | "refused";

export function acliFault(res: RunResult): AcliFault {
  if (res.outcomeUnknown) return "no-answer";
  if (res.code === 127 || /\bENOENT\b|was not found in the executable environment/i.test(res.stderr)) return "not-installed";
  if (/unauthorized|auth login/i.test(res.stderr)) return "unauthenticated";
  if (/unknown flag/i.test(res.stderr)) return "unsupported-flag";
  return "refused";
}

/** Keep acli's reason, but explain the operator action rather than its exit code. */
export function acliFailure(res: RunResult): string {
  switch (acliFault(res)) {
    case "no-answer":
      if (res.overflowed) return "acli returned too much output to read - narrow the JQL and run Check it works again";
      return "acli did not answer - check your connection and run Check it works again";
    case "not-installed":
      return "acli is not installed - run `brew tap atlassian/homebrew-acli && brew install acli`";
    case "unauthenticated":
      return "acli is not logged in to Jira - run `acli jira auth login --web`";
    case "unsupported-flag":
      return "acli does not support the required flags - run `brew upgrade acli`";
    case "refused": {
      const why = res.stderr.trim().split(/\r?\n/)[0]?.replace(/^(?:✗\s*)?Error:\s*/i, "").slice(0, 300);
      return `acli refused this Jira query${why ? `: ${why}` : ""} - check the JQL and your Jira access`;
    }
  }
}

/** Only the Jira-specific status proves the active site; global OAuth can be logged out. */
export function acliActiveSite(res: RunResult): string | null {
  if (res.code !== 0 || res.outcomeUnknown) return null;
  const sites = [...res.stdout.matchAll(/^\s*Site:\s*(\S+)\s*$/gim)];
  return sites.length === 1 ? siteHost(sites[0]![1]!) || null : null;
}

function siteMismatch(active: string, configured: string): string {
  return `acli is logged in to ${active}, but this source uses ${configured} - run \`acli jira auth switch\` to select ${configured}`;
}

/** Rechecked before EVERY operation, because the operator can switch acli profiles anytime. */
export async function acliSiteGate(
  cfg: JiraConfig,
  ctx: SweepContext,
  deps: JiraAcliDeps = defaultDeps,
): Promise<string | null> {
  if (ctx.signal.aborted) return "the sweep was abandoned";
  const res = await deps.run(acliBin(), ["jira", "auth", "status"], {
    cwd: ctx.repoRoot, timeoutMs: ACLI_TIMEOUT_MS, input: "",
  });
  if (ctx.signal.aborted) return "the sweep was abandoned";
  if (res.code !== 0 || res.outcomeUnknown) return acliFailure(res);
  const active = acliActiveSite(res);
  if (!active) return "cannot confirm which Jira site acli is logged in to - run `acli jira auth login --web` and check `acli jira auth status`";
  const configured = siteHost(cfg.site);
  return active === configured ? null : siteMismatch(active, configured);
}

/**
 * Captured OAuth results carry tenant-neutral Jira service URLs, not public browse hosts.
 * Accept only that HTTPS issue-URL format and rewrite it for the shared mapper. These URLs
 * do not prove tenant identity: auth status must match both before and after the search.
 * Other hosts still refuse the entire walk, including a mismatched probe row.
 */
function normalizeSearchSites(issues: JiraWalk["issues"], cfg: JiraConfig): string | null {
  const configured = siteHost(cfg.site);
  for (const issue of issues) {
    if (issue.self === undefined || issue.self === null) continue;
    const self = typeof issue.self === "string" ? issue.self : "";
    const host = siteHost(self);
    if (!host) return "cannot confirm the Jira site in acli's search response - check `acli jira auth status` and try again";
    if (host === configured) continue;
    const servicePath = SERVICE_ISSUE_URL.exec(self)?.[1];
    if (!servicePath) return siteMismatch(host, configured);
    issue.self = `https://${configured}${servicePath}`;
  }
  return null;
}

export async function readAcli(
  cfg: JiraConfig,
  ctx: SweepContext,
  maxIssues: number,
  deps: JiraAcliDeps = defaultDeps,
): Promise<JiraWalk> {
  const refused = (error: string): JiraWalk => ({ issues: [], error, advisory: null });
  const gate = await acliSiteGate(cfg, ctx, deps);
  if (gate) return refused(gate);
  const bound = Math.max(1, Math.min(MAX_SWEEP_ISSUES, maxIssues));
  const res = await deps.run(acliBin(), acliSearchArgs(cfg, bound), {
    cwd: ctx.repoRoot, timeoutMs: ACLI_TIMEOUT_MS, input: "",
  });
  if (ctx.signal.aborted) return refused("the sweep was abandoned");
  if (res.code !== 0 || res.outcomeUnknown) return refused(acliFailure(res));
  const page = issuesFrom(res.stdout);
  if ("error" in page) return refused(page.error);
  const mismatch = normalizeSearchSites(page.issues, cfg);
  if (mismatch) return refused(mismatch);
  const afterSearch = await acliSiteGate(cfg, ctx, deps);
  if (afterSearch) return refused(afterSearch);
  return {
    issues: page.issues.slice(0, bound), error: null,
    advisory: page.issues.length > bound ? tooBroad(cfg) : null,
  };
}

/** Same site proof and real JQL as a sweep, without filing anything or reporting its tail. */
export async function acliPreflight(
  cfg: JiraConfig,
  ctx: SweepContext,
  deps: JiraAcliDeps = defaultDeps,
): Promise<string | null> {
  return (await readAcli(cfg, ctx, 1, deps)).error;
}

export function acliCommentArgs(key: string, notice: WritebackNotice): string[] {
  return ["jira", "workitem", "comment", "create", "--key", key, "--body", JSON.stringify(commentBodyAdf(notice))];
}

function jsonBody(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return null; }
}

function record(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : null;
}

/** Inspect every envelope; captured issue/status service URLs cannot prove tenant identity. */
function responseSiteProblem(body: unknown, cfg: JiraConfig): string | null {
  const pending = [body];
  const configured = siteHost(cfg.site);
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const entry of value) pending.push(entry);
      continue;
    }
    const row = record(value);
    if (!row) continue;
    if (row.self != null) {
      const self = typeof row.self === "string" ? row.self : "";
      const host = siteHost(self);
      // OAuth's captured issue URLs are tenant-neutral. Auth checks bracket every read/write.
      if (!host) return "cannot confirm the Jira site in acli's response";
      if (host !== configured && !SERVICE_ISSUE_URL.test(self) && !SERVICE_STATUS_URL.test(self)) {
        return `acli's response names ${host}, but this source uses ${configured}`;
      }
    }
    for (const child of Object.values(row)) pending.push(child);
  }
  return null;
}

function unknownWrite(key: string, cfg: JiraConfig, reason: string): WritebackResult {
  return {
    error: `${key} at ${siteHost(cfg.site)}: ${reason}${UNKNOWN_OUTCOME}`,
    outcomeUnknown: true, detail: null,
  };
}

/** A write is never delivered on exit code alone: the active site must still be proven. */
async function afterWrite(
  cfg: JiraConfig, key: string, res: RunResult, ctx: SweepContext, deps: JiraAcliDeps,
): Promise<WritebackResult | null> {
  const gate = await acliSiteGate(cfg, ctx, deps);
  const response = responseSiteProblem(jsonBody(res.stdout), cfg);
  if (gate || response) {
    return unknownWrite(key, cfg, `${[gate, response].filter(Boolean).join("; ")} - check both sites before retrying`);
  }
  if (acliFault(res) === "no-answer") return unknownWrite(key, cfg, "acli did not answer the write");
  return null;
}

/** Preserve the write's own reason without the read-only classifier's JQL advice. */
function writeReason(res: RunResult): string {
  if (acliFault(res) !== "refused") return acliFailure(res);
  return res.stderr.trim().replace(/^(?:✗\s*)?Error:\s*/i, "").slice(0, 500) || "acli refused without a reason";
}

export async function acliAnnotate(
  cfg: JiraConfig, notice: WritebackNotice, ctx: SweepContext, deps: JiraAcliDeps = defaultDeps,
): Promise<WritebackResult> {
  const target = writeTarget(cfg, notice);
  if ("problem" in target) return writebackRefusal(target.problem);
  const gate = await acliSiteGate(cfg, ctx, deps);
  if (gate) return writebackRefusal(`${gate}, so nothing was written`);
  const res = await deps.run(acliBin(), acliCommentArgs(target.key, notice), {
    cwd: ctx.repoRoot, timeoutMs: ACLI_TIMEOUT_MS, input: "",
  });
  const uncertain = await afterWrite(cfg, target.key, res, ctx, deps);
  if (uncertain) return uncertain;
  if (res.code !== 0) return writebackRefusal(`the comment could not be posted - acli said: ${writeReason(res)}`);
  const failure = writeResponseFailure(jsonBody(res.stdout));
  if (failure) return writebackRefusal(`the comment could not be posted - acli said: ${failure}`);
  const link = cfg.linkVia === "comment" ? "" : notice.prUrl
    ? "; the remote link is unavailable (acli cannot post one); the comment carries the pull request link"
    : "; no pull request to link";
  return writebackDone(`commented${link}`);
}

/** Every status read has fresh site proof on both sides, including an already-there read. */
async function readStatus(
  cfg: JiraConfig, key: string, ctx: SweepContext, deps: JiraAcliDeps,
): Promise<{ status: string; body: unknown } | { problem: string }> {
  const gate = await acliSiteGate(cfg, ctx, deps);
  if (gate) return { problem: gate };
  const res = await deps.run(acliBin(), ["jira", "workitem", "view", key, "--fields", "status", "--json"], {
    cwd: ctx.repoRoot, timeoutMs: ACLI_TIMEOUT_MS, input: "",
  });
  if (res.code !== 0 || res.outcomeUnknown) return { problem: `${key} could not be read - ${acliFailure(res)}` };
  const body = jsonBody(res.stdout);
  const site = responseSiteProblem(body, cfg);
  if (site) return { problem: site };
  const status = currentStatusFrom(body);
  if (!status) return { problem: `${key}'s current status could not be read from acli's answer` };
  const after = await acliSiteGate(cfg, ctx, deps);
  return after ? { problem: after } : { status, body };
}

/** Read explicit failures from acli's JSON write result. */
function writeResponseFailure(body: unknown): string | null {
  if (Array.isArray(body)) {
    for (const entry of body) {
      const problem = writeResponseFailure(entry);
      if (problem) return problem;
    }
    return null;
  }
  const row = record(body);
  if (!row) return null;
  for (const name of ["error", "errors", "errorMessages"]) {
    const value = row[name];
    if (value && value !== "" && JSON.stringify(value) !== "[]" && JSON.stringify(value) !== "{}") {
      return typeof value === "string" ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500);
    }
  }
  if (row.success === false || /^(failed|failure|error)$/i.test(String(row.status))) {
    return String(row.message || row.status || "acli reported failure").slice(0, 500);
  }
  for (const value of Object.values(row)) {
    const problem = writeResponseFailure(value);
    if (problem) return problem;
  }
  return null;
}

export async function acliResolve(
  cfg: JiraConfig, notice: WritebackNotice, ctx: SweepContext, deps: JiraAcliDeps = defaultDeps,
): Promise<WritebackResult> {
  const wanted = cfg.resolveTransition.trim();
  if (!wanted) return writebackRefusal(NO_TARGET_STATUS);
  const target = writeTarget(cfg, notice);
  if ("problem" in target) return writebackRefusal(target.problem);
  const key = target.key;
  const read = await readStatus(cfg, key, ctx, deps);
  if ("problem" in read) return writebackRefusal(`${read.problem}, so nothing was written`);
  if (read.status.toLowerCase() === wanted.toLowerCase()) return writebackDone(`already "${read.status}"`);
  // Captured *all has transitions:null, so there is no speculative extra probe. Honor a
  // list if supplied, including an empty list, and use the destination status for --status.
  let destination = wanted;
  if (Array.isArray(record(read.body)?.transitions)) {
    const match = transitionFor(read.body, wanted, { key, status: read.status });
    if ("problem" in match) return writebackRefusal(match.problem);
    const transition = transitionsFrom(read.body).find((t) => t.id === match.id)!;
    destination = transition.to || transition.name;
  }
  // readStatus's final gate is immediately before this write, with only pure parsing between.
  const res = await deps.run(acliBin(), ["jira", "workitem", "transition", "--key", key, "--status", destination, "--yes", "--json"], {
    cwd: ctx.repoRoot, timeoutMs: ACLI_TIMEOUT_MS, input: "",
  });
  const uncertain = await afterWrite(cfg, key, res, ctx, deps);
  if (uncertain) return uncertain;
  const refused = (status: string, reason: string) => writebackRefusal(
    `${key} cannot move to "${wanted}" from "${status}" - acli said: ${reason}. Set this source's resolve status to one the issue can reach`,
  );
  if (res.code !== 0) return refused(read.status, writeReason(res));
  const failure = writeResponseFailure(jsonBody(res.stdout));
  if (failure) return refused(read.status, failure);
  const confirmed = await readStatus(cfg, key, ctx, deps);
  if ("problem" in confirmed) return unknownWrite(key, cfg, `the move could not be confirmed - ${confirmed.problem}`);
  if (confirmed.status.toLowerCase() !== destination.toLowerCase()) {
    return refused(confirmed.status, res.stdout.trim().slice(0, 500) || "the confirming read still shows another status");
  }
  return writebackDone(`moved to "${confirmed.status}"`);
}
