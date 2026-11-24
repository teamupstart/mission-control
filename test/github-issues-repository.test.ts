import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  GithubIssuesConfigSchema,
  type GithubIssuesConfig,
  type TaskSourceInstance,
  type WritebackNotice,
} from "../src/shared/task-source.ts";
import { githubIssues, writebackConfig } from "../src/server/task-sources/github-issues.ts";
import { sourceRepositories } from "../src/server/task-sources/index.ts";
import { GRAPHQL_SSO_STDERR, REST_SSO_STDERR, SSO_AUTHORIZE_URL } from "./helpers/github-sso-stderr.ts";

// Which repository a GitHub issues source's `gh` calls name. A blank Repository used to leave
// the choice to `gh`, which prefers a remote called `upstream`: on a fork, the parent, and an
// organization enforcing SAML SSO refuses it ("Resource protected by organization SAML
// enforcement"). These run each verb in a real fork-shaped checkout against a fake `gh` that
// records its argv, so what is pinned is the argv the daemon actually spawns.

const dir = mkdtempSync(join(tmpdir(), "mission-gh-issues-repo-"));
const calls = join(dir, "calls.jsonl");
/** While this file exists, every `gh issue` call prints its contents to stderr and fails. */
const refusal = join(dir, "refusal.txt");
const fork = join(dir, "fork");
const gitlab = join(dir, "gitlab");
const previousGh = process.env.MISSION_GH_BIN;

function checkout(path: string, remotes: Record<string, string>): void {
  mkdirSync(path);
  execFileSync("git", ["init", "-q", path]);
  for (const [name, url] of Object.entries(remotes)) execFileSync("git", ["-C", path, "remote", "add", name, url]);
}

