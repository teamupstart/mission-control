// acli uses its own OAuth site. A profile switch must never file another site's issues.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraConfigSchema } from "../src/shared/task-source.ts";
import type { JiraConfig, SweepContext, WritebackNotice } from "../src/shared/task-source.ts";
import { acliBin } from "../src/server/config.ts";
import {
  acliActiveSite, acliAnnotate, acliCommentArgs, acliFailure, acliFault, acliPreflight, acliResolve, acliSearchArgs, acliSiteGate,
  readAcli, type JiraAcliDeps,
} from "../src/server/task-sources/jira-acli.ts";
import { jira, MAX_SWEEP_ISSUES, sweepResultFromWalk } from "../src/server/task-sources/jira.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { writeFakeAgents } from "../e2e/fixtures/fake-agents.ts";

function fixture(name: string): RunResult {
  return stubRun(JSON.parse(readFileSync(new URL(`./fixtures/acli/${name}.json`, import.meta.url), "utf8")));
}
const cfg = (over: Partial<JiraConfig> = {}) => JiraConfigSchema.parse({
  queryVia: "acli", site: "example.atlassian.net", jql: "project = MC", ...over,
});
const ctx: SweepContext = { sourceId: "acli", repoRoot: tmpdir(), signal: new AbortController().signal };
function scripted(...answers: RunResult[]) {
  const calls: { bin: string; args: string[]; opts: Parameters<JiraAcliDeps["run"]>[2] }[] = [];
  const deps: JiraAcliDeps = {
    run: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const answer = answers.shift();
      assert.ok(answer, "an unexpected subprocess was requested");
      return answer;
    },
  };
  return { calls, deps };
}

