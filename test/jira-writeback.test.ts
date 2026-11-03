import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraConfigSchema } from "../src/shared/task-source.ts";
import type { JiraConfig, WritebackNotice } from "../src/shared/task-source.ts";
import {
  cliMoveResult,
  commentBodyAdf,
  commentBodyText,
  currentStatusFrom,
  issueKeyFor,
  jiraCommentArgs,
  jiraMoveArgs,
  remoteLinkPayload,
  transitionFor,
  transitionsFrom,
  writebackBlocks,
  cliFailure,
  cliFault,
  restReadFailure,
  restWritebackFailure,
} from "../src/server/task-sources/jira.ts";
import { TASK_SOURCES } from "../src/server/task-sources/index.ts";
import type { RunResult } from "../src/server/util/exec.ts";

// What is at stake: this is the direction that CHANGES somebody's ticket. A sweep's worst
// failure is silence; these two verbs can post a comment twice, or move an issue a person
// deliberately moved back, and neither is undone by deleting a row here.
//
// Six claims carry the file, and each is a thing that would be a real incident if it broke:
//
//   1. The remote link is idempotent UPSTREAM. `globalId` is the pull request's url, which
//      is what makes a retry update one link rather than accumulate one per attempt - and
//      it is the whole reason `annotate` posts the link before the comment.
//   2. The two renderings say the same thing. The REST rung needs ADF and the CLI rung
//      needs text, and a comment that says one thing on one machine and another elsewhere
//      is a bug nobody would find.
//   3. A resolve that cannot reach its target REFUSES WITH THE NAMES IT FOUND. That
//      sentence is this phase's product: guessing at a nearby transition moves a ticket
//      somewhere nobody asked for, and a bare "transition failed" sends the operator to
//      Jira's workflow admin screens.
//   4. A misconfigured resolve costs nothing. An empty target status is answered before a
//      subprocess or a socket, which is checkable here by giving it neither.
//   5. The egress guard holds ON THE WRITE PATH specifically. A second code path is exactly
//      how a credential guard gets lost, so it is asserted here and not only on the search
//      path where it was written.
//   6. A refusal and an unreadable outcome are different answers. The ledger retries the
//      first and never the second, so collapsing them either loses a delivery or repeats a
//      transition.
//
// Nothing here spends a token, opens a database, or reaches a real Jira. The two tests that
// need a rung to be absent point `MISSION_JIRA_BIN` at a path that does not exist and the
// REST rung at a loopback port nothing is listening on, so "unreachable" is a real code
// path rather than a mocked one.

const home = mkdtempSync(join(tmpdir(), "mission-jira-writeback-"));
const withJira = join(home, "with-jira");
const noJira = join(home, "no-jira");
mkdirSync(withJira);
mkdirSync(noJira);
after(() => rmSync(home, { recursive: true, force: true }));

// One fake CLI, selected by an env var, recording the argv it was handed. It exists to prove
// two things a pure test cannot: that the write path resolves the binary through
// `jiraBin()` - which is the seam that keeps a suite run off a real ticket - and that a
// refused `issue move` keeps the CLI's OWN list of valid statuses, which is the CLI rung's
// version of the refusal `transitionFor` builds.
writeFileSync(
  join(withJira, "jira"),
  `#!/bin/sh
# Delimited rather than newline-separated: a comment body is multi-line by construction, so
# one arg per line would split it and the recording would not be the argv.
if [ -n "$FAKE_JIRA_ARGV" ]; then
  for a in "$@"; do printf '%s<ARG>' "$a" >> "$FAKE_JIRA_ARGV"; done
  printf '<RUN>' >> "$FAKE_JIRA_ARGV"
fi

case "$FAKE_JIRA_MODE" in
  hang)
    # Dies by SIGNAL rather than reporting an exit, which is what run() reads as an
    # unreadable outcome. A real one is a 20s timeout; this reaches the same state at once.
    kill -9 $$ ;;
  badtransition)
    echo "✗ Unable to transition issue: invalid transition state \\"Done\\"" 1>&2
    echo "Available transitions for issue MC-431:" 1>&2
    echo "  Ready for QA" 1>&2
    echo "  Reject" 1>&2
    exit 1 ;;
  unconfigured)
    echo "Error: config file not found. Run 'jira init' to configure the tool" 1>&2; exit 1 ;;
  refused)
    echo "Error: you do not have permission to comment on this issue" 1>&2; exit 1 ;;
  *)
    echo "✓ done" ;;
esac
`,
);
chmodSync(join(withJira, "jira"), 0o755);

/** A loopback port with nothing listening, so a REST attempt really fails to connect. */
async function deadPort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The machine this source is running on, stated rather than inherited.
 *
 * Every key is set or deleted explicitly. An operator running `npm test` with their own
 * `JIRA_API_TOKEN` exported would otherwise send the credential-free cases down the REST
 * rung and at their real Jira - which on this path would not merely read, it would write.
 */