before(() => {
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "issue" && fs.existsSync(${JSON.stringify(refusal)})) {
  process.stderr.write(fs.readFileSync(${JSON.stringify(refusal)}, "utf8"));
  process.exit(1);
}
if (argv[0] === "issue" && argv[1] === "list") process.stdout.write("[]");
if (argv[0] === "issue" && argv[1] === "create") {
  process.stdout.write("https://github.com/" + argv[argv.indexOf("--repo") + 1] + "/issues/5\\n");
}
`,
    { mode: 0o755 },
  );
  process.env.MISSION_GH_BIN = gh;
  checkout(fork, {
    origin: "git@github.com:octo-fork/mission-control.git",
    upstream: "https://github.com/teamupstart/mission-control.git",
  });
  checkout(gitlab, { origin: "git@gitlab.com:acme/widgets.git" });
});

after(() => {
  if (previousGh === undefined) delete process.env.MISSION_GH_BIN;
  else process.env.MISSION_GH_BIN = previousGh;
  rmSync(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<GithubIssuesConfig> = {}): GithubIssuesConfig => GithubIssuesConfigSchema.parse(over);
const sweepCtx = (repoRoot: string) => ({ sourceId: "s1", repoRoot, signal: new AbortController().signal });

/** The argv of every `gh` call since the last read, and clear them. */
function takeCalls(): string[][] {
  let text = "";
  try {
    text = readFileSync(calls, "utf8");
  } catch {
    return [];
  }
  rmSync(calls);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

const repoOf = (argv: string[]): string | undefined => argv[argv.indexOf("--repo") + 1];

test("a blank Repository sweeps and preflights origin, never gh's upstream choice", async () => {
  takeCalls();
  assert.equal((await githubIssues.sweep(cfg(), sweepCtx(fork))).error, null);
  assert.equal(await githubIssues.preflight(cfg(), sweepCtx(fork)), null);
  const lists = takeCalls().filter((argv) => argv[0] === "issue" && argv[1] === "list");
  assert.equal(lists.length, 2, "one list from the sweep and one from the preflight");
  for (const argv of lists) assert.equal(repoOf(argv), "octo-fork/mission-control");
});

test("a configured Repository is named as written", async () => {
  takeCalls();
  await githubIssues.sweep(cfg({ repo: "acme/chosen" }), sweepCtx(fork));
  assert.deepEqual(takeCalls().map(repoOf), ["acme/chosen"]);
});

test("Create GitHub issue files on the resolved repository and reads back that URL", async () => {
  takeCalls();
  const result = await githubIssues.push!(cfg(), { title: "t", intent: "i" }, sweepCtx(fork));
  assert.equal(result.error, null);
  assert.equal(result.ref?.externalId, "octo-fork/mission-control#5");
  assert.deepEqual(takeCalls().map(repoOf), ["octo-fork/mission-control"]);
});

// A checkout with no GitHub remote has nothing to resolve, and leaving the choice to gh is
// exactly what this refuses. The resolver's error is the verb's error, and gh never runs.
test("a resolver error becomes the sweep's, the preflight's and the create's error", async () => {
  takeCalls();
  const sweep = await githubIssues.sweep(cfg(), sweepCtx(gitlab));
  assert.deepEqual(sweep.items, []);
  assert.match(sweep.error!, /No GitHub repository for/);
  const preflight = await githubIssues.preflight(cfg(), sweepCtx(gitlab));
  assert.match(preflight!, /No GitHub repository for/);
  const push = await githubIssues.push!(cfg(), { title: "t", intent: "i" }, sweepCtx(gitlab));
  assert.equal(push.ref, null);
  assert.equal(push.outcomeUnknown, false, "no gh ran, so nothing was published");
  assert.match(push.error!, /No GitHub repository for/);
  assert.deepEqual(
    takeCalls().filter((argv) => argv[0] === "issue"),
    [],
    "no issue call ran without a repository",
  );
});

const notice = (over: Partial<WritebackNotice> = {}): WritebackNotice => ({
  signal: "task-completed",
  action: "annotate",
  externalId: "7",
  externalUrl: null,
  taskTitle: "Fix it",
  prUrl: null,
  repoRoot: fork,
  outcome: null,
  observedAt: 0,
  ...over,
});

test("the write-back's last fallback resolves a blank Repository through the checkout", async () => {
  const ready = await writebackConfig(cfg(), notice(), fork);
  assert.deepEqual(ready.ok && ready.cfg.repo, "octo-fork/mission-control");

  takeCalls();
  const result = await githubIssues.annotate!(cfg(), notice(), { ...sweepCtx(fork) });
  assert.equal(result.error, null);
  const [comment] = takeCalls();
  assert.deepEqual(comment!.slice(0, 5), ["issue", "comment", "7", "--repo", "octo-fork/mission-control"]);
});

test("a write-back whose item names its repository never needs the resolver", async () => {
  // The gitlab checkout cannot resolve, so only a notice that skips the fallback succeeds.
  for (const named of [
    notice({ externalId: "acme/demo#7" }),
    notice({ externalUrl: "https://github.com/acme/demo/issues/7" }),
  ]) {
    const ready = await writebackConfig(cfg(), named, gitlab);
    assert.equal(ready.ok, true);
  }
  const failed = await githubIssues.resolve!(cfg(), notice(), { ...sweepCtx(gitlab) });
  assert.match(failed.error!, /No GitHub repository for/);
  assert.equal(failed.outcomeUnknown, false);
});

test("the editor's hint resolves blank Repositories and skips configured ones", async () => {
  const base: Omit<TaskSourceInstance, "id" | "kind" | "repoRoot" | "config"> = {
    enabled: false,
    label: "",
    intervalMs: 900_000,
    keepUpdated: false,
    maxPerSweep: 25,
    defaults: { kind: "ship", agent: null, priority: null, labels: [], enabled: false },
    writeback: { onPrOpened: false, onCompleted: false, resolve: false },
  };
  const hints = await sourceRepositories([
    { ...base, id: "blank", kind: "github-issues", repoRoot: fork, config: {} },
    { ...base, id: "named", kind: "github-issues", repoRoot: fork, config: { repo: "acme/chosen" } },
    { ...base, id: "broken", kind: "github-issues", repoRoot: gitlab, config: {} },
    { ...base, id: "jira", kind: "jira", repoRoot: fork, config: {} },
  ]);
  assert.deepEqual(hints.map((h) => h.sourceId), ["blank", "broken"]);
  assert.deepEqual(hints[0]!.resolution, { ok: true, repo: "octo-fork/mission-control", source: "origin" });
  assert.equal(hints[1]!.resolution.ok, false);

  // A pin on another remote is the operator's choice, and the hint says so.
  execFileSync("git", ["-C", fork, "config", "remote.upstream.gh-resolved", "base"]);
  try {
    const [pinned] = await sourceRepositories([{ ...base, id: "blank", kind: "github-issues", repoRoot: fork, config: {} }]);
    assert.deepEqual(pinned!.resolution, { ok: true, repo: "teamupstart/mission-control", source: "gh-default" });
  } finally {
    execFileSync("git", ["-C", fork, "config", "--unset", "remote.upstream.gh-resolved"]);
  }
});

// ---- a SAML SSO refusal, on every surface that keeps gh's first line ----

const SSO_REMEDY = "To use your fork instead, set Repository on this source or pin `gh repo set-default`.";

/** Run `body` with every `gh issue` call refused by SAML SSO, printing `stderr`. */
async function refusedBySso(stderr: string, body: () => Promise<void>): Promise<void> {
  writeFileSync(refusal, stderr);
  try {
    await body();
  } finally {
    rmSync(refusal, { force: true });
  }
}

/**
 * The classified sentence for `target`, which the raw first line never carried. `remedy` is
 * false where the item's own id or URL chose the repository: neither Repository nor the pin
 * moves that call, so only authorizing is offered.
 */
function assertClassified(message: string | null | undefined, target: string, remedy = true): void {
  assert.ok(message, "the failure carried no message");
  assert.ok(
    message.includes(`GitHub refused ${target}: the teamupstart organization requires SAML SSO`),
    message,
  );
  assert.ok(message.includes(`Authorize: ${SSO_AUTHORIZE_URL}.`), message);
  assert.equal(message.includes(SSO_REMEDY), remedy, message);
  if (!remedy) assert.ok(message.endsWith(`Authorize: ${SSO_AUTHORIZE_URL}.`), message);
  assert.equal(message.includes("GraphQL:"), false, "the raw GraphQL line leaked through");
}

// The fixture's own repository when nothing is pinned, and the pin named as the cause when a
// gh default on `upstream` sends the call to the parent: the case that actually happens.
test("sweep, preflight, create and the write-back fallback classify the refusal", async () => {
  const pinnedNote = "teamupstart/mission-control (this checkout's gh default pin, not origin)";
  for (const [pin, target] of [
    [null, "octo-fork/mission-control"],
    ["upstream", pinnedNote],
  ] as const) {
    if (pin) execFileSync("git", ["-C", fork, "config", `remote.${pin}.gh-resolved`, "base"]);
    try {
      await refusedBySso(GRAPHQL_SSO_STDERR, async () => {
        const sweep = await githubIssues.sweep(cfg(), sweepCtx(fork));
        assert.deepEqual(sweep.items, []);
        assert.match(sweep.error!, /^gh issue list failed: GitHub refused /);
        assertClassified(sweep.error, target);
        const preflight = await githubIssues.preflight(cfg(), sweepCtx(fork));
        assert.match(preflight!, /^gh cannot list issues here - GitHub refused /);
        assertClassified(preflight, target);
        const push = await githubIssues.push!(cfg(), { title: "t", intent: "i" }, sweepCtx(fork));
        assert.equal(push.outcomeUnknown, false, "a refusal published nothing");
        assert.match(push.error!, /^gh issue create failed: GitHub refused /);
        assertClassified(push.error, target);
        const writeback = await githubIssues.annotate!(cfg(), notice(), sweepCtx(fork));
        assert.match(writeback.error!, /^gh refused: GitHub refused /);
        assertClassified(writeback.error, target);
      });
    } finally {
      if (pin) execFileSync("git", ["-C", fork, "config", "--unset", `remote.${pin}.gh-resolved`]);
    }
  }
});

// A configured Repository is the operator's to change, so it keeps the remedy, on the sweep
// and on a write-back whose item names no repository of its own. Either way no pin is named.
test("a configured Repository is named as written and keeps the remedy", async () => {
  const upstream = cfg({ repo: "teamupstart/mission-control" });
  await refusedBySso(REST_SSO_STDERR, async () => {
    const sweep = await githubIssues.sweep(upstream, sweepCtx(fork));
    assertClassified(sweep.error, "teamupstart/mission-control");
    const comment = await githubIssues.annotate!(upstream, notice(), sweepCtx(fork));
    assertClassified(comment.error, "teamupstart/mission-control");
  });
});

// The item's own `owner/repo#n` id or URL outranks Repository and the pin, so offering either
// as the fix would send the operator into the same refusal on the next retry.
test("an item's own repository is named as written, with only authorizing offered", async () => {
  await refusedBySso(REST_SSO_STDERR, async () => {
    // A configured Repository and a pin elsewhere change nothing: the item's id wins.
    const comment = await githubIssues.annotate!(
      cfg({ repo: "octo-fork/mission-control" }),
      notice({ externalId: "teamupstart/mission-control#7" }),
      sweepCtx(fork),
    );
    assertClassified(comment.error, "teamupstart/mission-control", false);
    const close = await githubIssues.resolve!(
      cfg(),
      notice({ externalId: "x", externalUrl: "https://github.com/teamupstart/mission-control/issues/7" }),
      sweepCtx(fork),
    );
    assertClassified(close.error, "teamupstart/mission-control", false);
    const linked = await githubIssues.readLinked!(
      cfg(),
      [{ sourceId: "s1", externalId: "teamupstart/mission-control#3", url: "https://github.com/teamupstart/mission-control/issues/3" }],
      sweepCtx(fork),
    );
    assertClassified(linked.itemErrors?.["teamupstart/mission-control#3"], "teamupstart/mission-control", false);
  });
});

// Anything that is not an SSO refusal keeps exactly the wording it had.
test("a failure that is not an SSO refusal keeps its first line", async () => {
  await refusedBySso("HTTP 404: Not Found (https://api.github.com/graphql)\nsecond line\n", async () => {
    const sweep = await githubIssues.sweep(cfg(), sweepCtx(fork));
    assert.equal(sweep.error, "gh issue list failed: HTTP 404: Not Found (https://api.github.com/graphql)");
    const linked = await githubIssues.readLinked!(
      cfg(),
      [{ sourceId: "s1", externalId: "acme/demo#3", url: "https://github.com/acme/demo/issues/3" }],
      sweepCtx(fork),
    );
    assert.equal(
      linked.itemErrors?.["acme/demo#3"],
      "The linked GitHub issue could not be read. Check access and authentication, then sweep again.",
    );
  });
});
