import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraConfigSchema, type SweepContext } from "../src/shared/task-source.ts";
import { jira } from "../src/server/task-sources/jira.ts";
import { TASK_SOURCES } from "../src/server/task-sources/index.ts";

// What is at stake: the promise the whole kind is built on - a missing or misconfigured Jira
// credential surfaces as a PREFLIGHT SENTENCE NAMING THE FIX, never a silent empty sweep.
//
// `jira-map.test.ts` pins the pure seams. This file pins the LADDER, which is the part that
// decides which of four different fixes an operator is told to go and do:
//
//   1. an empty JQL filter - storable, and sweeps nothing;
//   2. no way to reach Jira at all - neither the CLI nor a whole credential;
//   3. the CLI is there but cannot authenticate (or was never `jira init`ed);
//   4. Jira answered and refused the QUERY, which is not a credential problem.
//
// Driven with a fake `jira` on PATH, the pattern `task-source-sweeper.test.ts` and
// `settings-status.test.ts` use for `gh`. No network: the REST rung is aimed at a loopback
// port nothing is listening on, so "the credential is set but the site cannot be reached"
// is a real code path here rather than a mocked one. Nothing in this file spends a token,
// touches the database, or files a task - a sweep RETURNS candidates and only ingest writes.

const home = mkdtempSync(join(tmpdir(), "mission-jira-preflight-"));
const withJira = join(home, "with-jira");
const noJira = join(home, "no-jira");
mkdirSync(withJira);
mkdirSync(noJira);
after(() => rmSync(home, { recursive: true, force: true }));

// One fake CLI, six behaviours, selected by an env var - so the PATH stays fixed and the only
// thing a test changes is what the CLI says back.
//
// It parses `--paginate start:limit` and serves that window of a virtual result set, which is
// what makes the PAGING walk drivable here rather than only in a unit test over the decision
// function: `FAKE_JIRA_CALLS` records the window each invocation asked for, so a test can
// assert the sequence of requests and that a probe spends exactly one.
writeFileSync(
  join(withJira, "jira"),
  `#!/bin/sh
paginate=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--paginate" ]; then paginate="$a"; fi
  prev="$a"
done
start=\${paginate%%:*}
limit=\${paginate##*:}
if [ -n "$FAKE_JIRA_CALLS" ]; then echo "$paginate" >> "$FAKE_JIRA_CALLS"; fi

case "$FAKE_JIRA_MODE" in
  unauthorized)
    echo "Received unexpected response '401 Unauthorized' from Jira" 1>&2; exit 1 ;;
  unconfigured)
    echo "Error: config file not found. Run 'jira init' to configure the tool" 1>&2; exit 1 ;;
  badjql)
    echo "Error: jql: Field 'nope' does not exist" 1>&2; exit 1 ;;
  empty)
    echo "No result found for given query in project \\"MC\\"" 1>&2; exit 1 ;;
  oldcli)
    echo "unknown flag: --paginate" 1>&2; exit 1 ;;
  stuck)
    printf '{"issues":[{"key":"MC-0","fields":{"summary":"Issue 0"}},{"key":"MC-1","fields":{"summary":"Issue 1"}}]}' ;;
  pages)
    total=\${FAKE_JIRA_TOTAL:-7}
    out=""
    i=\$start
    end=\$((start + limit))
    while [ \$i -lt \$end ] && [ \$i -lt \$total ]; do
      if [ -n "\$out" ]; then out="\$out,"; fi
      out="\$out{\\"key\\":\\"MC-\$i\\",\\"fields\\":{\\"summary\\":\\"Issue \$i\\"}}"
      i=\$((i + 1))
    done
    printf '{"issues":[%s]}' "\$out" ;;
  *)
    printf '{"issues":[{"key":"MC-1","self":"https://acme.atlassian.net/rest/api/3/issue/1","fields":{"summary":"Fix the thing","description":"Do it.","priority":{"name":"Highest"}}}]}' ;;
esac
`,
);
chmodSync(join(withJira, "jira"), 0o755);

