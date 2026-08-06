import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_JIRA_SITE,
  JiraConfigSchema,
  type JiraConfig,
  type SweepContext,
} from "../src/shared/task-source.ts";
import {
  browseUrlFor,
  candidateFrom,
  cliFailure,
  credentialGap,
  appendCapped,
  externalIdFor,
  freshKeys,
  issuesFrom,
  jiraIssueListArgs,
  nextPage,
  plainTextFrom,
  priorityFor,
  restCredentialFrom,
  restFailure,
  restMessage,
  searchUrl,
  pageFromCli,
  pageFromRest,
  siteHost,
  siteProblem,
  sweepResultFromWalk,
  type RestAnswer,
} from "../src/server/task-sources/jira.ts";
import { stubRun } from "../src/server/util/exec.ts";
import type { RunResult } from "../src/server/util/exec.ts";

// What is at stake: four things a background Jira sweep gives nobody the chance to notice.
//
//  - A missing, half-set or rejected credential must read as a SENTENCE NAMING THE FIX. An
//    empty sweep is indistinguishable from a filter with no matching issues, so a broken
//    source would sit there quietly for as long as it takes somebody to wonder why the
//    backlog stopped growing. Every failure below has to carry a reason.
//  - `externalId` is the de-duplication key, and for Jira it is the issue key. If it ever
//    moved, every issue already in the backlog would be filed a second time.
//  - The description arrives as ADF (a nested document) on Jira Cloud v3 and as a string
//    elsewhere. Pasting the JSON into an agent's first prompt is worse than carrying
//    nothing: the model spends its first turn deciding whether the JSON is the task.
//  - The one non-zero exit that is NOT a failure: jira-cli says "no result found" and exits
//    1 when the filter matched nothing, which must not report a healthy source as broken.
//
// Pure seams only - nothing here spawns a subprocess or opens a socket. The ladder itself
// (CLI, then REST) is exercised in `jira-preflight.test.ts` against a fake binary.

const cfg = (over: Partial<JiraConfig> = {}): JiraConfig =>
  JiraConfigSchema.parse({ jql: "project = MC", ...over });

const ctx: SweepContext = {
  sourceId: "src-1",
  repoRoot: "/repo",
  signal: new AbortController().signal,
};

/**
 * One rung answer as a whole sweep result - the same two calls production makes for a single
 * page (`pageFrom*` then `sweepResultFromWalk`), composed here rather than behind a wrapper in
 * the module, so nothing is exported for tests alone and this cannot drift from the real path.
 */
const cliResult = (res: RunResult, c: JiraConfig = cfg(), context: SweepContext = ctx) =>
  sweepResultFromWalk({ ...pageFromCli(res), truncated: false }, c, context);

const restResult = (res: RestAnswer, c: JiraConfig = cfg(), context: SweepContext = ctx) =>
  sweepResultFromWalk({ ...pageFromRest(res, c), truncated: false }, c, context);

/** The value that follows `flag` in an argv, or undefined. */
function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const ISSUE = {
  key: "MC-42",
  self: "https://acme.atlassian.net/rest/api/3/issue/10042",
  fields: {
    summary: "Widgets leak on resize",
    description: "Steps: resize the window twice.",
    priority: { name: "High" },
  },
};

// ---- configuration the operator types ----

test("an empty config is usable enough to store, and says what it defaults to", () => {
  const fresh = JiraConfigSchema.parse({});
  assert.equal(fresh.site, DEFAULT_JIRA_SITE, "a freshly added source stores {}");
  assert.equal(fresh.jql, "", "no filter yet - preflight and sweep both refuse it by name");
  assert.equal(fresh.limit, 50);
  assert.equal(fresh.priorityFromJira, true);
});

// Operators paste what the browser shows them, and a source configured that way must not
// build `https://https://acme…` and report the host as unreachable.
test("a pasted browser URL is reduced to the host it names", () => {
  assert.equal(siteHost("acme.atlassian.net"), "acme.atlassian.net");
  assert.equal(siteHost("https://acme.atlassian.net"), "acme.atlassian.net");
  assert.equal(siteHost("  https://acme.atlassian.net/jira/software/c/projects/MC  "), "acme.atlassian.net");
  assert.equal(siteHost("http://jira.internal:8080/browse/MC-1"), "jira.internal:8080", "a port survives");
  assert.equal(siteHost("   "), "", "nothing configured is answerable as nothing");
});