const notice: WritebackNotice = {
  externalId: "MC-2", externalUrl: "https://example.atlassian.net/browse/MC-2",
  taskTitle: "Repair parser", prUrl: "https://github.com/acme/demo/pull/9", repoRoot: tmpdir(),
  signal: "task-completed", action: "annotate", outcome: "Completed parser repair", observedAt: 1,
};
const ok = (body: unknown = {}) => stubRun({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const auth = () => fixture("jira-auth-status");
const status = (name: string, extra: Record<string, unknown> = {}) => ok({
  ...JSON.parse(fixture("view-status").stdout), fields: { status: { name } }, ...extra,
});
const otherSite = () => stubRun({ code: 0, stdout: "Site: other.atlassian.net", stderr: "" });
const refused = () => stubRun({ code: 1, stdout: "", stderr: "✗ Error: Workflow requires review; available: In Review" });

test("comment argv carries ADF with a clickable PR link; every link style delivers a comment", async () => {
  const args = acliCommentArgs("MC-2", notice);
  assert.deepEqual(args.slice(0, 7), ["jira", "workitem", "comment", "create", "--key", "MC-2", "--body"]);
  const body = JSON.parse(args[7]!);
  assert.equal(body.type, "doc");
  assert.ok(body.content.flatMap((p: { content: { marks?: unknown[] }[] }) => p.content)
    .some((n: { marks?: { type: string; attrs: { href: string } }[] }) => n.marks?.some((m) => m.type === "link" && m.attrs.href === notice.prUrl)));
  for (const linkVia of ["comment", "both", "remote-link"] as const) {
    const { calls, deps } = scripted(auth(), ok(), auth());
    const result = await acliAnnotate(cfg({ linkVia }), notice, ctx, deps);
    assert.equal(result.error, null);
    assert.equal(result.outcomeUnknown, false);
    assert.match(result.detail!, /commented/);
    if (linkVia !== "comment") assert.match(result.detail!, /remote link is unavailable.*comment carries the pull request link/);
    else assert.equal(result.detail, "commented");
    assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [["jira", "auth", "status"], ["jira", "workitem", "comment"], ["jira", "auth", "status"]]);
    for (const call of calls) assert.equal(call.opts?.input, "");
  }
  const { deps } = scripted(auth(), ok(), auth());
  assert.equal((await acliAnnotate(cfg(), { ...notice, prUrl: null }, ctx, deps)).detail, "commented; no pull request to link");
});

test("acli keeps unsupported completion URLs as text without creating ADF links", async () => {
  for (const prUrl of [
    "javascript:alert(1)",
    "data:text/html,untrusted",
    "https://user:password@github.com/acme/demo/pull/9",
    "https://untrusted.example/acme/demo/pull/9",
    "https://github.com.untrusted.example/acme/demo/pull/9",
    "https://untrusted.example/#https://github.com/acme/demo/pull/9",
    "https://github.com/acme/demo/issues/9",
    "not a URL",
  ]) {
    const args = acliCommentArgs("MC-2", { ...notice, prUrl });
    const body = JSON.parse(args[7]!);
    assert.ok(body.content.flatMap((paragraph: { content: { text?: string }[] }) => paragraph.content)
      .some((node: { text?: string }) => node.text?.includes(prUrl)), "the original URL must remain readable");
    assert.deepEqual(body.content.flatMap((paragraph: { content: { marks?: unknown[] }[] }) => paragraph.content)
      .flatMap((node: { marks?: unknown[] }) => node.marks ?? []), [], prUrl);
    const { deps } = scripted(auth(), ok(), auth());
    const result = await acliAnnotate(cfg(), { ...notice, prUrl }, ctx, deps);
    assert.equal(result.error, null);
    assert.match(result.detail!, /supplied URL as plain text/);
  }
});

test("acli retains clickable GitHub PR links with query strings, fragments and trailing slashes", () => {
  for (const prUrl of [notice.prUrl!, `${notice.prUrl}?view=files#discussion`, `${notice.prUrl}/`]) {
    const body = JSON.parse(acliCommentArgs("MC-2", { ...notice, prUrl })[7]!);
    assert.ok(body.content.flatMap((paragraph: { content: { marks?: { attrs?: { href?: string } }[] }[] }) => paragraph.content)
      .some((node: { marks?: { attrs?: { href?: string } }[] }) => node.marks?.some((mark) => mark.attrs?.href === prUrl)));
  }
});

test("acli write diagnostics redact credentials and common personal identifiers before returning", async () => {
  const secret = `opaque-${"synthetic".repeat(4)}`;
  const email = "person@example.test";
  const jsonSecret = "short-test-key";
  const text = `Workflow requires review; Bearer ${secret}; contact ${email}; id 000-00-0000; "access_token":"${jsonSecret}"; Basic authentication needs review\nAuthorization: Basic dTpw\n"Authorization":"Bearer tiny"\nAuthorization: token tok-test\nAuthorization: AWS4-HMAC-SHA256 Credential=scope-demo,SignedHeaders=host;x-amz-date,Signature=sig-test`;
  const failure = stubRun({ code: 1, stdout: "", stderr: text });
  const results = [
    await acliAnnotate(cfg(), notice, ctx, scripted(auth(), failure, auth()).deps),
    await acliAnnotate(cfg(), notice, ctx, scripted(auth(), ok([{ key: "MC-2", success: false, error: text }]), auth()).deps),
    await acliAnnotate(cfg(), notice, ctx, scripted(failure).deps),
    await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx,
      scripted(auth(), status("In Review"), auth(), ok([{ success: false, message: text }]), auth()).deps),
    await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx,
      scripted(auth(), status("In Review"), auth(), ok({ message: text, metadata: "private response metadata" }), auth(), auth(), status("In Review"), auth()).deps),
  ];
  for (const result of results) {
    assert.match(result.error!, /Workflow requires review/);
    assert.match(result.error!, /\[redacted\]/);
    for (const value of [secret, jsonSecret, email, "000-00-0000", "dTpw", "tiny", "tok-test", "scope-demo", "sig-test"]) assert.ok(!result.error!.includes(value));
    assert.match(result.error!, /Basic authentication needs review/);
  }
});

test("acli scrubs a write-site diagnostic before the inherited classifier truncates it", async () => {
  const secret = `opaque-${"synthetic".repeat(4)}`;
  const prefix = `${"x".repeat(289)} Bearer `;
  const { deps, calls } = scripted(stubRun({ code: 1, stdout: "", stderr: prefix + secret }));
  const result = await acliAnnotate(cfg(), notice, ctx, deps);
  assert.ok(result.error);
  assert.ok(!result.error.includes(secret.slice(0, 3)), "truncation must not expose a partial credential");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, ["jira", "auth", "status"]);
});