/** A port the OS has just confirmed free, so a connection to it is refused rather than answered. */
async function deadPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || address === null) {
        probe.close(() => reject(new Error("could not read the probe socket's port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const ctx: SweepContext = {
  sourceId: "src-1",
  repoRoot: home,
  signal: new AbortController().signal,
};

/**
 * The machine this source is running on, stated rather than inherited.
 *
 * Every key is set or deleted explicitly: an operator running `npm test` with their own
 * `JIRA_API_TOKEN` exported would otherwise send the "no credential" cases down the REST
 * rung and at their real Jira. `which` has to stay reachable, since that is how a bare
 * command name is resolved.
 */
function machine(opts: {
  cli: boolean;
  email?: string;
  token?: string;
  mode?: string;
  /** How many issues the fake's virtual result set holds, in `pages` mode. */
  total?: string;
  /** A file the fake appends each requested `start:limit` window to. */
  calls?: string;
}): void {
  process.env.PATH = `${opts.cli ? withJira : noJira}:/usr/bin:/bin`;
  for (const [key, value] of [
    ["JIRA_EMAIL", opts.email],
    ["JIRA_API_TOKEN", opts.token],
    ["FAKE_JIRA_MODE", opts.mode],
    ["FAKE_JIRA_TOTAL", opts.total],
    ["FAKE_JIRA_CALLS", opts.calls],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** The `start:limit` windows the fake was asked for, in order. */
function callsIn(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

const PATH_BEFORE = process.env.PATH;
after(() => {
  process.env.PATH = PATH_BEFORE;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  delete process.env.FAKE_JIRA_MODE;
});

const cfg = (over: Record<string, unknown> = {}) =>
  JiraConfigSchema.parse({ site: "acme.atlassian.net", jql: "project = MC", ...over });

// ---- 1. an empty filter ----

// The failure decision 9 of the plan forbids: a source that looks configured and sweeps
// nothing forever. It is answered without spawning anything, on both calls.
test("an empty JQL filter is named by preflight AND refused by the sweep", async () => {
  machine({ cli: false });
  const empty = cfg({ jql: "   " });

  const said = await jira.preflight(empty, ctx);
  assert.match(said!, /set a JQL query/);

  const swept = await jira.sweep(empty, ctx);
  assert.deepEqual(swept.items, []);
  assert.match(swept.error!, /set a JQL query/, "an empty filter must never read as 'no work'");
});

test("a source with no site says so, rather than reaching for https:///", async () => {
  machine({ cli: false });
  assert.match((await jira.preflight(cfg({ site: "" }), ctx))!, /no Jira site/);
});

// ---- 2. nothing to reach Jira with ----

test("no CLI and no credential names BOTH fixes", async () => {
  machine({ cli: false });
  const said = await jira.preflight(cfg(), ctx);
  assert.match(said!, /jira-cli/, "the install command");
  assert.match(said!, /JIRA_API_TOKEN and JIRA_EMAIL/, "and the environment convention");
});

// Half a credential is the misconfiguration that looks like configuration: the operator did
// the work, and "install the CLI or set both" would send them looking for what they did.
test("half a credential is named as the half that is missing", async () => {
  machine({ cli: false, token: "t" });
  assert.match((await jira.preflight(cfg(), ctx))!, /JIRA_EMAIL is not/);

  machine({ cli: false, email: "a@b.c" });
  assert.match((await jira.preflight(cfg(), ctx))!, /JIRA_API_TOKEN is not/);
});

// ---- 3. the CLI is there and cannot authenticate ----

test("an unauthenticated CLI is a credential problem, naming the credential", async () => {
  machine({ cli: true, mode: "unauthorized" });
  const said = await jira.preflight(cfg(), ctx);
  assert.match(said!, /not authenticated/);
  assert.match(said!, /JIRA_API_TOKEN/);
  assert.doesNotMatch(said!, /does not exist/);
});

// A third fix for a third state: installed, never pointed at a site.
test("a CLI that was never initialised is told to run jira init", async () => {
  machine({ cli: true, mode: "unconfigured" });
  const said = await jira.preflight(cfg(), ctx);
  assert.match(said!, /not configured/);
  assert.match(said!, /jira init/);
});

// ---- 4. Jira answered and refused the query ----

test("a refused query is a query problem, quoting Jira and not the credential", async () => {
  machine({ cli: true, mode: "badjql" });
  const said = await jira.preflight(cfg(), ctx);
  assert.match(said!, /jira issue list failed/);
  assert.match(said!, /Field 'nope' does not exist/);
  assert.doesNotMatch(said!, /not authenticated/, "sending them to the token would waste the trip");
});

// ---- the healthy paths ----

test("a working CLI preflights clean, and its sweep files what it found", async () => {
  machine({ cli: true });
  assert.equal(await jira.preflight(cfg(), ctx), null);

  const swept = await jira.sweep(cfg(), ctx);
  assert.equal(swept.error, null);
  assert.equal(swept.items.length, 1);
  assert.equal(swept.items[0]!.ref.externalId, "MC-1");
  assert.equal(swept.items[0]!.ref.url, "https://acme.atlassian.net/browse/MC-1");
  assert.equal(swept.items[0]!.title, "Fix the thing");
  assert.equal(swept.items[0]!.priority, "blocker", "Highest maps onto Blocker");
  assert.equal(swept.items[0]!.repoRoot, home, "filed against the source's repo, like any candidate");
});

// jira-cli exits NON-ZERO when the filter matched nothing. A healthy, up-to-date source
// must not read as a broken one - the inversion of the failure this kind exists to prevent.
test("a filter that currently matches nothing is healthy, not broken", async () => {
  machine({ cli: true, mode: "empty" });
  assert.equal(await jira.preflight(cfg(), ctx), null);
  const swept = await jira.sweep(cfg(), ctx);
  assert.deepEqual(swept.items, []);
  assert.equal(swept.error, null);
});

// ---- paging: the difference between reaching the tail of a filter and never ----

// The defect this pins, and the reason the fake parses `--paginate`: the first draft asked for
// one page and stopped. `ingest.ts` de-duplicated those issues against `task_source_seen`, and
// every later sweep re-fetched the SAME leading page and reported it as already filed - so a
// filter matching more than one page could never reach the rest of itself. Not slowly: never.
// And it looked healthy the whole time, which is the failure this file exists to prevent.
test("a filter with more issues than one page yields all of them, in one sweep", async () => {
  const calls = join(home, "calls-multi");
  machine({ cli: true, mode: "pages", total: "7", calls });

  const swept = await jira.sweep(cfg({ limit: 3 }), ctx);
  assert.equal(swept.error, null);
  assert.deepEqual(
    swept.items.map((i) => i.ref.externalId),
    ["MC-0", "MC-1", "MC-2", "MC-3", "MC-4", "MC-5", "MC-6"],
    "the tail of the filter is reachable, not just the first page",
  );
  // Three requests, advancing, and it stopped on the SHORT page rather than asking forever.
  assert.deepEqual(callsIn(calls), ["0:3", "3:3", "6:3"]);
});

test("a filter that fits in one page costs one request", async () => {
  const calls = join(home, "calls-single");
  machine({ cli: true, mode: "pages", total: "2", calls });

  const swept = await jira.sweep(cfg({ limit: 50 }), ctx);
  assert.equal(swept.error, null);
  assert.equal(swept.items.length, 2);
  assert.deepEqual(callsIn(calls), ["0:50"], "a short first page is the end of the filter");
});

// A probe is a question about reachability, not a sweep: it must not walk a 20-page filter to
// answer "does Jira take this JQL".
test("a preflight probe spends exactly one request, for one issue", async () => {
  const calls = join(home, "calls-probe");
  machine({ cli: true, mode: "pages", total: "500", calls });

  assert.equal(await jira.preflight(cfg({ limit: 50 }), ctx), null);
  assert.deepEqual(callsIn(calls), ["0:1"]);
});

// A filter whose size lands exactly on the walk's page bound ends on a FULL page, and this
// rung has no cursor - so "the page was full" would be read as "there is more" and a source
// reading its filter completely would report itself as too broad on every sweep, telling the
// operator to narrow a JQL that is already fine. 50 pages of 2 is exactly 100 issues.
test("a filter ending exactly on the page bound is complete, not truncated", async () => {
  const calls = join(home, "calls-exact");
  machine({ cli: true, mode: "pages", total: "100", calls });

  const swept = await jira.sweep(cfg({ limit: 2 }), ctx);
  assert.equal(swept.items.length, 100);
  assert.equal(swept.error, null, "there is no tail, so there is nothing to report");
  // 50 pages, plus the one lookahead that established the end - and not a 51st page of data.
  assert.equal(callsIn(calls).length, 51);
  assert.equal(callsIn(calls).at(-1), "100:2");
});

// And the lookahead must not paper over a real tail: one more issue than fits is still reported.
test("a filter with one issue past the bound is still reported as too large", async () => {
  machine({ cli: true, mode: "pages", total: "101" });

  const swept = await jira.sweep(cfg({ limit: 2 }), ctx);
  assert.equal(swept.items.length, 101, "including the one the lookahead found");
  assert.match(swept.error!, /larger than one sweep can read/);
});

// A rung that ACCEPTS the pagination argument and ignores it is the nastier version: walked to
// the ceiling, it would be reported as a filter too broad to read, which is a true sentence
// about the wrong thing - the operator would go and narrow a JQL that was never the problem.
test("a CLI that ignores --paginate is named as that, not as a filter that is too broad", async () => {
  const calls = join(home, "calls-stuck");
  machine({ cli: true, mode: "stuck", calls });

  const swept = await jira.sweep(cfg({ limit: 2 }), ctx);
  assert.deepEqual(swept.items, []);
  assert.match(swept.error!, /returned the same page again/);
  assert.match(swept.error!, /upgrade it/);
  assert.doesNotMatch(swept.error!, /narrow the JQL/, "narrowing the filter would not help");
  // And it stopped at the repeat rather than spending the whole page budget on it.
  assert.equal(callsIn(calls).length, 2);
});

// The rung that cannot page at all. Named as its own state because the fix is neither the
// token nor the query - and with a credential present the other rung simply takes over.
test("a CLI too old for --paginate says so, and names the two ways forward", async () => {
  machine({ cli: true, mode: "oldcli" });
  const said = await jira.preflight(cfg(), ctx);
  assert.match(said!, /does not support `--paginate`/);
  assert.match(said!, /upgrade it/);
  assert.match(said!, /JIRA_API_TOKEN and JIRA_EMAIL so the REST rung can page/);
});

// ---- the REST rung, and the retry between them ----

test("with no CLI, the credential is used against the site - and an unreachable site says so", async () => {
  const port = await deadPort();
  machine({ cli: false, email: "a@b.c", token: "t" });
  const said = await jira.preflight(cfg({ site: `127.0.0.1:${port}` }), ctx);
  assert.match(said!, /could not reach Jira at 127\.0\.0\.1:/);
  // Node's message for every transport failure is the same three words, so the cause's code
  // is what tells a wrong port from a typo'd host from a VPN certificate.
  assert.match(said!, /ECONNREFUSED/);
  assert.doesNotMatch(said!, /jira-cli/, "there is nothing to install - the credential is the rung");
});

// The half-configured machine: jira-cli on PATH, `jira init` never run, tokens exported for
// the shell helpers. Reporting a broken source while a working path sits unused would be
// accurate and useless - so the second rung is tried, and both reasons are reported when
// neither works, because the operator has two things to look at.
test("a broken CLI falls through to the credential, and both failures are reported", async () => {
  const port = await deadPort();
  machine({ cli: true, mode: "unconfigured", email: "a@b.c", token: "t" });
  const said = await jira.preflight(cfg({ site: `127.0.0.1:${port}` }), ctx);
  assert.match(said!, /not configured/, "what the CLI said");
  assert.match(said!, /the REST fallback also failed/);
  assert.match(said!, /could not reach Jira/, "and what the credential said");
});

// ---- through the registry, which is how the daemon reaches it ----

// The route and the sweeper hold a source whose config is `unknown`, so the registry parses
// at the boundary. A blob that could never sweep must come back as a refusal, not as "no
// work" - and `preflight` must answer rather than throw, or the panel's whole
// broken-versus-quiet distinction becomes a crash.
test("the registered kind refuses an unusable config instead of reporting no work", async () => {
  machine({ cli: false });
  const swept = await TASK_SOURCES.jira.sweep({ limit: 0 }, ctx);
  assert.deepEqual(swept.items, []);
  assert.match(swept.error!, /not valid for jira/);

  const said = await TASK_SOURCES.jira.preflight({ jql: 42 }, ctx);
  assert.equal(typeof said, "string");
});

// An unknown key in a stored blob is dropped rather than refused, because that blob may have
// been written by a build whose schema had a field this one has since removed - the whole
// reason `configSchema` takes `unknown` in.
test("a stored blob from another build still parses, and still sweeps", async () => {
  machine({ cli: true });
  const swept = await TASK_SOURCES.jira.sweep(
    { site: "acme.atlassian.net", jql: "project = MC", retired: true },
    ctx,
  );
  assert.equal(swept.error, null);
  assert.equal(swept.items.length, 1);
});