// THE credential boundary, and the reason the host is the URL parser's answer rather than a
// regex's. `https://acme.atlassian.net@evil.example` reads as the company's Jira and is not:
// the parser takes `acme.atlassian.net` as USERINFO and `evil.example` as the host, so a
// reduction that only stripped the scheme and the path would hand the whole string back,
// `https://${host}` would rebuild it unchanged, and the request - carrying JIRA_API_TOKEN in
// an Authorization header - would go to somebody else's server. Refused, not repaired.
test("a site carrying a credential is refused, not reduced", () => {
  for (const hostile of [
    "https://acme.atlassian.net@evil.example",
    "acme.atlassian.net@evil.example",
    "https://user:pass@evil.example",
    "https://acme.atlassian.net@evil.example/rest/api/3/search/jql",
  ]) {
    assert.equal(siteHost(hostile), "", `${hostile} must not resolve to a target`);
    // And the operator is told which mistake this is, since "no Jira site" would send them
    // looking for an empty field they can see is not empty.
    assert.match(siteProblem(hostile)!, /credential/);
    assert.match(siteProblem(hostile)!, /JIRA_API_TOKEN would be sent/);
  }
  // The host that string was trying to look like still works on its own.
  assert.equal(siteHost("acme.atlassian.net"), "acme.atlassian.net");
  assert.equal(siteProblem("acme.atlassian.net"), null);
});

test("a site that is not a host at all is named as that, and nothing else is a target", () => {
  assert.match(siteProblem("")!, /no Jira site/);
  assert.match(siteProblem("   ")!, /no Jira site/);
  // Not http(s) - a scheme that would never be a Jira, and `https://${host}` would smuggle it.
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "not a host", "http://"]) {
    assert.equal(siteHost(bad), "", `${bad} must not resolve to a target`);
    assert.ok(siteProblem(bad), `${bad} must be explained`);
  }
  assert.match(siteProblem("not a host")!, /is not a Jira host/);
});

// ---- the two rungs' requests ----

// `--raw` is what makes both rungs share one mapper: it prints the API's own envelope
// instead of a column layout that truncates.
test("the CLI is asked for the API's own JSON, with the filter as one argument", () => {
  const args = jiraIssueListArgs(cfg({ jql: "  project = MC AND status = Open  ", limit: 50 }));
  assert.deepEqual(args, [
    "issue",
    "list",
    "--jql",
    "project = MC AND status = Open",
    "--paginate",
    "0:50",
    "--raw",
  ]);
  assert.equal(args.includes("--plain"), false, "table output would need a parser and truncates");
});

// The defect this argument exists for: without a page bound, the CLI's own default decided
// what was fetched, every sweep re-read that same leading page, and a filter matching more
// than one page could never reach the rest of itself - forever, and looking healthy.
test("the CLI is asked for a specific page, so the walk can advance", () => {
  assert.equal(argAfter(jiraIssueListArgs(cfg({ limit: 25 }), 0), "--paginate"), "0:25");
  assert.equal(argAfter(jiraIssueListArgs(cfg({ limit: 25 }), 25), "--paginate"), "25:25");
  assert.equal(argAfter(jiraIssueListArgs(cfg({ limit: 25 }), 200), "--paginate"), "200:25");
});

// The endpoint matters: v3's plain `/search` is retired on Jira Cloud, and a source pointed
// at it would report HTTP 410/404 forever with a perfectly good credential.
test("the REST rung asks the enhanced search endpoint, with the filter encoded", () => {
  const raw = searchUrl(
    cfg({ site: "https://acme.atlassian.net/", jql: 'project = MC AND status = "To Do"', limit: 7 }),
  );
  const url = new URL(raw);
  assert.equal(url.origin, "https://acme.atlassian.net");
  assert.equal(url.pathname, "/rest/api/3/search/jql");
  assert.equal(url.searchParams.get("jql"), 'project = MC AND status = "To Do"');
  assert.equal(url.searchParams.get("maxResults"), "7");
  assert.equal(url.searchParams.get("fields"), "summary,description,priority");
  // A JQL query is mostly spaces, and `+` for a space is correct in a form body but only
  // conventional in a query string. `%20` is unambiguous to whatever proxy is in the way.
  assert.match(raw, /jql=project%20%3D%20MC/);
  assert.doesNotMatch(raw, /\+/);
});