test("acli never copies an unrecognized transition response body into the refusal", async () => {
  const { deps } = scripted(auth(), status("In Review"), auth(), ok({ metadata: "private response metadata" }), auth(), auth(), status("In Review"), auth());
  const result = await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, deps);
  assert.match(result.error!, /the confirming read still shows another status/);
  assert.doesNotMatch(result.error!, /private response metadata/);
});

test("failed, unknown and mismatched site proof prevents every write, including repeat attempts", async () => {
  for (const gate of [fixture("logged-out"), ok(), otherSite(), { ...auth(), outcomeUnknown: true }]) {
    for (const operation of [acliAnnotate, acliResolve]) {
      const { calls, deps } = scripted(gate, gate);
      for (let i = 0; i < 2; i++) {
        const result = await operation(cfg({ resolveTransition: "Done" }), notice, ctx, deps);
        assert.equal(result.outcomeUnknown, false);
        assert.match(result.error!, /nothing was written/);
      }
      assert.ok(calls.every((c) => c.args.join(" ") === "jira auth status"));
    }
  }
});

test("invalid targets and empty resolve status refuse before any process, with empty status first", async () => {
  const { calls, deps } = scripted();
  assert.match((await acliResolve(cfg({ site: "", resolveTransition: "" }), { ...notice, externalId: "bad" }, ctx, deps)).error!, /names no target status/);
  for (const operation of [acliAnnotate, acliResolve]) {
    assert.match((await operation(cfg({ resolveTransition: "Done" }), { ...notice, externalId: "MC-2/evil" }, ctx, deps)).error!, /not a Jira issue key/);
    assert.ok((await operation(cfg({ site: "", resolveTransition: "Done" }), notice, ctx, deps)).error);
  }
  assert.equal(calls.length, 0);
});

test("comment refusals are retryable but killed writes and post-write site failures are unknown", async () => {
  for (const [res, post, unknown, message] of [
    [refused(), auth(), false, /Workflow requires review/],
    [{ ...refused(), outcomeUnknown: true }, auth(), true, /check the issue in Jira before retrying/],
    [ok(), otherSite(), true, /MC-2.*example.atlassian.net.*other.atlassian.net.*check both sites/],
    [ok(), fixture("logged-out"), true, /MC-2.*example.atlassian.net.*not logged in/],
    [ok(), ok(), true, /cannot confirm which Jira site/],
    [ok({ self: "https://other.atlassian.net/rest/api/3/issue/2" }), auth(), true, /other.atlassian.net.*example.atlassian.net/],
    [ok({ operation: { self: "https://other.atlassian.net/rest/api/3/issue/2" } }), auth(), true, /other.atlassian.net.*example.atlassian.net/],
    [ok({ self: 42 }), auth(), true, /cannot confirm the Jira site/],
    [ok([{ key: "MC-2", success: false, error: "Workflow refused" }]), otherSite(), true, /check both sites/],
  ] as const) {
    const { deps, calls } = scripted(auth(), res, post);
    const result = await acliAnnotate(cfg(), notice, ctx, deps);
    assert.equal(result.outcomeUnknown, unknown);
    assert.match(result.error!, message);
    assert.equal(calls.length, 3, "every attempted write gets a post-site check");
  }
});

test("resolve already there reads captured status without moving, and failed reads never imply unknown writes", async () => {
  const already = scripted(auth(), fixture("view-status"), auth());
  assert.equal((await acliResolve(cfg({ resolveTransition: "to do" }), notice, ctx, already.deps)).detail, 'already "To Do"');
  assert.equal(already.calls.length, 3);
  for (const view of [refused(), { ...refused(), outcomeUnknown: true }, ok({}), ok({ fields: { status: { name: "Done" } }, self: "https://other.atlassian.net/rest/api/3/issue/2" })]) {
    const { deps, calls } = scripted(auth(), view);
    const result = await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, deps);
    assert.ok(result.error);
    assert.equal(result.outcomeUnknown, false);
    assert.equal(calls.length, 2);
  }
  const switched = scripted(auth(), status("In Review"), otherSite());
  assert.equal((await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, switched.deps)).outcomeUnknown, false);
  assert.equal(switched.calls.length, 3, "profile changed during read must not start a transition");
});