function machine(opts: {
  cli: boolean;
  email?: string;
  token?: string;
  mode?: string;
  argv?: string;
  allowedHosts?: string;
}): void {
  process.env.PATH = `${opts.cli ? withJira : noJira}:/usr/bin:/bin`;
  for (const [key, value] of [
    // The seam under test. Absent, `jiraBin()` falls back to a bare `jira` which the PATH
    // above cannot resolve either - so a mistake here is a missing rung, never a real one.
    ["MISSION_JIRA_BIN", opts.cli ? join(withJira, "jira") : join(noJira, "absent-jira")],
    ["JIRA_EMAIL", opts.email],
    ["JIRA_API_TOKEN", opts.token],
    ["FAKE_JIRA_MODE", opts.mode],
    ["FAKE_JIRA_ARGV", opts.argv],
    ["JIRA_ALLOWED_HOSTS", opts.allowedHosts],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const PATH_BEFORE = process.env.PATH;
after(() => {
  process.env.PATH = PATH_BEFORE;
  for (const key of [
    "MISSION_JIRA_BIN",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "FAKE_JIRA_MODE",
    "FAKE_JIRA_ARGV",
    "JIRA_ALLOWED_HOSTS",
  ]) {
    delete process.env[key];
  }
});

/** The argv batches the fake was handed, in order. */
function argvIn(path: string): string[][] {
  return readFileSync(path, "utf8")
    .split("<RUN>")
    .filter((batch) => batch.length > 0)
    .map((batch) => batch.split("<ARG>").filter((arg) => arg.length > 0));
}

const cfg = (over: Partial<JiraConfig> = {}): JiraConfig =>
  JiraConfigSchema.parse({ site: "acme.atlassian.net", jql: "project = MC", ...over });

const notice = (over: Partial<WritebackNotice> = {}): WritebackNotice => ({
  signal: "pr-opened",
  action: "annotate",
  externalId: "MC-431",
  externalUrl: "https://acme.atlassian.net/browse/MC-431",
  taskTitle: "Fix the parser",
  prUrl: "https://github.com/acme/demo/pull/9",
  repoRoot: "/repo",
  outcome: null,
  observedAt: 1_700_000_000_000,
  ...over,
});

const ctx = { sourceId: "src-1", repoRoot: home, signal: new AbortController().signal };

/** The registered kind, so every call below goes through the same boundary the worker does. */
const jira = TASK_SOURCES["jira"];

// ---- 1. the idempotency claim ----

// The one write in this feature that a retry may repeat safely, and the reason `annotate`
// posts it FIRST. Jira treats `globalId` as the link's identity, so a second POST of this
// body updates one link instead of adding a second - which is what makes retrying a
// half-delivered annotate (link posted, comment failed) free rather than cumulative.
test("the remote link's globalId is the pull request url, which is what makes a retry free", () => {
  const payload = remoteLinkPayload(notice()) as {
    globalId: string;
    relationship: string;
    object: { url: string; title: string };
  };
  assert.equal(payload.globalId, "https://github.com/acme/demo/pull/9");
  assert.equal(payload.object.url, "https://github.com/acme/demo/pull/9");
  assert.equal(payload.relationship, "mentioned in");
  assert.match(payload.object.title, /Fix the parser/);
});

// Jira refuses a remote link title past its own limit, and an issue swept from a filter can
// carry a summary of any length at all.
test("an enormous task title is clipped rather than refused by Jira", () => {
  const payload = remoteLinkPayload(notice({ taskTitle: "x".repeat(4000) })) as {
    object: { title: string };
  };
  assert.ok(payload.object.title.length <= 250, `title was ${payload.object.title.length}`);
});

// ---- 2. one comment, two renderings ----

test("the ADF comment and the plain-text comment say the same thing", () => {
  const n = notice({
    signal: "task-completed",
    outcome: "opened a pull request",
    prUrl: "https://github.com/acme/demo/pull/9",
  });
  const blocks = writebackBlocks(n);
  assert.deepEqual(commentBodyText(n).split("\n\n"), blocks);

  const doc = commentBodyAdf(n) as {
    type: string;
    version: number;
    content: { type: string; content: { type: string; text: string }[] }[];
  };
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.equal(doc.content.length, blocks.length);
  for (const [i, para] of doc.content.entries()) {
    assert.equal(para.type, "paragraph");
    assert.equal(
      para.content.map((node) => node.text).join(""),
      blocks[i],
      "the ADF paragraph says something other than its text block",
    );
  }
});

// An ADF comment does NOT auto-link a bare url the way the older wiki-markup one did, so a
// pull request posted as plain text is not clickable - which defeats the whole comment.
test("the pull request url carries a link mark, so it is clickable in Jira", () => {
  const doc = commentBodyAdf(notice()) as {
    content: { content: { text: string; marks?: { type: string; attrs: { href: string } }[] }[] }[];
  };
  const linked = doc.content
    .flatMap((para) => para.content)
    .find((node) => node.marks?.some((mark) => mark.type === "link"));
  assert.equal(linked?.text, "https://github.com/acme/demo/pull/9");
  assert.equal(linked?.marks?.[0]?.attrs.href, "https://github.com/acme/demo/pull/9");
});

// Our internals stay ours. The person reading this on their ticket is entitled to know what
// wrote it, and to nothing else - the same restraint the outward GitHub verbs keep.
test("the comment carries the pull request and the task's words, and nothing about us", () => {
  const text = commentBodyText(notice({ signal: "task-completed", outcome: "shipped it" }));
  assert.match(text, /Mission Control/);
  assert.match(text, /shipped it/);
  assert.match(text, /Fix the parser/);
  assert.doesNotMatch(text, /worktree|task id|sourceId|src-1/i);
});

// ---- 3. the transition matcher ----

const TRANSITIONS = {
  fields: { status: { name: "In Review" } },
  transitions: [
    { id: "31", name: "Ready for QA", to: { name: "QA" } },
    { id: "41", name: "Reject", to: { name: "Rejected" } },
  ],
};

test("a transition matches on its own name, case-insensitively", () => {
  assert.deepEqual(transitionFor(TRANSITIONS, "ready for qa", { key: "MC-431", status: "In Review" }), {
    id: "31",
  });
});

// The name an operator reads on their board is the STATUS, while the workflow's button may
// be called something else entirely - so both are reasonable things to have typed.
test("a transition also matches on the status it lands in", () => {
  assert.deepEqual(transitionFor(TRANSITIONS, "Rejected", { key: "MC-431", status: "In Review" }), {
    id: "41",
  });
});

// This phase's main product. Guessing at a nearby transition would move somebody's ticket
// somewhere they did not ask for; a bare "transition failed" would send them to Jira's
// workflow admin screens to work out what this source should have said.
test("no match refuses with the transitions that ARE available from here", () => {
  const answer = transitionFor(TRANSITIONS, "Done", { key: "MC-431", status: "In Review" });
  assert.ok("problem" in answer);
  assert.match(answer.problem, /MC-431 cannot move to "Done" from "In Review"/);
  assert.match(answer.problem, /available from here: Ready for QA \(to QA\), Reject \(to Rejected\)/);
  // And it names the fix, rather than only the failure.
  assert.match(answer.problem, /Set this source's resolve status/);
});

// An issue whose workflow offers nothing from where it is standing is a different state from
// one that offers the wrong things, and it has a different fix.
test("an issue with no transitions at all says so, rather than listing an empty set", () => {
  const answer = transitionFor({ transitions: [] }, "Done", { key: "MC-431", status: "Blocked" });
  assert.ok("problem" in answer);
  assert.match(answer.problem, /MC-431 offers no transitions from "Blocked"/);
  assert.match(answer.problem, /allowed to transition the issue/);
});

test("a malformed transitions answer reads as none, never as a match", () => {
  assert.deepEqual(transitionsFrom({ transitions: "nope" }), []);
  assert.deepEqual(transitionsFrom(null), []);
  assert.equal(currentStatusFrom({ fields: { status: { name: " In Review " } } }), "In Review");
  assert.equal(currentStatusFrom({}), "");
});

// ---- 4. a misconfigured resolve costs nothing ----

// Answered before a subprocess or a socket, which is checkable by giving it a machine with
// neither rung reachable AND a fake CLI on PATH that would record any invocation.
test("an empty resolve status refuses by name, without any call leaving the process", async () => {
  const argv = join(home, "argv-empty-status.txt");
  writeFileSync(argv, "");
  machine({ cli: true, argv });

  const r = await jira.resolve!(cfg({ resolveTransition: "  " }), notice({ action: "resolve" }), ctx);
  assert.match(r.error!, /names no target status/);
  assert.match(r.error!, /e\.g\. Done/);
  assert.equal(r.outcomeUnknown, false);
  assert.equal(r.detail, null);
  assert.equal(readFileSync(argv, "utf8"), "", "a refusal spawned the CLI anyway");
});

// The read-only rung. Widening its tool allowlist to a write tool is a separate consent
// decision - somebody's Claude plugin gaining permission to move tickets - so a source on
// it refuses and names the two rungs that can, rather than failing obscurely at delivery.
test("a source querying through UpstartClaw refuses to write, and names the two rungs that can", async () => {
  machine({ cli: true });
  const c = cfg({ queryVia: "upstartclaw", site: "upstartnetwork.atlassian.net", resolveTransition: "Done" });

  for (const r of [
    await jira.annotate!(c, notice(), ctx),
    await jira.resolve!(c, notice({ action: "resolve" }), ctx),
  ]) {
    assert.match(r.error!, /read-only/);
    assert.match(r.error!, /jira CLI/);
    assert.match(r.error!, /JIRA_API_TOKEN and JIRA_EMAIL/);
    assert.equal(r.outcomeUnknown, false);
  }
});

// `externalId` becomes a path segment on every REST write below. A value that is not a Jira
// key names no issue, so there is nothing to write to - and it is refused rather than
// escaped, because there is no such thing as a Jira key carrying a slash.
test("an external id that is not a Jira key is refused before it becomes a URL", async () => {
  machine({ cli: false });
  assert.equal(issueKeyFor(notice({ externalId: "MC-431" })), "MC-431");
  assert.equal(issueKeyFor(notice({ externalId: "acme/demo#7" })), null);
  assert.equal(issueKeyFor(notice({ externalId: "MC-431/../../admin" })), null);

  const r = await jira.annotate!(cfg(), notice({ externalId: "acme/demo#7" }), ctx);
  assert.match(r.error!, /is not a Jira issue key/);
  assert.equal(r.outcomeUnknown, false);
});

// ---- 5. the egress guard, on the WRITE path ----
//
// Asserted here and not only on the search path, because a second code path carrying a
// credential is precisely how a guard like this gets lost.

test("a write refuses a site carrying a credential, rather than reducing it", async () => {
  machine({ cli: false, email: "a@b.co", token: "t" });
  const r = await jira.annotate!(
    cfg({ site: "acme.atlassian.net@elsewhere.example" }),
    notice(),
    ctx,
  );
  assert.match(r.error!, /must be a host, not a URL carrying a credential/);
  assert.match(r.error!, /elsewhere\.example/);
  assert.equal(r.outcomeUnknown, false);
});

test("a write refuses to send JIRA_API_TOKEN to a host that is not Jira Cloud", async () => {
  machine({ cli: false, email: "a@b.co", token: "t" });
  const r = await jira.resolve!(
    cfg({ site: "jira.evil.example", resolveTransition: "Done" }),
    notice({ action: "resolve" }),
    ctx,
  );
  assert.match(r.error!, /refusing to send JIRA_API_TOKEN to jira\.evil\.example/);
  assert.match(r.error!, /JIRA_ALLOWED_HOSTS/);
  // A fact rather than a hedge: the request never left, so the ledger may retry it once the
  // host is named - and must not treat this as a transition that might have happened.
  assert.equal(r.outcomeUnknown, false);
});

// The other half of the same rule: the CLI rung authenticates with its OWN configuration and
// never receives this token, so a disallowed host costs the REST rung and nothing else.
test("a disallowed host still leaves the CLI rung able to comment", async () => {
  const argv = join(home, "argv-disallowed-host.txt");
  writeFileSync(argv, "");
  machine({ cli: true, email: "a@b.co", token: "t", argv });

  const r = await jira.annotate!(cfg({ site: "jira.evil.example" }), notice(), ctx);
  assert.equal(r.error, null, r.error ?? "");
  assert.match(r.detail!, /commented/);
  // And the half that would have carried the token says why it could not run.
  assert.match(r.detail!, /refusing to send JIRA_API_TOKEN/);
  const batches = argvIn(argv);
  assert.equal(batches.length, 1, "the CLI ran more than once");
  assert.deepEqual(batches[0]!.slice(0, 4), ["issue", "comment", "add", "MC-431"]);
});

// ---- 6. reading an outcome ----

const res = (over: Partial<RunResult> = {}): RunResult =>
  ({ stdout: "", stderr: "", code: 0, outcomeUnknown: false, overflowed: false, ...over }) as RunResult;

// A refused connection cannot have been read by Jira, so it is a refusal the ledger may
// retry. Note what is NOT here: the request. A thrown fetch must not carry the Authorization
// header into a panel or a log line.
test("a transport failure reports the cause code and never echoes the request", () => {
  const r = restWritebackFailure(
    { ok: false, status: 0, body: "fetch failed (ECONNREFUSED)" },
    cfg(),
    "the comment could not be posted",
  );
  assert.match(r.error!, /could not reach Jira at acme\.atlassian\.net/);
  assert.match(r.error!, /ECONNREFUSED/);
  assert.doesNotMatch(r.error!, /Basic |authorization|Authorization/);
  assert.equal(r.outcomeUnknown, false);
});

// The distinction the whole ledger rests on. A timeout is not a refusal: the request may
// have been read and acted on, and only the answer went missing - so this one is never
// retried automatically, because a repeated transition undoes a person.
test("a timeout is an unknown outcome, not a refusal", () => {
  const r = restWritebackFailure(
    { ok: false, status: 0, body: "The operation was aborted due to timeout (TimeoutError)" },
    cfg(),
    "MC-431 could not be moved",
  );
  assert.equal(r.outcomeUnknown, true);
  assert.match(r.error!, /check the issue in Jira before retrying/);
});

// A status at all means Jira answered: it read the request and refused it, so nothing was
// written and the ledger may back off and try again once the configuration is fixed.
test("a refusal Jira actually sent is known, and quotes its first message", () => {
  const r = restWritebackFailure(
    {
      ok: false,
      status: 400,
      body: JSON.stringify({ errors: { resolution: "Resolution is required" } }),
    },
    cfg(),
    'MC-431 could not be moved to "Done"',
  );
  assert.equal(r.outcomeUnknown, false);
  assert.match(r.error!, /HTTP 400/);
  // The one place a transition screen's required field exists is Jira's own message.
  assert.match(r.error!, /Resolution is required/);
});

// ---- one owner for the CLI's failure classification ----
//
// `cliFailure` writes the sentence an operator reads and `cliRungUnusable` decides whether a
// failed write may be retried on the REST rung. Both now read `cliFault`, and this pins the
// states apart - because the two used to classify separately, and a diagnosis added to one
// and not the other silently changed whether a comment could be posted twice.
test("every CLI failure state is classified once, and the sentence follows the class", () => {
  const cases = [
    { run: res({ outcomeUnknown: true }), fault: "no-answer", says: /did not answer within/ },
    { run: res({ code: 127 }), fault: "not-installed", says: /could not be run - reinstall it/ },
    {
      run: res({ code: 1, stderr: "Error: config file not found. Run 'jira init'" }),
      fault: "unconfigured",
      says: /installed but not configured/,
    },
    {
      run: res({ code: 1, stderr: "Received unexpected response '401 Unauthorized' from Jira" }),
      fault: "unauthenticated",
      says: /not authenticated/,
    },
    {
      run: res({ code: 1, stderr: "unknown flag: --paginate" }),
      fault: "unsupported-flag",
      says: /does not support `--paginate`/,
    },
    {
      run: res({ code: 1, stderr: "you do not have permission to comment on this issue" }),
      fault: "refused",
      says: /jira issue comment add failed: you do not have permission/,
    },
  ] as const;

  for (const c of cases) {
    assert.equal(cliFault(c.run), c.fault);
    assert.match(cliFailure(c.run, "jira issue comment add"), c.says);
  }
});

// An unknown flag that is not `--paginate` must not be told to upgrade for paging: the write
// path passes flags the sweep never did, so the class is shared but the sentence is not.
test("an unknown flag that is not --paginate quotes what the CLI said instead", () => {
  const run = res({ code: 1, stderr: "unknown flag: --no-input" });
  assert.equal(cliFault(run), "unsupported-flag");
  const said = cliFailure(run, "jira issue comment add");
  assert.match(said, /jira issue comment add failed: unknown flag: --no-input/);
  assert.doesNotMatch(said, /paginate/);
});

// A child that died without reporting is the CLI rung's version of the same question.
test("a CLI run that never reported its own exit is unknown, not failed", () => {
  const r = cliMoveResult(res({ outcomeUnknown: true, code: null as unknown as number }), "MC-431", "Done");
  assert.equal(r.outcomeUnknown, true);
  assert.match(r.error!, /check the issue in Jira before retrying/);
});

// ---- the two verbs, end to end on the CLI rung ----

// The rung an operator actually has: `jira init` was run, no token is exported. The comment
// goes through the CLI, the remote link cannot (jira-cli has no such command), and the
// delivery is reported as the honest thing that happened rather than failed.
test("a CLI-only machine comments, and says why the remote link did not go", async () => {
  const argv = join(home, "argv-cli-only.txt");
  writeFileSync(argv, "");
  machine({ cli: true, argv });

  const r = await jira.annotate!(cfg(), notice(), ctx);
  assert.equal(r.error, null, r.error ?? "");
  assert.match(r.detail!, /^commented/);
  assert.match(r.detail!, /the remote link needs the REST rung/);
  // Success rather than failure on purpose: a comment has no idempotency of its own, so a
  // machine that can NEVER post the link would otherwise accumulate one comment per retry
  // while still never posting it.
  assert.equal(r.outcomeUnknown, false);

  const batches = argvIn(argv);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!, jiraCommentArgs("MC-431", notice()));
  // Without this the CLI asks for a confirmation it will never get, and the delivery becomes
  // a 20s timeout with an unreadable outcome - the one answer the ledger will not retry.
  assert.ok(batches[0]!.includes("--no-input"));
});

// A CLI that RAN and was refused must not be retried on the other rung: that request reached
// Jira once already, and a second one is how a single comment becomes two.
test("a refused CLI comment is not re-sent over REST", async () => {
  const port = await deadPort();
  const argv = join(home, "argv-refused.txt");
  writeFileSync(argv, "");
  machine({
    cli: true,
    mode: "refused",
    argv,
    email: "a@b.co",
    token: "t",
    allowedHosts: "127.0.0.1",
  });

  const r = await jira.annotate!(
    cfg({ site: `127.0.0.1:${port}`, linkVia: "comment" }),
    notice(),
    ctx,
  );
  assert.match(r.error!, /the comment could not be posted/);
  assert.match(r.error!, /permission/);
  assert.equal(argvIn(argv).length, 1, "the refused comment was sent a second time");
});

// The half-configured machine the sweep's ladder was built for: `jira` on PATH, `jira init`
// never run, tokens exported for the shell helpers. That one IS worth handing to REST,
// because the CLI never reached Jira at all.
test("a never-initialised CLI hands the comment to the credential rung", async () => {
  const port = await deadPort();
  machine({
    cli: true,
    mode: "unconfigured",
    email: "a@b.co",
    token: "t",
    allowedHosts: "127.0.0.1",
  });

  const r = await jira.annotate!(
    cfg({ site: `127.0.0.1:${port}`, linkVia: "comment" }),
    notice(),
    ctx,
  );
  // It got as far as the REST rung, which is what the loopback port proves: the failure is
  // the connection, not the CLI's configuration.
  assert.match(r.error!, /could not reach Jira at 127\.0\.0\.1/);
  assert.equal(r.outcomeUnknown, false);
});

// Neither rung, which is a source that cannot deliver anything and has to say so with both
// fixes rather than reporting an empty success.
test("no rung at all refuses with both fixes named", async () => {
  machine({ cli: false });
  const r = await jira.annotate!(cfg(), notice(), ctx);
  assert.match(r.error!, /no way to write to Jira/);
  assert.match(r.error!, /brew install ankitpokhrel\/jira-cli\/jira-cli/);
  assert.match(r.error!, /JIRA_API_TOKEN and JIRA_EMAIL/);
  assert.equal(r.outcomeUnknown, false);
});

// A completion that opened no pull request has nothing to LINK, which is not a failure and
// not fixable by retrying - so it is marked delivered rather than left to exhaust the
// ledger's attempts on a notice that will never have anything to say.
test("a remote-link-only source with no pull request is delivered, not retried", async () => {
  const argv = join(home, "argv-nothing.txt");
  writeFileSync(argv, "");
  machine({ cli: true, argv });

  const r = await jira.annotate!(
    cfg({ linkVia: "remote-link" }),
    notice({ signal: "task-completed", prUrl: null, outcome: "nothing to ship" }),
    ctx,
  );
  assert.equal(r.error, null, r.error ?? "");
  assert.match(r.detail!, /no pull request to link/);
  assert.equal(argvIn(argv).length, 0, "a delivery with nothing to do spawned the CLI");
});

// The same source WITH a pull request and no credential can never do the one thing it is
// configured for, and that IS fixable - so it refuses and says how.
test("a remote-link-only source with no credential refuses and names the fix", async () => {
  machine({ cli: true });
  const r = await jira.annotate!(cfg({ linkVia: "remote-link" }), notice(), ctx);
  assert.match(r.error!, /nothing could be written to MC-431/);
  assert.match(r.error!, /the jira CLI cannot post one/);
  assert.equal(r.outcomeUnknown, false);
});

// ---- the boundary the worker actually calls through ----

// The same parse `sweep` and `push` get, and it matters most here: a stored blob written by
// an older build must not reach an implementation entitled to its own schema's output.
test("a write-back parses config at the boundary and refuses an unusable blob", async () => {
  machine({ cli: false });
  const inst = {
    id: "s1",
    kind: "jira" as const,
    label: "queue",
    repoRoot: "/repo",
    config: { limit: 9000 },
  };
  const r = await TASK_SOURCES["jira"].annotate!(inst.config, notice(), ctx);
  assert.match(r.error!, /not valid for jira/);
  assert.equal(r.outcomeUnknown, false);
});

// ---- the REST rung, end to end through the registered kind ----
//
// Everything above reaches Jira through the CLI or refuses before it gets there. This group
// drives the OTHER rung - the one that actually builds a request, attaches `JIRA_API_TOKEN`
// and reads Jira's answer - and it is where the write-back's successful paths live: the
// remote link, the comment, and the read-match-post a transition costs.
//
// `globalThis.fetch` is the seam, as it is in `foreman-client.test.ts` and
// `ensemble-compare.test.ts`. That is deliberate rather than convenient. A loopback HTTPS
// server would need a certificate this process cannot trust after start-up (the fix is
// `NODE_EXTRA_CA_CERTS`, which has to be set before Node boots), and stubbing here also lets
// each test assert the EXACT request that would have left: the method, the url, the
// Authorization header, and the JSON body. Those are the parts a person on the other end
// sees, and no assertion on a return value can see them.
//
// The CLI is absent throughout, so these tests reach the REST rung by the same route a
// machine without jira-cli does rather than by being pointed at it.

interface SentRequest {
  url: string;
  method: string;
  authorization: string;
  contentType: string | null;
  body: unknown;
}

/** One scripted answer, in the order the code asks for it. */
interface ScriptedReply {
  status: number;
  body?: unknown;
  /** A body that is NOT JSON, for the answers Jira is not supposed to give but can. */
  raw?: string;
}

/**
 * Run `run` with `fetch` scripted, and hand back every request that was made.
 *
 * Replies are consumed in order. Running out is itself an assertion: an unexpected extra
 * request answers 500 and shows up in the record, so a path that calls Jira more times than
 * it should fails loudly rather than silently reusing the last answer.
 */
async function withScriptedJira<T>(
  replies: readonly ScriptedReply[],
  run: () => Promise<T>,
): Promise<{ result: T; sent: SentRequest[] }> {
  const real = globalThis.fetch;
  const sent: SentRequest[] = [];
  let next = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    const raw = typeof init?.body === "string" ? init.body : null;
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? "",
      contentType: headers.get("content-type"),
      body: raw === null ? null : JSON.parse(raw),
    });
    const reply = replies[next++] ?? { status: 500, body: { errorMessages: ["unscripted request"] } };
    // `null` rather than `""` when a reply carries nothing: a 204 with any body at all is
    // refused by the `Response` constructor, and 204 is exactly what Jira answers a
    // successful transition with.
    const payload = reply.raw !== undefined
      ? reply.raw
      : reply.body === undefined
      ? null
      : JSON.stringify(reply.body);
    return new Response(payload, { status: reply.status });
  }) as typeof globalThis.fetch;
  try {
    return { result: await run(), sent };
  } finally {
    globalThis.fetch = real;
  }
}