// The cursor goes on the URL only when there is one, so page 1 asks with no token at all.
test("a later page carries Jira's own cursor", () => {
  assert.doesNotMatch(searchUrl(cfg()), /nextPageToken/);
  const page2 = new URL(searchUrl(cfg(), "tok/2+3"));
  assert.equal(page2.searchParams.get("nextPageToken"), "tok/2+3");
  assert.match(searchUrl(cfg(), "tok/2+3"), /nextPageToken=tok%2F2%2B3/, "opaque, so fully encoded");
});

// ---- paging, which is the difference between reaching the tail of a filter and never ----

// What is at stake: a filter matching more than one page used to be read only as its first
// page, so once those issues were in `task_source_seen` every later sweep re-fetched the same
// leading rows, reported them as already filed, and the rest of the filter was unreachable -
// permanently, and looking exactly like an upstream with no new work.
//
// The two bounds are pinned here rather than through a walk because reaching the ceiling for
// real costs a thousand issues.
test("a full page means keep going, a short page means the filter is exhausted", () => {
  assert.equal(nextPage({ fetched: 50, pagesUsed: 1, hasMore: true }, 20), "more");
  assert.equal(nextPage({ fetched: 12, pagesUsed: 1, hasMore: false }, 20), "done");
  assert.equal(nextPage({ fetched: 0, pagesUsed: 1, hasMore: false }, 20), "done");
});

test("the walk stops at its own ceiling, and says the filter is bigger than a sweep", () => {
  // Out of pages...
  assert.equal(nextPage({ fetched: 500, pagesUsed: 20, hasMore: true }, 20), "truncated");
  // ...or out of issues, whichever comes first. Both must stop, or a 40,000-issue filter is a
  // sweep that never ends.
  assert.equal(nextPage({ fetched: 1000, pagesUsed: 3, hasMore: true }, 500), "truncated");
  assert.equal(nextPage({ fetched: 999, pagesUsed: 3, hasMore: true }, 500), "more");
});

// How the walk tells "the next page" from "the same page again", which is what a rung that
// accepts a pagination argument and ignores it hands back. Counting mutates `seen` on purpose:
// the count is only meaningful relative to everything collected before it.
test("a page's new keys are counted once, and remembered", () => {
  const seen = new Set<string>();
  assert.equal(freshKeys([{ key: "MC-1" }, { key: "MC-2" }], seen), 2);
  assert.equal(freshKeys([{ key: "MC-2" }, { key: "MC-3" }], seen), 1, "MC-2 was already held");
  assert.equal(freshKeys([{ key: "MC-1" }, { key: "MC-3" }], seen), 0, "the same page again");
  assert.deepEqual([...seen], ["MC-1", "MC-2", "MC-3"]);
  // A row with no key cannot be counted or compared - it is dropped by the mapper anyway.
  assert.equal(freshKeys([{ fields: { summary: "no key" } }], seen), 0);
});

// `nextPage` checks the total AFTER a page is added, which is one page too late to be a cap: at
// a page size of 199 the budget allows six requests, so six full pages would put 1,194 issues in
// hand while every sentence about them quotes 1,000. Pages are clipped on the way in instead,
// and a clip is also the most reliable tail signal there is - rows the walk saw and could not
// keep prove the filter continues, with no lookahead and no inference from a full page.
test("a page is clipped to the cap on the way in, and the clip proves a tail", () => {
  const issue = (n: number) => ({ key: `MC-${n}` });
  const held = Array.from({ length: 950 }, (_, i) => issue(i));

  // Room for 50 more, and a 199-issue page arrives.
  const page = Array.from({ length: 199 }, (_, i) => issue(1000 + i));
  const { kept, clipped } = appendCapped(held, page);
  assert.equal(kept.length, 50, "only what fits");
  assert.equal(held.length, 1000, "exactly the cap, never past it");
  assert.equal(clipped, true, "rows were seen and not kept, so the filter continues");

  // Full is full: a further page contributes nothing and is still a clip.
  const again = appendCapped(held, [issue(9000)]);
  assert.deepEqual(again.kept, []);
  assert.equal(again.clipped, true);
  assert.equal(held.length, 1000);
});