test("a transition-name target already at its known destination settles without a write", async () => {
  const transitions = [{ id: "31", name: "Finish work", to: { name: "Done" } }];
  const already = scripted(auth(), status("Done", { transitions }), auth());
  const result = await acliResolve(cfg({ resolveTransition: "Finish work" }), notice, ctx, already.deps);
  assert.equal(result.error, null);
  assert.equal(result.detail, 'already "Done"');
  assert.equal(already.calls.length, 3);

  // An unavailable transition name supplies no destination proof. Do not guess at Done.
  const absent = scripted(auth(), status("Done", { transitions: [] }), auth());
  const refusal = await acliResolve(cfg({ resolveTransition: "Finish work" }), notice, ctx, absent.deps);
  assert.match(refusal.error!, /offers no transitions/);
  assert.equal(absent.calls.length, 3);
  const direct = scripted(auth(), status("Done", { transitions: [] }), auth());
  assert.equal((await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, direct.deps)).detail, 'already "Done"');
  assert.equal(direct.calls.length, 3);
});

test("transition success needs a confirming status, even with unrecognized or non-JSON output", async () => {
  for (const result of [ok({ results: [{ key: "MC-2", success: true }] }), ok({ unexpected: "shape" }), stubRun({ code: 0, stdout: "not JSON", stderr: "" })]) {
    const { deps, calls } = scripted(auth(), status("In Review"), auth(), result, auth(), auth(), status("Done"), auth());
    const moved = await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, deps);
    assert.equal(moved.error, null);
    assert.equal(moved.detail, 'moved to "Done"');
    assert.deepEqual(calls[3]!.args, ["jira", "workitem", "transition", "--key", "MC-2", "--status", "Done", "--yes", "--json"]);
    assert.ok(calls.every((c) => c.opts?.input === ""));
  }
});

test("transition refusals quote current status and CLI reason, including exit-zero per-issue errors", async () => {
  for (const answer of [refused(), ok([{ key: "MC-2", success: false, message: "Workflow requires review" }]), ok({ results: [{ key: "MC-2", error: "Workflow requires review" }] }), ok({ errors: ["Workflow requires review"] })]) {
    const { deps } = scripted(auth(), status("In Review"), auth(), answer, auth());
    const result = await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, deps);
    assert.equal(result.outcomeUnknown, false);
    assert.match(result.error!, /MC-2 cannot move to "Done" from "In Review".*Workflow requires review/);
  }
});

test("unchanged confirming status is a refusal; a lost confirmation or write is unknown", async () => {
  const unchanged = scripted(auth(), status("In Review"), auth(), ok({ message: "Not moved" }), auth(), auth(), status("In Review"), auth());
  const result = await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, unchanged.deps);
  assert.equal(result.outcomeUnknown, false);
  assert.match(result.error!, /from "In Review".*Not moved/);
  for (const [write, post, tail] of [
    [ok(), auth(), [auth(), refused()]],
    [ok(), auth(), [auth(), status("Done"), otherSite()]],
    [{ ...refused(), outcomeUnknown: true }, auth(), []],
    [ok(), otherSite(), []],
    [ok({ results: [{ key: "MC-2", self: "https://other.atlassian.net/rest/api/3/issue/2" }] }), auth(), []],
  ] as const) {
    const { deps } = scripted(auth(), status("In Review"), auth(), write, post, ...tail);
    const result = await acliResolve(cfg({ resolveTransition: "Done" }), notice, ctx, deps);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error!, /MC-2.*example.atlassian.net.*check the issue in Jira before retrying/);
  }
});

test("a supplied transition list is honored, using the destination status and listing reachable moves", async () => {
  const transitions = [{ id: "31", name: "Finish work", to: {
    ...JSON.parse(fixture("view-status").stdout).fields.status, name: "Done",
  } }];
  const matched = scripted(auth(), status("In Review", { transitions }), auth(), ok(), auth(), auth(), status("Done"), auth());
  assert.equal((await acliResolve(cfg({ resolveTransition: "Finish work" }), notice, ctx, matched.deps)).detail, 'moved to "Done"');
  assert.equal(matched.calls[3]!.args[6], "Done");
  const unreachable = scripted(auth(), status("In Review", { transitions }), auth());
  const refused = await acliResolve(cfg({ resolveTransition: "Closed" }), notice, ctx, unreachable.deps);
  assert.match(refused.error!, /In Review.*available from here: Finish work \(to Done\)/);
  assert.equal(unreachable.calls.length, 3);
});