/** A machine with the credential and no CLI, which is how the REST rung is reached. */
function restMachine(over: { allowedHosts?: string } = {}): void {
  machine({ cli: false, email: "ops@acme.co", token: "s3cret", ...over });
}

const BASIC = `Basic ${Buffer.from("ops@acme.co:s3cret", "utf8").toString("base64")}`;

test("a remote link is POSTed to the issue, carrying the pull request as its globalId", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira([{ status: 201, body: { id: 10_001 } }], () =>
    jira.annotate!(cfg({ linkVia: "remote-link" }), notice(), ctx),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, "linked");
  assert.equal(sent.length, 1);
  const [req] = sent;
  assert.equal(req!.method, "POST");
  assert.equal(req!.url, "https://acme.atlassian.net/rest/api/3/issue/MC-431/remotelink");
  // The credential goes on the request, and it is built from the environment pair rather
  // than from anything stored in this app's database.
  assert.equal(req!.authorization, BASIC);
  assert.equal(req!.contentType, "application/json");
  const body = req!.body as { globalId: string; relationship: string; object: { url: string } };
  assert.equal(body.globalId, "https://github.com/acme/demo/pull/9");
  assert.equal(body.object.url, "https://github.com/acme/demo/pull/9");
  assert.equal(body.relationship, "mentioned in");
});

