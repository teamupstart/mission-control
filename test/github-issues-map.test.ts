import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GithubIssuesConfigSchema,
  type GithubIssuesConfig,
  type SweepContext,
} from "../src/shared/task-source.ts";
import {
  candidateFrom,
  externalIdFor,
  ghIssueCreateArgs,
  ghIssueListArgs,
  priorityFor,
  pushResultFrom,
  sweepResultFrom,
} from "../src/server/task-sources/github-issues.ts";
import { stubRun } from "../src/server/util/exec.ts";

// What is at stake: three things a background sweep gives nobody the chance to notice.
//
//  - A filter that matches nothing looks exactly like a repo with no open issues. The
//    `--label` flag is AND where the config promises ANY, so more than one label has to
//    become a `--search` term; and the two assignee filters together select nothing at
//    all, which the schema refuses outright.
//  - `externalId` is the de-duplication key. If it moves between builds, every issue
//    already in the backlog is filed a second time.
//  - A broken `gh` must never read as "no issues".

const cfg = (over: Partial<GithubIssuesConfig> = {}): GithubIssuesConfig =>
  GithubIssuesConfigSchema.parse(over);

const ctx: SweepContext = {
  sourceId: "src-1",
  repoRoot: "/repo",
  signal: new AbortController().signal,
};

/** The value that follows `flag` in an argv, or undefined. */
function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("the base sweep asks only for open issues, and only for the fields we map", () => {
  const args = ghIssueListArgs(cfg());
  assert.ok(args.slice(0, 2).join(" ") === "issue list");
  assert.equal(argAfter(args, "--state"), "open");
  assert.equal(argAfter(args, "--limit"), "50");
  assert.equal(argAfter(args, "--json"), "number,title,body,url,labels,assignees,updatedAt");
  // No filter was configured, so none is passed - the sweep must not narrow itself.
  assert.equal(args.includes("--label"), false);
  assert.equal(args.includes("--search"), false);
  assert.equal(args.includes("--assignee"), false);
});

// One label needs no search syntax, which also means no quoting rules - a label with a
// comma in it survives here where `label:a,b` would split it in half.
test("one label goes through --label", () => {
  const args = ghIssueListArgs(cfg({ labelsAny: ["Type: Bug, maybe"] }));
  assert.equal(argAfter(args, "--label"), "Type: Bug, maybe");
  assert.equal(args.includes("--search"), false);
});

// The one that matters: `--label a --label b` is AND, and the config says ANY. Passing
// both flags would quietly select only issues carrying every label at once.
test("several labels become an OR search, not repeated --label flags", () => {
  const args = ghIssueListArgs(cfg({ labelsAny: ["bug", "good first issue"] }));
  assert.equal(args.includes("--label"), false);
  assert.equal(argAfter(args, "--search"), 'label:bug,"good first issue"');
});

test("assignedToMe and unassignedOnly reach gh by their own routes", () => {
  assert.equal(argAfter(ghIssueListArgs(cfg({ assignedToMe: true })), "--assignee"), "@me");
  // `--assignee` has no "nobody" spelling, so this is a search term.
  assert.equal(argAfter(ghIssueListArgs(cfg({ unassignedOnly: true })), "--search"), "no:assignee");
});

test("a milestone is passed through", () => {
  assert.equal(argAfter(ghIssueListArgs(cfg({ milestone: "v2" })), "--milestone"), "v2");
});

// A filter that silently matches nothing is the worst possible failure for a background
// sweep, so the pair that selects nothing cannot be stored at all.
test("the schema refuses the two assignee filters together", () => {
  const both = GithubIssuesConfigSchema.safeParse({ assignedToMe: true, unassignedOnly: true });
  assert.equal(both.success, false);
  assert.match(JSON.stringify(both), /select nothing together/);
  // Either one alone is fine.
  assert.ok(GithubIssuesConfigSchema.safeParse({ assignedToMe: true }).success);
  assert.ok(GithubIssuesConfigSchema.safeParse({ unassignedOnly: true }).success);
});