test("argv keeps JQL as one argument, probes the tail, and bounds pagination", () => {
  assert.deepEqual(acliSearchArgs(cfg({ jql: ' project = MC AND summary ~ "a b" ' }), 1000), [
    "jira", "workitem", "search", "--jql", 'project = MC AND summary ~ "a b"',
    "--fields", "key,summary,description,priority", "--json", "--limit", "1001", "--paginate",
  ]);
});

test("captured failures name the specific operator fix", () => {
  for (const [name, fault, fix] of [
    ["logged-out", "unauthenticated", "acli jira auth login --web"],
    ["unknown-flag", "unsupported-flag", "brew upgrade acli"],
    ["search-invalid", "refused", "check the JQL"],
  ] as const) {
    assert.equal(acliFault(fixture(name)), fault);
    assert.ok(acliFailure(fixture(name)).includes(fix));
  }
  const missing = stubRun({ code: 127, stdout: "", stderr: "spawn acli ENOENT" });
  assert.equal(acliFault(missing), "not-installed");
  assert.match(acliFailure(missing), /brew tap atlassian\/homebrew-acli && brew install acli/);
  const killed = { ...missing, outcomeUnknown: true };
  assert.equal(acliFault(killed), "no-answer");
  assert.match(acliFailure(killed), /did not answer/);
  assert.match(acliFailure({ ...killed, overflowed: true }), /too much output.*narrow the JQL/);
  assert.doesNotMatch(acliFailure(fixture("search-invalid")), /✗ Error:/);
  assert.equal(acliFault(stubRun({ code: 1, stdout: "", stderr: "Issue not found" })), "refused");
});

test("only an unambiguous, successful Jira status positively identifies the active site", () => {
  assert.equal(acliActiveSite(fixture("jira-auth-status")), "example.atlassian.net");
  assert.equal(acliActiveSite(fixture("auth-status")), null);
  assert.equal(acliActiveSite(fixture("logged-out")), null);
  for (const stdout of ["", "✓ Authenticated", "Site: a.atlassian.net\nSite: b.atlassian.net", "Site: https://user@evil.example"]) {
    assert.equal(acliActiveSite(stubRun({ code: 0, stdout, stderr: "" })), null);
  }
});

test("capture sanitization preserves the distinction between public auth site and internal issue self host", () => {
  assert.equal(acliActiveSite(fixture("jira-auth-status")), "example.atlassian.net");
  for (const name of ["search-one", "search-three", "search-paginate"]) {
    const issues = JSON.parse(fixture(name).stdout);
    assert.ok(issues.length);
    for (const issue of issues) {
      assert.equal(new URL(issue.self).hostname, "jira-prod-us-0-0.prod.atl-paas.net");
    }
  }
});

test("all captured successful searches use the shared mapper, including an empty healthy page", async () => {
  for (const [name, count] of [["search-one", 1], ["search-three", 3], ["search-paginate", 3], ["search-empty", 0]] as const) {
    const { deps, calls } = scripted(fixture("jira-auth-status"), fixture(name), fixture("jira-auth-status"));
    const walk = await readAcli(cfg(), ctx, MAX_SWEEP_ISSUES, deps);
    assert.equal(walk.error, null, name);
    assert.equal(walk.advisory, null, name);
    assert.equal(walk.issues.length, count, name);
    const result = sweepResultFromWalk(walk, cfg(), ctx);
    assert.equal(result.items.length, count);
    if (count) {
      assert.match(result.items[0]!.title, /Synthetic issue text/);
      assert.match(result.items[0]!.ref.url!, /^https:\/\/example.atlassian.net\/browse\/MC-/);
      assert.equal(result.items[0]!.priority, "high");
      assert.match(result.items[0]!.intent, /Synthetic issue text/);
    }
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
      ["jira", "auth", "status"], ["jira", "workitem", "search"], ["jira", "auth", "status"],
    ]);
    for (const call of calls) {
      assert.equal(call.opts?.input, "");
      assert.equal(call.opts?.cwd, ctx.repoRoot);
      assert.equal(call.opts?.timeoutMs, 15_000);
    }
  }
});