test("a comment is POSTed as ADF, and the link goes first so a retry stays cheap", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira(
    [{ status: 201, body: { id: 10_001 } }, { status: 201, body: { id: "99" } }],
    () => jira.annotate!(cfg(), notice(), ctx),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, "linked and commented");
  assert.equal(sent.length, 2);
  // The ORDER is the claim: the idempotent write is attempted first, so retrying a delivery
  // whose comment failed re-posts one link rather than adding a second.
  assert.match(sent[0]!.url, /\/remotelink$/);
  assert.equal(sent[1]!.url, "https://acme.atlassian.net/rest/api/3/issue/MC-431/comment");
  assert.equal(sent[1]!.method, "POST");
  assert.equal(sent[1]!.authorization, BASIC);

  // ADF, not a string: Jira Cloud's v3 comment endpoint refuses wiki markup, and a bare url
  // in an ADF text node is not a link.
  const body = sent[1]!.body as { body: { type: string; content: unknown[] } };
  assert.equal(body.body.type, "doc");
  const flat = JSON.stringify(body.body);
  assert.match(flat, /"type":"link"/);
  assert.match(flat, /https:\/\/github\.com\/acme\/demo\/pull\/9/);
  assert.match(flat, /Fix the parser/);
});

// ADF does not allow a literal newline inside a text node - Jira answers one with a 400 - and
// a completion's own words are the block that can carry them, since `outcome` is whatever the
// task wrote. The CLI rung keeps them as newlines, which is what it wants.
test("a multi-line outcome becomes hardBreak nodes, never a newline inside a text node", () => {
  const n = notice({ signal: "task-completed", outcome: "shipped it\nand tidied up\n\nthen left" });
  const doc = commentBodyAdf(n) as {
    content: { content: { type: string; text?: string }[] }[];
  };
  const nodes = doc.content.flatMap((p) => p.content);
  for (const node of nodes) {
    if (node.type !== "text") continue;
    assert.doesNotMatch(node.text ?? "", /\n/, "a text node carried a literal newline");
  }
  assert.ok(
    nodes.some((node) => node.type === "hardBreak"),
    "a multi-line outcome produced no hardBreak",
  );
  // The words survive, in order, whichever shape they are in.
  const rendered = nodes.map((node) => (node.type === "hardBreak" ? "\n" : node.text ?? "")).join("");
  assert.match(rendered, /shipped it\nand tidied up/);
  // And the CLI rung still gets the newlines it wants.
  assert.match(commentBodyText(n), /shipped it\nand tidied up/);
});