// Taken from the URL rather than composed from the configured `repo`, so reconfiguring
// (or clearing) `repo` cannot change the identity of an issue already in the backlog.
test("the external id is owner/repo#number, read off the issue's URL", () => {
  assert.equal(externalIdFor("https://github.com/acme/widgets/issues/42"), "acme/widgets#42");
  assert.equal(
    externalIdFor("https://github.example.com/acme/widgets/issues/7"),
    "acme/widgets#7",
  );
});

// A fallback derived from the issue NUMBER alone would collide across repos and would
// move if the URL shape changed. The URL itself is stable and unique, so it stands in.
test("an unrecognised URL falls back to the URL itself, which is still stable", () => {
  assert.equal(externalIdFor("https://elsewhere.test/thing/9"), "https://elsewhere.test/thing/9");
});

test("the first mapped label the ISSUE carries decides the priority", () => {
  const map = { P0: "blocker", P1: "high" } as const;
  assert.equal(priorityFor(["P1", "P0"], { ...map }), "high", "issue order decides, not map order");
  assert.equal(priorityFor(["chore", "P0"], { ...map }), "blocker");
  // Unset stays unset - the source's default applies later, in ingest.
  assert.equal(priorityFor(["chore"], { ...map }), null);
  // A mapping typed in another case still catches the label.
  assert.equal(priorityFor(["p0"], { ...map }), "blocker");
});

const ISSUE = {
  number: 42,
  title: "Widgets leak on resize",
  body: "Steps: resize the window twice.",
  url: "https://github.com/acme/widgets/issues/42",
  labels: [{ name: "bug" }, { name: "Type: Bug" }],
  assignees: [],
};

// The intent is a BRIEF, not the raw record: the agent's first prompt has to carry the
// issue's actual text and a link, not a number it would have to go and look up.
test("an issue becomes a candidate carrying its text, its link and its identity", () => {
  const c = candidateFrom(ISSUE, cfg(), ctx)!;
  assert.equal(c.title, "Widgets leak on resize");
  assert.deepEqual(c.ref, {
    sourceId: "src-1",
    externalId: "acme/widgets#42",
    url: ISSUE.url,
  });
  assert.equal(c.repoRoot, "/repo");
  assert.match(c.intent, /GitHub issue #42: Widgets leak on resize/);
  assert.match(c.intent, /https:\/\/github\.com\/acme\/widgets\/issues\/42/);
  assert.match(c.intent, /resize the window twice/);
  assert.deepEqual(c.labels, ["bug", "Type: Bug"]);
});

// The distinction that decides whether the source's default priority ever applies. An
// issue with no mapped label has NO OPINION (the key is absent), which ingest fills from
// the source's default; a candidate carrying `priority: null` is saying "deliberately
// unset" and ingest honours that instead. Setting null here made every swept task unset
// however the operator had configured the source - found end to end, not in review.
test("an issue with no mapped label leaves priority OPEN, so the source's default applies", () => {
  const c = candidateFrom(ISSUE, cfg({ priorityFrom: { P0: "blocker" } }), ctx)!;
  assert.equal("priority" in c, false, "a null here would suppress the source's default");
});

test("an issue carrying a mapped label states its priority", () => {
  const c = candidateFrom(ISSUE, cfg({ priorityFrom: { bug: "blocker" } }), ctx)!;
  assert.equal(c.priority, "blocker");
});

test("copyLabels off files the task with none of the issue's tags", () => {
  assert.deepEqual(candidateFrom(ISSUE, cfg({ copyLabels: false }), ctx)!.labels, []);
});

test("an issue with no body still says something rather than nothing", () => {
  const c = candidateFrom({ ...ISSUE, body: "" }, cfg(), ctx)!;
  assert.match(c.intent, /no description/);
});

// A row we cannot link back to, or cannot name, is not a task - and quietly filing one
// would put a card in the backlog nobody can trace to anything.
test("a row with no URL or no title is not a candidate at all", () => {
  assert.equal(candidateFrom({ ...ISSUE, url: undefined }, cfg(), ctx), null);
  assert.equal(candidateFrom({ ...ISSUE, title: "   " }, cfg(), ctx), null);
});

test("an enormous body is truncated, and says so", () => {
  const c = candidateFrom({ ...ISSUE, body: "x".repeat(20_000) }, cfg(), ctx)!;
  assert.ok(c.intent.length < 6000);
  assert.match(c.intent, /issue body truncated/);
});

// The rule the whole feature leans on: a broken `gh` and a quiet repo must not look
// alike. Every failure below has to carry a reason; none may come back as `items: []`
// with `error: null`, which is what "there is no work" means.
test("a non-zero gh exit is an error, never an empty success", () => {
  const r = sweepResultFrom({ stdout: "", stderr: "gh: not authenticated", code: 1 }, cfg(), ctx);
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /gh issue list failed: gh: not authenticated/);
});