test("a probe row preserves the bounded candidates with the existing tail advisory", async () => {
  const { deps } = scripted(fixture("jira-auth-status"), fixture("search-three"), fixture("jira-auth-status"));
  const walk = await readAcli(cfg(), ctx, 2, deps);
  assert.equal(walk.issues.length, 2);
  assert.equal(walk.error, null);
  assert.match(walk.advisory!, /larger than one sweep can read/);
  const result = sweepResultFromWalk(walk, cfg(), ctx);
  assert.equal(result.items.length, 2);
  assert.equal(result.error, walk.advisory);
  assert.doesNotMatch(walk.advisory!, /raise Issues per page|50 requests/);
});

test("even an oversized caller bound cannot exceed the sweep ceiling", async () => {
  const [row] = JSON.parse(fixture("search-one").stdout);
  const rows = Array.from({ length: MAX_SWEEP_ISSUES + 1 }, (_, i) => ({ ...row, key: `MC-${i + 1}` }));
  const { deps, calls } = scripted(fixture("jira-auth-status"), stubRun({ code: 0, stdout: JSON.stringify(rows), stderr: "" }), fixture("jira-auth-status"));
  const walk = await readAcli(cfg({ limit: 1 }), ctx, MAX_SWEEP_ISSUES * 2, deps);
  assert.equal(walk.issues.length, MAX_SWEEP_ISSUES);
  assert.match(walk.advisory!, /1000 issues/);
  assert.ok(calls[1]!.args.includes("1001"));
});

test("preflight and every sweep refuse failed, unknown, or mismatched sites before search", async () => {
  const mismatch = { ...fixture("jira-auth-status"), stdout: "✓ Authenticated\n  Site: other.atlassian.net\n" };
  for (const [status, expected] of [
    [fixture("logged-out"), /acli jira auth login --web/],
    [stubRun({ code: 0, stdout: "✓ Authenticated\n", stderr: "" }), /cannot confirm which Jira site/],
    [mismatch, /other.atlassian.net.*example.atlassian.net.*acli jira auth switch/],
  ] as const) {
    for (const operation of [acliSiteGate, acliPreflight]) {
      const { deps, calls } = scripted(status);
      assert.match((await operation(cfg(), ctx, deps))!, expected);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args, ["jira", "auth", "status"]);
    }
    const { deps, calls } = scripted(status, status);
    for (let i = 0; i < 2; i++) {
      const walk = await readAcli(cfg(), ctx, 10, deps);
      assert.deepEqual(walk.issues, []);
      assert.match(walk.error!, expected);
    }
    assert.equal(calls.length, 2, "site proof must be refreshed each sweep");
  }
});

test("a profile switch reflected in any search self URL rejects the whole result, including its tail", async () => {
  const rows = JSON.parse(fixture("search-three").stdout);
  rows[2].self = "https://other.atlassian.net/rest/api/3/issue/10002";
  const { deps } = scripted(fixture("jira-auth-status"), stubRun({ code: 0, stdout: JSON.stringify(rows), stderr: "" }));
  const walk = await readAcli(cfg(), ctx, 1, deps);
  assert.deepEqual(walk.issues, []);
  assert.match(walk.error!, /other.atlassian.net.*example.atlassian.net/);
});

test("only the captured internal service URL format is normalized; public or missing self stays usable", async () => {
  for (const self of [
    "https://jira-prod-us-0-0.prod.atl-paas.net/rest/api/3/issue/10000",
    "https://example.atlassian.net/rest/api/3/issue/10000", undefined, null,
  ]) {
    const [row] = JSON.parse(fixture("search-one").stdout);
    const { deps } = scripted(fixture("jira-auth-status"), stubRun({
      code: 0, stdout: JSON.stringify([{ ...row, self }]), stderr: "",
    }), fixture("jira-auth-status"));
    const walk = await readAcli(cfg(), ctx, 1, deps);
    assert.equal(walk.error, null);
    assert.match(sweepResultFromWalk(walk, cfg(), ctx).items[0]!.ref.url!, /^https:\/\/example\.atlassian\.net\/browse\/MC-/);
  }
});