// A read never mutates, so nothing about it can be "may have landed". Routing it through the
// write reader marked a resolve unknown on a transient blip, and the ledger never retries an
// unknown automatically - leaving a resolve that changed nothing waiting for a human.
test("a failed transitions read is retryable, never an unknown outcome", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira([], () =>
    jira.resolve!(
      cfg({ resolveTransition: "Done" }),
      notice({ action: "resolve", signal: "task-completed" }),
      ctx,
    ),
  );
  // The stub runs out of scripted replies and answers 500, which is a read failure.
  assert.match(result.error!, /MC-431 could not be read/);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(sent.length, 1, "a failed read was followed by a transition POST");
});

// The same rule under the failure that actually produces an unknown on the write path: a
// timeout. The read still reports retryable, because a GET cannot have moved anything.
test("a timed-out transitions read is still retryable", () => {
  const r = restReadFailure(
    { ok: false, status: 0, body: "The operation was aborted due to timeout (TimeoutError)" },
    cfg(),
    "MC-431 could not be read",
  );
  assert.equal(r.outcomeUnknown, false);
  assert.match(r.error!, /could not reach Jira at acme\.atlassian\.net/);
  assert.doesNotMatch(r.error!, /check the issue in Jira before retrying/);
  // Contrast: the same shape on the WRITE path is unknown, and must stay that way.
  const w = restWritebackFailure(
    { ok: false, status: 0, body: "The operation was aborted due to timeout (TimeoutError)" },
    cfg(),
    'MC-431 could not be moved to "Done"',
  );
  assert.equal(w.outcomeUnknown, true);
});