test("a page that fits is kept whole, and is not a tail signal", () => {
  const held = [{ key: "MC-1" }];
  const { kept, clipped } = appendCapped(held, [{ key: "MC-2" }, { key: "MC-3" }]);
  assert.equal(kept.length, 2);
  assert.equal(clipped, false, "nothing was left behind, so this says nothing about a tail");
  assert.equal(held.length, 3);
});

// Truncation is REPORTED, and the items still come back. Both halves matter: ingest should
// file the unseen ones it did reach, and the operator has to learn that the tail of this
// filter is unreachable however many times the sweep runs. Silence there would be the same
// defect as an empty sweep on a broken credential.
test("a truncated walk files what it read AND names what to change", () => {
  const walk = {
    issues: [ISSUE, { ...ISSUE, key: "MC-43" }],
    error: null,
    truncated: true,
  };
  const r = sweepResultFromWalk(walk, cfg(), ctx);
  assert.equal(r.items.length, 2, "what it did read is still filed");
  assert.match(r.error!, /larger than one sweep can read \(1000 issues or 50 requests/);
  assert.match(r.error!, /narrow the JQL/);
  // Two bounds, so two fixes: a small page size is what a big filter outran, and saying so
  // only where it applies keeps the sentence about one thing.
  assert.doesNotMatch(r.error!, /Issues per page/, "at the default page size, that is not the fix");
  assert.match(sweepResultFromWalk(walk, cfg({ limit: 5 }), ctx).error!, /raise Issues per page/);
});

test("an untruncated walk is a clean success", () => {
  const r = sweepResultFromWalk({ issues: [ISSUE], error: null, truncated: false }, cfg(), ctx);
  assert.equal(r.error, null);
  assert.equal(r.items.length, 1);
});

// A rung failure mid-walk is fatal, and never a partial success: pages 1-3 arriving and page 4
// failing must not read as "the filter holds three pages".
test("a rung that fails mid-walk reports the failure rather than the pages it had", () => {
  const r = sweepResultFromWalk(
    { issues: [ISSUE], error: "jira issue list failed: boom", truncated: false },
    cfg(),
    ctx,
  );
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /boom/);
});

// ---- the credential, which is never stored ----