test("unexpected service URLs or malformed self values refuse every issue even in the tail", async () => {
  for (const self of [
    "https://jira-prod-us-0-0.prod.atl-paas.net.evil.example/rest/api/3/issue/10000",
    "https://confluence-prod-us-0-0.prod.atl-paas.net/rest/api/3/issue/10000",
    "http://jira-prod-us-0-0.prod.atl-paas.net/rest/api/3/issue/10000",
    "https://jira-prod-us-0-0.prod.atl-paas.net:8443/rest/api/3/issue/10000",
    "https://user@jira-prod-us-0-0.prod.atl-paas.net/rest/api/3/issue/10000",
    "https://jira-prod-us-0-0.prod.atl-paas.net/rest/api/3/issue/10000?site=other",
    "https://jira-prod-us-0-0.prod.atl-paas.net/rest/api/3/issue/10000#other",
    "https://jira-prod-us-0-0.prod.atl-paas.net/other/10000",
    "jira-prod-us-0-0.prod.atl-paas.net", "not a URL", 42, {},
  ]) {
    const rows = JSON.parse(fixture("search-three").stdout);
    rows[2].self = self;
    const { deps, calls } = scripted(fixture("jira-auth-status"), stubRun({ code: 0, stdout: JSON.stringify(rows), stderr: "" }));
    const walk = await readAcli(cfg(), ctx, 1, deps);
    assert.deepEqual(walk.issues, [], JSON.stringify(self));
    assert.ok(walk.error, JSON.stringify(self));
    assert.equal(walk.advisory, null);
    assert.equal(calls.length, 2);
  }
});

test("preflight and sweep discard results if the post-search site check fails or cannot prove the site", async () => {
  for (const status of [
    fixture("logged-out"), stubRun({ code: 0, stdout: "Authenticated", stderr: "" }),
    stubRun({ code: 0, stdout: "Site: other.atlassian.net", stderr: "" }),
    { ...fixture("jira-auth-status"), outcomeUnknown: true },
  ]) {
    for (const preflight of [false, true]) {
      const { deps, calls } = scripted(fixture("jira-auth-status"), fixture("search-three"), status);
      if (preflight) assert.ok(await acliPreflight(cfg(), ctx, deps));
      else {
        const walk = await readAcli(cfg(), ctx, 1, deps);
        assert.deepEqual(walk.issues, []);
        assert.ok(walk.error);
        assert.equal(walk.advisory, null);
      }
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[2]!.args, ["jira", "auth", "status"]);
    }
  }
});

test("failed queries and malformed output never become empty healthy sweeps", async () => {
  for (const response of [fixture("search-invalid"), fixture("search-self"), stubRun({ code: 0, stdout: "not JSON", stderr: "" }), stubRun({ code: 0, stdout: "{}", stderr: "" })]) {
    const { deps } = scripted(fixture("jira-auth-status"), response);
    const walk = await readAcli(cfg(), ctx, 10, deps);
    assert.deepEqual(walk.issues, []);
    assert.ok(walk.error);
  }
});

test("an abandoned operation starts no subprocess", async () => {
  const { deps, calls } = scripted();
  const walk = await readAcli(cfg(), { ...ctx, signal: AbortSignal.abort() }, 10, deps);
  assert.deepEqual(walk.issues, []);
  assert.match(walk.error!, /abandoned/);
  assert.equal(calls.length, 0);
});