test("a comment-only source posts the comment and never asks for a remote link", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira([{ status: 201, body: { id: "99" } }], () =>
    jira.annotate!(cfg({ linkVia: "comment" }), notice(), ctx),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, "commented");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.url, /\/comment$/);
});

test("a resolve reads the issue's transitions and POSTs the one that reaches the target", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira(
    [
      {
        status: 200,
        body: {
          fields: { status: { name: "In Review" } },
          transitions: [
            { id: "31", name: "Ready for QA", to: { name: "QA" } },
            { id: "41", name: "Finish work", to: { name: "Done" } },
          ],
        },
      },
      { status: 204 },
    ],
    () =>
      jira.resolve!(
        cfg({ resolveTransition: "Done" }),
        notice({ action: "resolve", signal: "task-completed" }),
        ctx,
      ),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, 'moved to "Done"');
  assert.equal(sent.length, 2);
  // ONE read for both facts: what the issue can do, and where it is standing - the refusal
  // sentence needs to name both, and a second round trip for the status would be waste.
  assert.equal(sent[0]!.method, "GET");
  assert.equal(
    sent[0]!.url,
    "https://acme.atlassian.net/rest/api/3/issue/MC-431?fields=status&expand=transitions",
  );
  // Matched on the STATUS it lands in, since the workflow's button is called something else.
  assert.equal(sent[1]!.method, "POST");
  assert.equal(sent[1]!.url, "https://acme.atlassian.net/rest/api/3/issue/MC-431/transitions");
  assert.deepEqual(sent[1]!.body, { transition: { id: "41" } });
});

// The GitHub source's already-closed rule, on the verb that changes state. Applying a
// transition to reach a status the issue is already in is at best a no-op and at worst an
// extra entry in somebody's history - and a person may have put it there deliberately.
test("an issue already in the target status is success, and is not transitioned again", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira(
    [
      {
        status: 200,
        body: {
          fields: { status: { name: "Done" } },
          transitions: [{ id: "51", name: "Reopen", to: { name: "To Do" } }],
        },
      },
    ],
    () =>
      jira.resolve!(
        cfg({ resolveTransition: "done" }),
        notice({ action: "resolve", signal: "task-completed" }),
        ctx,
      ),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, 'already "Done"');
  assert.equal(sent.length, 1, "an issue already in the target status was transitioned anyway");
});

test("a target the workflow cannot reach refuses with the available names, and posts nothing", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira(
    [
      {
        status: 200,
        body: {
          fields: { status: { name: "In Review" } },
          transitions: [
            { id: "31", name: "Ready for QA", to: { name: "QA" } },
            { id: "41", name: "Reject", to: { name: "Rejected" } },
          ],
        },
      },
    ],
    () =>
      jira.resolve!(
        cfg({ resolveTransition: "Done" }),
        notice({ action: "resolve", signal: "task-completed" }),
        ctx,
      ),
  );

  assert.match(result.error!, /MC-431 cannot move to "Done" from "In Review"/);
  assert.match(result.error!, /Ready for QA \(to QA\), Reject \(to Rejected\)/);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(sent.length, 1, "a refused transition was POSTed anyway");
});