test("gh output that is not JSON, or not a list, is an error too", () => {
  assert.match(sweepResultFrom({ stdout: "<html>", stderr: "", code: 0 }, cfg(), ctx).error!, /not JSON/);
  assert.match(
    sweepResultFrom({ stdout: '{"issues":[]}', stderr: "", code: 0 }, cfg(), ctx).error!,
    /unexpected shape/,
  );
});

// The one shape that IS an empty success: gh ran, and the repo genuinely has nothing
// matching. Reporting an error here would make a healthy quiet source look broken.
test("a clean run with no matching issues is an empty SUCCESS", () => {
  const r = sweepResultFrom({ stdout: "[]", stderr: "", code: 0 }, cfg(), ctx);
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null);
});

test("a clean run maps every issue it can name", () => {
  const r = sweepResultFrom(
    { stdout: JSON.stringify([ISSUE, { ...ISSUE, url: undefined }]), stderr: "", code: 0 },
    cfg(),
    ctx,
  );
  assert.equal(r.error, null);
  assert.equal(r.items.length, 1, "the unlinkable row was dropped, the good one kept");
  assert.equal(r.items[0]!.ref.externalId, "acme/widgets#42");
});

// A sweep abandoned by its timeout must not report the partial answer it happened to
// have, and must not report success.
test("an abandoned sweep says so rather than filing what it had", () => {
  const r = sweepResultFrom({ stdout: JSON.stringify([ISSUE]), stderr: "", code: 0 }, cfg(), {
    ...ctx,
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(r.items, []);
  assert.match(r.error!, /abandoned/);
});

// ---- the outward half: a task filed as an issue ----
//
// What is at stake here is different from everything above, and worse. A sweep that
// misreads its subprocess files a bad card into a list somebody deletes. A push that
// misreads its subprocess either creates a duplicate issue in a repo other people are
// watching, or reports success for an issue that does not exist. The three-way reading of
// one `gh issue create` run is the entire defence, so every branch of it is pinned.

test("the created issue carries the task's title and intent, the repo, and every filter label", () => {
  const args = ghIssueCreateArgs(cfg({ repo: "acme/widgets", labelsAny: ["mission", "triage"] }), {
    title: "Widgets leak on resize",
    intent: "Steps: resize the window twice.",
  });
  assert.deepEqual(args, [
    "issue",
    "create",
    "--title",
    "Widgets leak on resize",
    "--body",
    "Steps: resize the window twice.",
    "--repo",
    "acme/widgets",
    // Repeated `--label` is right here where it was wrong for the sweep: the sweep needed
    // ANY of them (and `--label` is AND), a created issue simply carries all of them - so
    // the issue matches the very filter this source sweeps.
    "--label",
    "mission",
    "--label",
    "triage",
  ]);
});

test("an unconfigured repo and no labels pass no flags at all", () => {
  const args = ghIssueCreateArgs(cfg(), { title: "t", intent: "i" });
  assert.deepEqual(args, ["issue", "create", "--title", "t", "--body", "i"]);
});

// An argv array handed to `execFile` - no shell parses it - so text that would be a
// command injection anywhere else is just a title.
test("shell metacharacters in a title or body are arguments, not syntax", () => {
  const nasty = "$(rm -rf /) `whoami` && echo";
  const args = ghIssueCreateArgs(cfg(), { title: nasty, intent: nasty });
  assert.equal(args[3], nasty);
  assert.equal(args[5], nasty);
});

test("a created issue is identified by the URL gh printed, the same id a sweep would give it", () => {
  const r = pushResultFrom(
    stubRun({ stdout: "https://github.com/acme/widgets/issues/42\n", stderr: "", code: 0 }),
    ctx,
  );
  assert.equal(r.error, null);
  assert.equal(r.outcomeUnknown, false);
  assert.deepEqual(r.ref, {
    sourceId: "src-1",
    externalId: "acme/widgets#42",
    url: "https://github.com/acme/widgets/issues/42",
  });
  // The point of reusing `externalIdFor`: the id an issue gets on the way out is the id
  // it gets on the way back in, so a pushed issue is never swept in as a second task.
  assert.equal(r.ref!.externalId, externalIdFor(r.ref!.url!));
});

// `gh` prints progress above the URL, so the URL is the LAST such line rather than the
// first - taking the first would make a chatty release turn a progress line into the id.
test("progress chatter above the URL is not mistaken for it", () => {
  const r = pushResultFrom(
    stubRun({
      stdout: "Creating issue in acme/widgets\nhttps://github.com/acme/widgets/issues/9\n",
      stderr: "",
      code: 0,
    }),
    ctx,
  );
  assert.equal(r.ref!.url, "https://github.com/acme/widgets/issues/9");
});

// gh RAN and refused. Nothing was created, so this is the one failure a caller may retry
// from - and a missing repo label is the failure that will actually happen, so the
// operator has to be able to read which label it was.
test("a non-zero gh exit is a refusal that names itself, and is retry-safe", () => {
  const r = pushResultFrom(
    stubRun({ stdout: "", stderr: "could not add label: 'triage' not found\n", code: 1 }),
    ctx,
  );
  assert.equal(r.ref, null);
  assert.match(r.error!, /gh issue create failed: could not add label: 'triage' not found/);
  assert.equal(r.outcomeUnknown, false);
});

// The load-bearing one. The child never reported its own exit - our timeout, a signal,
// the OOM killer - so GitHub may well have taken the request first. Reading this as an
// ordinary refusal is exactly how a retry files the same issue twice.
test("a gh that never reported back is an UNKNOWN outcome, not a refusal", () => {
  const r = pushResultFrom(
    { stdout: "", stderr: "timed out", code: null, outcomeUnknown: true, overflowed: false },
    ctx,
  );
  assert.equal(r.ref, null);
  assert.equal(r.outcomeUnknown, true);
  assert.match(r.error!, /may exist/);
  assert.match(r.error!, /check GitHub before retrying/);
});

// The awkward shape, and the one a naive reading gets backwards: gh says it worked, so
// the issue almost certainly EXISTS - we simply cannot name it. That is worse than a
// failure, not better, so it may not be success and may not be a retryable refusal.
test("exit 0 with no URL is an unknown outcome - the issue exists and cannot be identified", () => {
  const r = pushResultFrom(stubRun({ stdout: "done\n", stderr: "", code: 0 }), ctx);
  assert.equal(r.ref, null);
  assert.equal(r.outcomeUnknown, true);
  assert.match(r.error!, /check GitHub before retrying/);
});

// `outcomeUnknown` is read FIRST, before the exit code, because a killed child's exit
// code is whatever Node made up for it. A rule order that checked `code` first would
// classify every timeout as a retry-safe refusal.
test("an unknown outcome outranks whatever exit code came with it", () => {
  for (const code of [0, 1, null]) {
    const r = pushResultFrom(
      {
        stdout: "https://github.com/acme/widgets/issues/1",
        stderr: "",
        code,
        outcomeUnknown: true,
        overflowed: false,
      },
      ctx,
    );
    assert.equal(r.outcomeUnknown, true, `code ${code} was allowed to claim a known outcome`);
    assert.equal(r.ref, null);
  }
});
