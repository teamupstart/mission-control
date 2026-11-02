import type { JiraConfig, SweepContext } from "@shared/task-source.ts";
import { acliBin } from "../config.ts";
import { run, type RunResult } from "../util/exec.ts";
import { issuesFrom, MAX_SWEEP_ISSUES, siteHost, tooBroad, type JiraWalk } from "./jira.ts";

/** Status, search and status again fit inside the sweeper's 60-second deadline. */
const ACLI_TIMEOUT_MS = 15_000;

export interface JiraAcliDeps {
  run: typeof run;
}
const defaultDeps: JiraAcliDeps = { run };

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
    const servicePath = /^https:\/\/jira-prod-[a-z]{2}-\d+-\d+\.prod\.atl-paas\.net(\/rest\/api\/3\/issue\/\d+)$/.exec(self)?.[1];
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