// The one place a transition screen's required field exists is Jira's own message, so it is
// quoted rather than summarised - and a status Jira SENT means nothing was written.
// A 200 that is not JSON. Jira Cloud does not do this, but a captive portal, a proxy error
// page or a misrouted request does - and the answer looks SUCCESSFUL, which is what makes it
// worth its own case. The refusal must arrive before any transition is POSTed: the whole
// point of reading first is that this source never moves an issue it could not read.
test("a successful transition read that is not JSON refuses, and transitions nothing", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira(
    [{ status: 200, raw: "<!doctype html><title>Sign in</title>" }],
    () =>
      jira.resolve!(
        cfg({ resolveTransition: "Done" }),
        notice({ action: "resolve", signal: "task-completed" }),
        ctx,
      ),
  );

  assert.match(result.error!, /Jira's answer for MC-431 was not JSON/);
  assert.match(result.error!, /transitions could not be read/);
  // Nothing left the process after the read, so the ledger may retry once the route is fixed.
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.detail, null);
  assert.equal(sent.length, 1, "an unreadable answer was followed by a transition POST");
  assert.equal(sent[0]!.method, "GET");
});

// The same shape one step further in: readable JSON that simply does not describe an issue.
// `transitionsFrom` reads it as no transitions rather than throwing, so the refusal is the
// one that names the workflow - and it still must not POST anything.
test("a transition read with no transitions in it refuses without transitioning", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira([{ status: 200, body: { fields: {} } }], () =>
    jira.resolve!(
      cfg({ resolveTransition: "Done" }),
      notice({ action: "resolve", signal: "task-completed" }),
      ctx,
    ),
  );

  assert.match(result.error!, /MC-431 offers no transitions/);
  assert.match(result.error!, /allowed to transition the issue/);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(sent.length, 1, "an issue with no transitions was POSTed to anyway");
});

test("a refused transition POST quotes Jira's first message and stays retryable", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira(
    [
      {
        status: 200,
        body: {
          fields: { status: { name: "In Review" } },
          transitions: [{ id: "41", name: "Done", to: { name: "Done" } }],
        },
      },
      { status: 400, body: { errors: { resolution: "Resolution is required" } } },
    ],
    () =>
      jira.resolve!(
        cfg({ resolveTransition: "Done" }),
        notice({ action: "resolve", signal: "task-completed" }),
        ctx,
      ),
  );

  assert.match(result.error!, /MC-431 could not be moved to "Done"/);
  assert.match(result.error!, /HTTP 400/);
  assert.match(result.error!, /Resolution is required/);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(sent.length, 2);
});

// The operator decision this phase is held to: a misconfigured resolve names the fix AND
// lists the transitions actually available from where the issue is standing. The CLI rung
// cannot read transitions, so when a credential exists the refusal must come from the rung
// that can - otherwise an older jira-cli, which just says no, leaves the operator with a
// sentence pointing at a list nobody printed.
// THE contract this verb is held to, at its hardest point: a machine where the CLI is the
// only rung. jira-cli can move an issue but cannot be asked what an issue can do, so a
// refusal from it could not list the reachable transitions - and an unactionable refusal is
// the failure the operator decision exists to prevent. So the capability is required up
// front, before a subprocess, and the refusal names the single thing that supplies it.
test("a CLI-only machine refuses to resolve before attempting it, and names the one fix", async () => {
  const argv = join(home, "argv-cli-only-resolve.txt");
  writeFileSync(argv, "");
  machine({ cli: true, argv });

  const r = await jira.resolve!(
    cfg({ resolveTransition: "Done" }),
    notice({ action: "resolve", signal: "task-completed" }),
    ctx,
  );

  assert.match(r.error!, /resolving an issue needs JIRA_API_TOKEN and JIRA_EMAIL/);
  assert.match(r.error!, /cannot be asked which moves are available/);
  assert.match(r.error!, /turn this source's resolve switch off/);
  assert.equal(r.outcomeUnknown, false);
  assert.equal(r.detail, null);
  // Refused BEFORE attempting: nothing was spawned, so nothing upstream was touched and no
  // issue was left in a state the operator would have to go and check.
  assert.equal(argvIn(argv).length, 0, "a resolve it could not honour ran the CLI anyway");
});

// The same machine, with the egress guard also in play: the reason the read rung is missing
// is worth carrying, because "set the credential" is unhelpful when the credential exists and
// may not be sent here.
test("a resolve names why the read rung is missing when a credential exists but cannot be used", async () => {
  machine({ cli: true, email: "ops@acme.co", token: "s3cret" });
  const r = await jira.resolve!(
    cfg({ site: "jira.evil.example", resolveTransition: "Done" }),
    notice({ action: "resolve", signal: "task-completed" }),
    ctx,
  );
  assert.match(r.error!, /resolving an issue needs JIRA_API_TOKEN and JIRA_EMAIL/);
  assert.match(r.error!, /refusing to send JIRA_API_TOKEN to jira\.evil\.example/);
  assert.equal(r.outcomeUnknown, false);
});

// With the read rung present the CLI still goes first, exactly as a sweep's ladder does, and
// a successful move costs no REST call at all.
test("with both rungs, the CLI moves the issue and the credential rung is not called", async () => {
  const argv = join(home, "argv-cli-first-move.txt");
  writeFileSync(argv, "");
  machine({ cli: true, argv, email: "ops@acme.co", token: "s3cret" });

  const { result, sent } = await withScriptedJira([], () =>
    jira.resolve!(
      cfg({ resolveTransition: "Done" }),
      notice({ action: "resolve", signal: "task-completed" }),
      ctx,
    ),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, 'moved to "Done"');
  assert.deepEqual(argvIn(argv)[0], jiraMoveArgs("MC-431", "Done"));
  assert.equal(sent.length, 0, "a successful CLI move still spent a REST call");
});

// The half-configured machine the sweep's ladder was built for, carried through to a
// SUCCESSFUL delivery rather than only to a routing decision. `jira` is on PATH, `jira init`
// was never run, and the tokens are exported for the shell helpers - so the CLI is tried,
// found unusable, and the credential rung actually posts the comment.
test("an unusable CLI hands the comment to REST, which posts it", async () => {
  const argv = join(home, "argv-cli-unusable-comment.txt");
  writeFileSync(argv, "");
  machine({ cli: true, mode: "unconfigured", argv, email: "ops@acme.co", token: "s3cret" });

  const { result, sent } = await withScriptedJira([{ status: 201, body: { id: "99" } }], () =>
    jira.annotate!(cfg({ linkVia: "comment" }), notice(), ctx),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, "commented");
  // The CLI was tried first, exactly once, and then handed over.
  assert.deepEqual(argvIn(argv)[0]?.slice(0, 4), ["issue", "comment", "add", "MC-431"]);
  assert.equal(argvIn(argv).length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "POST");
  assert.equal(sent[0]!.url, "https://acme.atlassian.net/rest/api/3/issue/MC-431/comment");
  // And it is the ADF body, not the plain text the CLI would have taken.
  const body = sent[0]!.body as { body: { type: string } };
  assert.equal(body.body.type, "doc");
});

// The same handover on the verb that changes state: the CLI cannot run, so the credential
// rung does the whole read-match-transition and the issue actually moves.
test("an unusable CLI hands the resolve to REST, which reads, matches and transitions", async () => {
  const argv = join(home, "argv-cli-unusable-move.txt");
  writeFileSync(argv, "");
  machine({ cli: true, mode: "unconfigured", argv, email: "ops@acme.co", token: "s3cret" });

  const { result, sent } = await withScriptedJira(
    [
      {
        status: 200,
        body: {
          fields: { status: { name: "In Review" } },
          transitions: [
            { id: "31", name: "Ready for QA", to: { name: "QA" } },
            { id: "41", name: "Finish work", to: { name: "Done" } },
          ],
        },
      },
      { status: 204 },
    ],
    () =>
      jira.resolve!(
        cfg({ resolveTransition: "Done" }),
        notice({ action: "resolve", signal: "task-completed" }),
        ctx,
      ),
  );

  assert.equal(result.error, null, result.error ?? "");
  assert.equal(result.detail, 'moved to "Done"');
  assert.deepEqual(argvIn(argv)[0], jiraMoveArgs("MC-431", "Done"));
  assert.equal(argvIn(argv).length, 1, "the CLI move was attempted more than once");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.method, "GET");
  assert.equal(sent[1]!.method, "POST");
  // Matched on the status it lands in, since the workflow button is called something else.
  assert.deepEqual(sent[1]!.body, { transition: { id: "41" } });
});