test("the REST credential needs both halves, and half of one is named as such", () => {
  assert.deepEqual(restCredentialFrom({ JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" }), {
    email: "a@b.c",
    token: "t",
  });
  assert.equal(restCredentialFrom({ JIRA_EMAIL: " ", JIRA_API_TOKEN: "t" }), null);
  assert.equal(restCredentialFrom({}), null);

  // The misconfiguration that looks like configuration: the operator did the work, and a
  // generic "set both" would send them looking for something they already did.
  assert.match(credentialGap({ JIRA_API_TOKEN: "t" })!, /JIRA_EMAIL is not/);
  assert.match(credentialGap({ JIRA_EMAIL: "a@b.c" })!, /JIRA_API_TOKEN is not/);
  assert.equal(credentialGap({ JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" }), null);
  assert.equal(credentialGap({}), null, "neither set is 'not configured', not 'half configured'");
});

// ---- identity ----

// Jira's own key, taken from the issue rather than composed, for the reason the GitHub
// source reads its id off the URL: a changed id re-files what is already in the backlog.
test("the external id is the issue key, and a row without one is not filed at all", () => {
  assert.equal(externalIdFor(ISSUE), "MC-42");
  assert.equal(externalIdFor({ key: "  MC-7 " }), "MC-7");
  assert.equal(externalIdFor({}), null);
  assert.equal(candidateFrom({ ...ISSUE, key: undefined }, cfg(), ctx), null);
  assert.equal(candidateFrom({ ...ISSUE, fields: { summary: "  " } }, cfg(), ctx), null);
});

// The CLI keeps its own site configuration, which this source cannot see - so a link built
// only from `site` would point at the wrong Jira the moment the two disagree.
test("the browse link prefers the host Jira itself answered from", () => {
  assert.equal(browseUrlFor(ISSUE, cfg({ site: "other.atlassian.net" })), "https://acme.atlassian.net/browse/MC-42");
  assert.equal(
    browseUrlFor({ key: "MC-9" }, cfg({ site: "https://acme.atlassian.net" })),
    "https://acme.atlassian.net/browse/MC-9",
  );
  assert.equal(browseUrlFor({ key: "MC-9" }, cfg({ site: "" })), null);
});

// ---- the description, in either shape ----

test("an ADF description becomes the text a human wrote", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Resize twice." }] },
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { text: "@ana" } },
          { type: "text", text: " saw it too." },
          { type: "hardBreak" },
          { type: "text", text: "Second line." },
        ],
      },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "macOS" }] }] },
        ],
      },
    ],
  };
  const text = plainTextFrom(adf);
  assert.match(text, /Resize twice\./);
  assert.match(text, /@ana saw it too\.\nSecond line\./);
  assert.match(text, /macOS/, "an unknown wrapper node recurses rather than dropping its text");
  assert.doesNotMatch(text, /"type"|paragraph/, "the document tree itself never reaches a prompt");
  assert.doesNotMatch(text, /\n{3,}/, "blocks are separated, not padded");
});

test("a plain-string description (Jira v2, on-premise) is carried as it is", () => {
  assert.equal(plainTextFrom("  Steps: resize.  "), "Steps: resize.");
  assert.equal(plainTextFrom(null), "");
  assert.equal(plainTextFrom(undefined), "");
  assert.equal(plainTextFrom({ type: "doc", content: [] }), "");
});

// ---- priority ----

test("Jira's own priority names map onto the task's, case-insensitively", () => {
  assert.equal(priorityFor("Highest", cfg()), "blocker");
  assert.equal(priorityFor("p0", cfg()), "blocker");
  assert.equal(priorityFor("High", cfg()), "high");
  assert.equal(priorityFor("Medium", cfg()), "med");
  assert.equal(priorityFor("  lowest  ", cfg()), "low");
  // A per-project scheme nobody here has heard of leaves the priority open, so the source's
  // own default applies instead of an invented one.
  assert.equal(priorityFor("Yesterday", cfg()), null);
  assert.equal(priorityFor(undefined, cfg()), null);
  // Switched off, Jira's opinion is not consulted at all.
  assert.equal(priorityFor("Highest", cfg({ priorityFromJira: false })), null);
});

// The distinction that decides whether the source's default priority ever applies. An
// unmapped issue has NO OPINION (the key is absent), which ingest fills from the default; a
// candidate carrying `priority: null` says "deliberately unset" and ingest honours that.
test("an unmapped priority leaves the key ABSENT, so the source's default applies", () => {
  const c = candidateFrom({ ...ISSUE, fields: { ...ISSUE.fields, priority: { name: "Whenever" } } }, cfg(), ctx)!;
  assert.equal("priority" in c, false, "a null here would suppress the source's default");
  assert.equal(candidateFrom(ISSUE, cfg(), ctx)!.priority, "high");
  assert.equal("priority" in candidateFrom(ISSUE, cfg({ priorityFromJira: false }), ctx)!, false);
});

// ---- the candidate ----

test("an issue becomes a candidate carrying its text, its link and its identity", () => {
  const c = candidateFrom(ISSUE, cfg(), ctx)!;
  assert.equal(c.title, "Widgets leak on resize");
  assert.deepEqual(c.ref, {
    sourceId: "src-1",
    externalId: "MC-42",
    url: "https://acme.atlassian.net/browse/MC-42",
  });
  assert.equal(c.repoRoot, "/repo");
  assert.match(c.intent, /^Jira issue MC-42: Widgets leak on resize/);
  assert.match(c.intent, /https:\/\/acme\.atlassian\.net\/browse\/MC-42/);
  assert.match(c.intent, /resize the window twice/);
});

