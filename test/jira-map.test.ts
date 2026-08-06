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
  externalIdFor,
  issuesFrom,
  jiraIssueListArgs,
  plainTextFrom,
  priorityFor,
  restCredentialFrom,
  restFailure,
  restMessage,
  searchUrl,
  siteHost,
  sweepResultFromCli,
  sweepResultFromRest,
} from "../src/server/task-sources/jira.ts";
import { stubRun } from "../src/server/util/exec.ts";

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

// ---- the two rungs' requests ----

// `--raw` is what makes both rungs share one mapper: it prints the API's own envelope
// instead of a column layout that truncates. No limit flag - jira-cli has spelled that
// argument differently across versions, and an unknown flag takes the whole rung out.
test("the CLI is asked for the API's own JSON, with the filter as one argument", () => {
  const args = jiraIssueListArgs(cfg({ jql: "  project = MC AND status = Open  " }));
  assert.deepEqual(args, ["issue", "list", "--jql", "project = MC AND status = Open", "--raw"]);
  assert.equal(args.includes("--plain"), false, "table output would need a parser and truncates");
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
  assert.deepEqual(issuesFrom('{"issues":[{"key":"MC-1"}]}'), { issues: [{ key: "MC-1" }] });
  assert.deepEqual(issuesFrom('[{"key":"MC-1"}]'), { issues: [{ key: "MC-1" }] });
  assert.match((issuesFrom("<html>") as { error: string }).error, /not JSON/);
  assert.match((issuesFrom('{"total":3}') as { error: string }).error, /unexpected shape/);
});

// ---- the CLI rung's failures ----

test("a non-zero jira exit is an error, never an empty success", () => {
  const r = sweepResultFromCli(stubRun({ stdout: "", stderr: "boom: bad flag", code: 1 }), cfg(), ctx);
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /jira issue list failed: boom: bad flag/);
});

// A credential problem has a different fix from a broken query, so it gets a different
// sentence - that is the whole reason `preflight` is separate from `sweep`.
test("an unauthenticated CLI names the credential, not the query", () => {
  const r = sweepResultFromCli(
    stubRun({ stdout: "", stderr: "Received unexpected response '401 Unauthorized'", code: 1 }),
    cfg(),
    ctx,
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
  const r = sweepResultFromCli(
    { stdout: "", stderr: "", code: 1, outcomeUnknown: true },
    cfg(),
    ctx,
  );
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /did not answer within 20s/);
  assert.match(r.error!, /waiting for input/);
});

// The inversion this file also has to prevent: jira-cli exits NON-ZERO when the filter
// matched nothing, and reporting that would show a healthy, up-to-date source as broken.
test("the CLI's own \"no result found\" is an empty SUCCESS, however it exits", () => {
  const r = sweepResultFromCli(
    stubRun({ stdout: "", stderr: "\x1b[31mNo result found for given query in project \"MC\"\x1b[0m", code: 1 }),
    cfg(),
    ctx,
  );
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null);
});

test("CLI output that is not JSON, or not a list, is an error too", () => {
  assert.match(sweepResultFromCli(stubRun({ stdout: "MC-1  Some issue", stderr: "", code: 0 }), cfg(), ctx).error!, /not JSON/);
  assert.match(sweepResultFromCli(stubRun({ stdout: '{"total":0}', stderr: "", code: 0 }), cfg(), ctx).error!, /unexpected shape/);
});

test("a clean CLI run with no matching issues is an empty SUCCESS", () => {
  const r = sweepResultFromCli(stubRun({ stdout: '{"issues":[]}', stderr: "", code: 0 }), cfg(), ctx);
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null);
});

test("a clean run maps every issue it can name, and stops at the configured cap", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...ISSUE, key: `MC-${i}` }));
  const r = sweepResultFromCli(
    stubRun({ stdout: JSON.stringify({ issues: [...many, { fields: { summary: "no key" } }] }), stderr: "", code: 0 }),
    cfg({ limit: 3 }),
    ctx,
  );
  assert.equal(r.error, null);
  assert.deepEqual(r.items.map((i) => i.ref.externalId), ["MC-0", "MC-1", "MC-2"]);
});

// A sweep abandoned by its timeout must not report the partial answer it happened to have,
// and must not report success.
test("an abandoned sweep says so rather than filing what it had", () => {
  const r = sweepResultFromCli(stubRun({ stdout: JSON.stringify({ issues: [ISSUE] }), stderr: "", code: 0 }), cfg(), {
    ...ctx,
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /abandoned/);
});

// ---- the REST rung's failures ----

test("a rejected credential is reported as a credential problem, with the host", () => {
  const r = sweepResultFromRest(
    { ok: false, status: 401, body: '{"errorMessages":["Client must be authenticated"]}' },
    cfg({ site: "acme.atlassian.net" }),
    ctx,
  );
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /JIRA_API_TOKEN \/ JIRA_EMAIL/);
  assert.match(r.error!, /HTTP 401/);
  assert.match(r.error!, /Client must be authenticated/);
  assert.match(r.error!, /acme\.atlassian\.net/);
});

test("a query Jira refuses is reported as a query problem, quoting Jira", () => {
  const r = sweepResultFromRest(
    { ok: false, status: 400, body: '{"errorMessages":["Field \'nope\' does not exist"]}' },
    cfg(),
    ctx,
  );
  assert.match(r.error!, /could not run this query \(HTTP 400\)/);
  assert.match(r.error!, /does not exist/);
  assert.doesNotMatch(r.error!, /JIRA_API_TOKEN/, "the credential is not the fix here");
});

// A network that never answered is "unknown", not "there is no work" - the stance
// `SweepResult` documents and `pr.ts` takes when `gh` is unreachable.
test("a site that never answered names the host, not a status code", () => {
  const r = sweepResultFromRest(
    { ok: false, status: 0, body: "getaddrinfo ENOTFOUND typo.atlassian.net" },
    cfg({ site: "typo.atlassian.net" }),
    ctx,
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
  const r = sweepResultFromRest(
    { ok: true, status: 200, body: JSON.stringify({ issues: [ISSUE] }) },
    cfg(),
    ctx,
  );
  assert.equal(r.error, null);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.ref.externalId, "MC-42");
});