test("a CLI refusal is answered by the credential rung, which can name what IS reachable", async () => {
  const argv = join(home, "argv-cli-then-rest.txt");
  writeFileSync(argv, "");
  machine({ cli: true, mode: "badtransition", argv, email: "ops@acme.co", token: "s3cret" });

  const { result, sent } = await withScriptedJira(
    [
      {
        status: 200,
        body: {
          fields: { status: { name: "In Review" } },
          transitions: [
            { id: "31", name: "Ready for QA", to: { name: "QA" } },
            { id: "41", name: "Reject", to: { name: "Rejected" } },
          ],
        },
      },
    ],
    () =>
      jira.resolve!(
        cfg({ resolveTransition: "Done" }),
        notice({ action: "resolve", signal: "task-completed" }),
        ctx,
      ),
  );

  // The CLI was tried first and refused, and then the credential rung READ the issue.
  assert.equal(argvIn(argv).length, 1, "the CLI move was not attempted first");
  assert.equal(sent.length, 1, "the refused move was re-POSTed instead of only being read");
  assert.equal(sent[0]!.method, "GET");
  assert.match(result.error!, /MC-431 cannot move to "Done" from "In Review"/);
  assert.match(result.error!, /available from here: Ready for QA \(to QA\), Reject \(to Rejected\)/);
  assert.equal(result.outcomeUnknown, false);
});

// The state that must never be retried on the other rung. `jira issue move` timing out means
// the transition MAY have happened, and this is the verb that changes state.
test("a CLI move with an unreadable outcome is never retried over REST", async () => {
  machine({ cli: true, mode: "hang", email: "ops@acme.co", token: "s3cret" });
  const { result, sent } = await withScriptedJira([{ status: 200, body: {} }], () =>
    jira.resolve!(
      cfg({ resolveTransition: "Done" }),
      notice({ action: "resolve", signal: "task-completed" }),
      ctx,
    ),
  );
  assert.equal(result.outcomeUnknown, true);
  assert.match(result.error!, /check the issue in Jira before retrying/);
  assert.equal(sent.length, 0, "an unreadable move was retried on the credential rung");
});

test("a rejected credential is reported as the credential, not as a broken issue", async () => {
  restMachine();
  const { result } = await withScriptedJira(
    [{ status: 401, body: { errorMessages: ["Client must be authenticated"] } }],
    () => jira.annotate!(cfg({ linkVia: "remote-link" }), notice(), ctx),
  );

  assert.match(result.error!, /the remote link could not be posted/);
  assert.match(result.error!, /HTTP 401/);
  assert.match(result.error!, /JIRA_EMAIL is allowed to comment on and transition this issue/);
  assert.equal(result.outcomeUnknown, false);
});

// A failed remote link stops the delivery BEFORE the comment, which is what keeps a retry
// from adding a comment each time while the link keeps failing.
test("a failed remote link is reported before the comment is attempted", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira([{ status: 403, body: { errorMessages: ["forbidden"] } }], () =>
    jira.annotate!(cfg(), notice(), ctx),
  );

  assert.match(result.error!, /the remote link could not be posted/);
  assert.equal(sent.length, 1, "the comment was attempted after the link failed");
});

// The egress guard at the rung that actually attaches the credential, not merely at its
// caller. A security refusal enforced only by its caller is one refactor from being gone.
test("no request is built at all for a host the credential may not reach", async () => {
  restMachine();
  const { result, sent } = await withScriptedJira([{ status: 200, body: {} }], () =>
    jira.annotate!(cfg({ site: "jira.evil.example", linkVia: "remote-link" }), notice(), ctx),
  );

  assert.match(result.error!, /refusing to send JIRA_API_TOKEN to jira\.evil\.example/);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(sent.length, 0, "a request was built for a host the token may not reach");
});

// `fetch` throwing is not the same answer as Jira refusing. A connection that was never made
// cannot have been acted on; anything else may have been, and the ledger must not retry it.
test("a thrown fetch is read as never-arrived or unknown, by its cause code", async () => {
  restMachine();
  const real = globalThis.fetch;
  const throwWith = async (code: string) => {
    globalThis.fetch = (async () => {
      const err = new Error("fetch failed");
      (err as { cause?: unknown }).cause = { code };
      throw err;
    }) as typeof globalThis.fetch;
    try {
      return await jira.annotate!(cfg({ linkVia: "remote-link" }), notice(), ctx);
    } finally {
      globalThis.fetch = real;
    }
  };

  const refused = await throwWith("ECONNREFUSED");
  assert.match(refused.error!, /could not reach Jira at acme\.atlassian\.net/);
  assert.match(refused.error!, /ECONNREFUSED/);
  assert.equal(refused.outcomeUnknown, false, "a connection never made was called unknown");

  const timedOut = await throwWith("UND_ERR_HEADERS_TIMEOUT");
  assert.equal(timedOut.outcomeUnknown, true, "a timeout was called a refusal");
  assert.match(timedOut.error!, /check the issue in Jira before retrying/);
});