test("an issue with no description still says something rather than nothing", () => {
  const c = candidateFrom({ ...ISSUE, fields: { summary: "Bare" } }, cfg(), ctx)!;
  assert.match(c.intent, /no description/);
});

test("an enormous description is truncated, and says so", () => {
  const c = candidateFrom({ ...ISSUE, fields: { ...ISSUE.fields, description: "x".repeat(20_000) } }, cfg(), ctx)!;
  assert.ok(c.intent.length < 6000);
  assert.match(c.intent, /description truncated/);
});

// ---- reading a page of issues ----

test("both the API envelope and a bare array read as issues", () => {
  assert.deepEqual(issuesFrom('{"issues":[{"key":"MC-1"}]}'), {
    issues: [{ key: "MC-1" }],
    nextPageToken: null,
  });
  assert.deepEqual(issuesFrom('[{"key":"MC-1"}]'), {
    issues: [{ key: "MC-1" }],
    nextPageToken: null,
  });
  assert.match((issuesFrom("<html>") as { error: string }).error, /not JSON/);
  assert.match((issuesFrom('{"total":3}') as { error: string }).error, /unexpected shape/);
});

// The cursor the enhanced endpoint hands back, carried through so the walk can ask for the
// next page. Absent on the last page, and absent from a rung that has no cursor at all.
test("a page carries the cursor Jira sent, and none when there isn't one", () => {
  const more = issuesFrom('{"issues":[{"key":"MC-1"}],"nextPageToken":"tok-2"}');
  assert.equal("nextPageToken" in more && more.nextPageToken, "tok-2");
  const last = issuesFrom('{"issues":[{"key":"MC-9"}]}');
  assert.equal("nextPageToken" in last && last.nextPageToken, null);
  const blank = issuesFrom('{"issues":[],"nextPageToken":"   "}');
  assert.equal("nextPageToken" in blank && blank.nextPageToken, null, "whitespace is not a cursor");
});

// ---- the CLI rung's failures ----

test("a non-zero jira exit is an error, never an empty success", () => {
  const r = cliResult(stubRun({ stdout: "", stderr: "boom: bad flag", code: 1 }));
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /jira issue list failed: boom: bad flag/);
});

// A credential problem has a different fix from a broken query, so it gets a different
// sentence - that is the whole reason `preflight` is separate from `sweep`.
test("an unauthenticated CLI names the credential, not the query", () => {
  const r = cliResult(
    stubRun({ stdout: "", stderr: "Received unexpected response '401 Unauthorized'", code: 1 }),
  );
  assert.match(r.error!, /not authenticated/);
  assert.match(r.error!, /JIRA_API_TOKEN/);
  assert.match(cliFailure(stubRun({ stdout: "", stderr: "spawn jira ENOENT", code: 1 })), /reinstall it/);
  assert.match(cliFailure(stubRun({ stdout: "", stderr: "", code: 127 })), /jira-cli/);
});

// A CLI killed by the timeout leaves no stderr to quote, so "jira issue list failed" would be
// the entire diagnosis. `outcomeUnknown` is the fact that separates "it refused" from "it
// never answered", and a CLI that never answers is usually one waiting on a prompt.
test("a jira that never answered says so, rather than reporting a bare failure", () => {
  const r = cliResult({ stdout: "", stderr: "", code: 1, outcomeUnknown: true, overflowed: false });
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /did not answer within 20s/);
  assert.match(r.error!, /waiting for input/);
});

// The inversion this file also has to prevent: jira-cli exits NON-ZERO when the filter
// matched nothing, and reporting that would show a healthy, up-to-date source as broken.
test("the CLI's own \"no result found\" is an empty SUCCESS, however it exits", () => {
  const r = cliResult(
    stubRun({ stdout: "", stderr: "\x1b[31mNo result found for given query in project \"MC\"\x1b[0m", code: 1 }),
  );
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null);
});

