// acli uses its own OAuth site. A profile switch must never file another site's issues.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraConfigSchema } from "../src/shared/task-source.ts";
import type { JiraConfig, SweepContext } from "../src/shared/task-source.ts";
import { acliBin } from "../src/server/config.ts";
import {
  acliActiveSite, acliFailure, acliFault, acliPreflight, acliSearchArgs, acliSiteGate,
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