const home = mkdtempSync(join(tmpdir(), "mission-acli-"));
after(() => rmSync(home, { recursive: true, force: true }));
test("production dispatch, linked reads and preflight use only the redirected acli, without a local fallback", async () => {
  const agents = writeFakeAgents(home);
  const old = { ...process.env };
  const fetchBefore = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("REST must not be reached"); };
  try {
    process.env.MISSION_ACLI_BIN = agents.bins.acli;
    process.env.MISSION_JIRA_BIN = agents.bins.jira;
    process.env.MC_E2E_RECORD_DIR = agents.recordDir;
    process.env.JIRA_API_TOKEN = "synthetic-unused-token";
    process.env.JIRA_EMAIL = "operator@example.invalid";
    process.env.MISSION_ACLI_BIN = join(home, "missing-acli");
    assert.match((await jira.preflight!(cfg(), ctx))!, /acli is not installed.*brew install acli/);
    process.env.MISSION_ACLI_BIN = agents.bins.acli;
    writeFileSync(join(agents.recordDir, "fake-acli-state.json"), JSON.stringify({ issues: JSON.parse(fixture("search-one").stdout) }));
    assert.equal(acliBin(), agents.bins.acli);
    assert.equal(await jira.preflight!(cfg(), ctx), null);
    const swept = await jira.sweep(cfg(), ctx);
    assert.equal(swept.items.length, 1);
    const item = swept.items[0]!;
    assert.equal((await jira.readLinked!(cfg(), [{ sourceId: "acli", externalId: item.ref.externalId, url: item.ref.url }], ctx)).items.length, 1);
    writeFileSync(join(agents.recordDir, "fake-acli-state.json"), JSON.stringify({ site: "other.atlassian.net" }));
    assert.equal((await jira.sweep(cfg(), ctx)).items.length, 0);
    assert.equal((await jira.readLinked!(cfg(), [{ sourceId: "acli", externalId: item.ref.externalId, url: item.ref.url }], ctx)).items.length, 0);
    assert.equal(fetches, 0);
    const names = readdirSync(agents.recordDir);
    assert.equal(names.filter((name) => name.startsWith("jira-")).length, 0);
    const records = names.filter((name) => /^acli-\d/.test(name)).map((name) => JSON.parse(readFileSync(join(agents.recordDir, name), "utf8")));
    assert.equal(records.filter((r) => r.argv.join(" ") === "jira auth status").length, 8);
    assert.equal(records.filter((r) => r.argv[2] === "search").length, 3);
  } finally {
    globalThis.fetch = fetchBefore;
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test("production write dispatch stays on fake acli even with a local CLI and REST credential available", async () => {
  const agents = writeFakeAgents(join(home, "writes"));
  const old = { ...process.env };
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("REST must not be reached"); };
  try {
    process.env.MISSION_ACLI_BIN = agents.bins.acli;
    process.env.MISSION_JIRA_BIN = agents.bins.jira;
    process.env.MC_E2E_RECORD_DIR = agents.recordDir;
    process.env.JIRA_API_TOKEN = "synthetic-unused-token";
    process.env.JIRA_EMAIL = "operator@example.invalid";
    assert.equal((await jira.annotate!(cfg({ linkVia: "remote-link" }), notice, ctx)).error, null);
    assert.equal((await jira.resolve!(cfg({ resolveTransition: "Done" }), notice, ctx)).detail, 'moved to "Done"');
    writeFileSync(join(agents.recordDir, "fake-acli-state.json"), JSON.stringify({ comment: "refused", transition: "refused" }));
    assert.ok((await jira.annotate!(cfg(), notice, ctx)).error);
    assert.ok((await jira.resolve!(cfg({ resolveTransition: "Done" }), notice, ctx)).error);
    assert.equal(fetches, 0);
    assert.equal(readdirSync(agents.recordDir).filter((n) => n.startsWith("jira-")).length, 0);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test("an exit-zero fake comment failure is a retryable refusal", async () => {
  const agents = writeFakeAgents(join(home, "comment-json-failure"));
  const old = { ...process.env };
  try {
    process.env.MISSION_ACLI_BIN = agents.bins.acli;
    process.env.MC_E2E_RECORD_DIR = agents.recordDir;
    assert.equal(acliBin(), agents.bins.acli);
    writeFileSync(join(agents.recordDir, "fake-acli-state.json"), JSON.stringify({ comment: "json-failure" }));
    const result = await acliAnnotate(cfg(), notice, ctx);
    assert.equal(result.outcomeUnknown, false);
    assert.equal(result.detail, null);
    assert.match(result.error!, /the comment could not be posted.*Workflow refused \(fake\)/);
    const calls = readdirSync(agents.recordDir).filter((name) => /^acli-\d/.test(name))
      .map((name) => JSON.parse(readFileSync(join(agents.recordDir, name), "utf8")).argv as string[]);
    assert.equal(calls.filter((args) => args.join(" ") === "jira auth status").length, 2);
    assert.equal(calls.filter((args) => args.slice(0, 3).join(" ") === "jira workitem comment").length, 1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