test("CLI output that is not JSON, or not a list, is an error too", () => {
  assert.match(cliResult(stubRun({ stdout: "MC-1  Some issue", stderr: "", code: 0 })).error!, /not JSON/);
  assert.match(cliResult(stubRun({ stdout: '{"total":0}', stderr: "", code: 0 })).error!, /unexpected shape/);
});

test("a clean CLI run with no matching issues is an empty SUCCESS", () => {
  const r = cliResult(stubRun({ stdout: '{"issues":[]}', stderr: "", code: 0 }));
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null);
});

// Every issue the page held, and NOT a slice at `cfg.limit`. That field is the page SIZE - what
// one request asks Jira for - so re-applying it here is how the source used to discard
// everything the walk had gone and fetched beyond the first page.
test("a clean run maps every issue it can name, whatever the page size says", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...ISSUE, key: `MC-${i}` }));
  const r = cliResult(
    stubRun({ stdout: JSON.stringify({ issues: [...many, { fields: { summary: "no key" } }] }), stderr: "", code: 0 }),
    cfg({ limit: 3 }),
  );
  assert.equal(r.error, null);
  assert.deepEqual(r.items.map((i) => i.ref.externalId), ["MC-0", "MC-1", "MC-2", "MC-3", "MC-4"]);
});

// A sweep abandoned by its timeout must not report the partial answer it happened to have,
// and must not report success.
test("an abandoned sweep says so rather than filing what it had", () => {
  const r = cliResult(
    stubRun({ stdout: JSON.stringify({ issues: [ISSUE] }), stderr: "", code: 0 }),
    cfg(),
    { ...ctx, signal: AbortSignal.abort() },
  );
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /abandoned/);
});

// ---- the REST rung's failures ----

test("a rejected credential is reported as a credential problem, with the host", () => {
  const r = restResult(
    { ok: false, status: 401, body: '{"errorMessages":["Client must be authenticated"]}' },
    cfg({ site: "acme.atlassian.net" }),
  );
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /JIRA_API_TOKEN \/ JIRA_EMAIL/);
  assert.match(r.error!, /HTTP 401/);
  assert.match(r.error!, /Client must be authenticated/);
  assert.match(r.error!, /acme\.atlassian\.net/);
});

test("a query Jira refuses is reported as a query problem, quoting Jira", () => {
  const r = restResult({
    ok: false,
    status: 400,
    body: '{"errorMessages":["Field \'nope\' does not exist"]}',
  });
  assert.match(r.error!, /could not run this query \(HTTP 400\)/);
  assert.match(r.error!, /does not exist/);
  assert.doesNotMatch(r.error!, /JIRA_API_TOKEN/, "the credential is not the fix here");
});

// A network that never answered is "unknown", not "there is no work" - the stance
// `SweepResult` documents and `pr.ts` takes when `gh` is unreachable.
test("a site that never answered names the host, not a status code", () => {
  const r = restResult(
    { ok: false, status: 0, body: "getaddrinfo ENOTFOUND typo.atlassian.net" },
    cfg({ site: "typo.atlassian.net" }),
  );
  assert.match(r.error!, /could not reach Jira at typo\.atlassian\.net/);
  assert.match(r.error!, /ENOTFOUND/);
});

test("a missing search API is reported as a site problem", () => {
  assert.match(restFailure({ ok: false, status: 404, body: "" }, cfg()), /no search API/);
});

test("Jira's error envelope is quoted from wherever it put the message", () => {
  assert.equal(restMessage('{"errorMessages":["first","second"]}'), "first");
  assert.equal(restMessage('{"errors":{"jql":"bad JQL"}}'), "bad JQL");
  assert.equal(restMessage('{"message":"gateway said no"}'), "gateway said no");
  assert.equal(restMessage("<html>502 Bad Gateway</html>"), "<html>502 Bad Gateway</html>");
  assert.equal(restMessage(""), "");
});

test("a successful REST search maps its issues", () => {
  const r = restResult({ ok: true, status: 200, body: JSON.stringify({ issues: [ISSUE] }) });
  assert.equal(r.error, null);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.ref.externalId, "MC-42");
});
