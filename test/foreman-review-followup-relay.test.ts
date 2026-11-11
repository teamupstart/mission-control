import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForemanConfig, InspectorConfig, InspectorFindingsResponse } from "../src/shared/protocol.ts";
import type { InspectorComment, InspectorInspection, InspectorSummary, Session } from "../src/shared/types.ts";
import { WORKFLOW_RUN_STATUSES } from "../src/shared/workflow.ts";
import { mkInspection } from "./helpers/inspection-fixture.ts";

// What is at stake: the worker half of the findings relay, driven through the real pass. The
// decision core says a nudge includes findings; `runReviewFollowup` reads their text through
// the daemon and types it. Two things can go wrong in that read, and both are pinned here:
//
//  - it fails, and a round stamped anyway would never be relayed, so the session would never
//    hear about a finding that exists only in Mission Control;
//  - it takes time, and anything the pass observed before it may be stale after it. The
//    session can start working, need a human or gain a workflow, and the Inspector can finish
//    a round. Gates decided on the pre-read snapshot would type across all of that.

// Isolate state before the worker's imports can resolve a home.
const home = mkdtempSync(join(tmpdir(), "mission-foreman-review-relay-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { runReviewFollowup } = await import("../src/server/foreman/worker.ts");
const { ForemanClient } = await import("../src/server/foreman/client.ts");
const { InjectError } = await import("../src/server/foreman/queue-apply.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

type Client = InstanceType<typeof ForemanClient>;

const REPO = "/work/alpha";
const PR_URL = "https://github.com/owner/repo/pull/7";
const KEY = "owner/repo#7";
const LEADER = () => true;
const ADOPTED_READ = ["openInspections", "inspectorConfig"];

const CFG = {
  enabled: true,
  mode: "live",
  repoAllowlist: [REPO],
  trackReviewFeedback: true,
  trackCiFailures: true,
} as ForemanConfig;

function summary(over: Partial<InspectorSummary> = {}): InspectorSummary {
  return {
    prKey: KEY,
    url: PR_URL,
    mode: "dry-run",
    open: 1,
    postedOpen: 0,
    round: 3,
    lastReviewedAt: Date.now() - 60_000,
    failed: false,
    ...over,
  };
}

/** A draft the Inspector wrote in dry run: on no pull request, so only the relay carries it. */
function draft(over: Partial<InspectorComment> = {}): InspectorComment {
  return {
    id: "c1",
    prKey: KEY,
    fingerprint: "fp-draft",
    path: "src/a.ts",
    line: 12,
    title: "Null check missing",
    body: "The handler dereferences `user` before checking it.",
    severity: "major",
    round: 3,
    status: "drafted",
    replies: 0,
    answeredCommentId: null,
    postedAt: null,
    githubUrl: null,
    legacyPosted: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Parked on an open PR whose Inspector holds one dry-run draft: the case the relay exists for. */
function parked(id: string, over: Partial<Session> = {}): Session {
  return mkSession({
    id,
    name: id,
    agentSessionId: `agent-${id}`,
    state: "idle",
    cwd: REPO,
    repoRoot: REPO,
    lastActivity: Date.now() - 60_000,
    prUrl: PR_URL,
    prNumber: 7,
    prState: "open",
    inspector: summary(),
    ...over,
  });
}

/** The route's answer, which names the Inspector round it read. */
function response(findings: InspectorComment[], round = 3): InspectorFindingsResponse {
  return { pr: { round } as InspectorFindingsResponse["pr"], findings };
}

/**
 * A daemon whose answers can change once the findings have been read, which is the window
 * the pass has to survive. `calls` records the order the worker asked in.
 */
function fakeDaemon(opts: {
  sessions: (afterRead: boolean) => Session[];
  findings: () => Promise<InspectorFindingsResponse>;
  workflowRuns?: (afterRead: boolean) => Array<{ status: string; phase?: string; round?: number; maxRepairRounds?: number }>;
  inject?: () => Promise<void>;
  /** The config the freshness recheck reads, when it must differ from the pass's. */
  config?: ForemanConfig;
  codeRabbitAutoResolve?: boolean;
  /** The Inspector's open adopted rows. None unless a case adopts one. */
  openInspections?: (afterRead: boolean) => Promise<InspectorInspection[]>;
}) {
  let afterRead = false;
  const calls: string[] = [];
  const injected: Array<{ id: string; text: string; codeRabbit?: unknown }> = [];
  const client = {
    sessions: async () => {
      calls.push("sessions");
      return opts.sessions(afterRead);
    },
    getConfig: async () => opts.config ?? CFG,
    // Upstream's CodeRabbit follow-up reads the Shipping config each pass; off unless a case turns it on.
    shippingConfig: async () => ({ codeRabbitAutoResolve: opts.codeRabbitAutoResolve ?? false }),
    workflowRuns: async () => {
      calls.push("workflowRuns");
      return opts.workflowRuns?.(afterRead) ?? [];
    },
    openInspections: async () => {
      calls.push("openInspections");
      return (await opts.openInspections?.(afterRead)) ?? [];
    },
    inspectorConfig: async () => {
      calls.push("inspectorConfig");
      return { mode: "dry-run", enabled: true } as InspectorConfig;
    },
    inspectorFindings: async (prKey: string) => {
      calls.push(`findings:${prKey}`);
      try {
        return await opts.findings();
      } finally {
        afterRead = true;
      }
    },
    inject: async (id: string, text: string, codeRabbit?: unknown) => {
      calls.push("inject");
      injected.push({ id, text, ...(codeRabbit ? { codeRabbit } : {}) });
      await (opts.inject ?? (async () => {}))();
    },
  } as unknown as Client;
  return { client, calls, injected };
}

test("a dry-run draft is read through the daemon, then the fleet is re-read, then it is typed", async () => {
  const fake = fakeDaemon({ sessions: () => [parked("draft")], findings: async () => response([draft()]) });
  const claimed = await runReviewFollowup(fake.client, CFG, LEADER);

  assert.deepEqual([...claimed], ["draft"]);
  // The read comes before the freshness recheck, so nothing but the inject follows the recheck.
  assert.deepEqual(fake.calls, [
    "sessions",
    ...ADOPTED_READ,
    "workflowRuns",
    `findings:${KEY}`,
    "sessions",
    ...ADOPTED_READ,
    "workflowRuns",
    "inject",
  ]);
  const { id, text } = fake.injected[0]!;
  assert.equal(id, "draft");
  assert.match(text, /^PR #7 needs follow-through: GitHub Inspector has 1 unresolved finding on it \(0 posted on GitHub, 1 not posted\)\./);
  assert.match(text, /## MAJOR - Null check missing/);
  assert.match(text, /Not posted on GitHub\. This message is the only copy\./);
  assert.match(text, /The handler dereferences `user` before checking it\./);
  assert.doesNotMatch(text, /gh pr view/);

  // The round was stamped: the same round is not relayed again.
  const again = fakeDaemon({ sessions: () => [parked("draft")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(again.client, CFG, LEADER)).size, 0);
  assert.deepEqual(again.injected, []);
});

test("a session that starts working during the read is not typed into, and the round stays unrelayed", async () => {
  let working = true;
  const fake = fakeDaemon({
    sessions: (afterRead) => [parked("busy", afterRead && working ? { state: "working", lastActivity: Date.now() } : {})],
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 0);
  assert.deepEqual(fake.injected, [], "the post-read snapshot says working");

  // It parks again: the round was never stamped, so it is relayed now.
  working = false;
  const later = fakeDaemon({ sessions: () => [parked("busy")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(later.client, CFG, LEADER)).size, 1);
  assert.equal(later.injected.length, 1);
});

test("a session that comes to need a human, or gains a workflow, during the read is left alone", async () => {
  const needsYou = fakeDaemon({
    sessions: (afterRead) => [parked("asks", afterRead ? { state: "awaiting_input" } : {})],
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(needsYou.client, CFG, LEADER)).size, 0);
  assert.deepEqual(needsYou.injected, []);

  const active = WORKFLOW_RUN_STATUSES.find((s) => !["completed", "cancelled", "failed"].includes(s));
  assert.ok(active);
  const owned = fakeDaemon({
    sessions: () => [parked("owned")],
    workflowRuns: (afterRead) => (afterRead ? [{ status: active }] : []),
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(owned.client, CFG, LEADER)).size, 0);
  assert.deepEqual(owned.injected, []);
});

test("a session held only by a spent blocked run gets its findings, with no CodeRabbit claim", async () => {
  const codeRabbit = {
    status: "complete" as const,
    observationId: "obs-1",
    headSha: "head",
    observedAt: Date.now(),
    freshUntil: Date.now() + 600_000,
    unresolved: 1,
    error: null,
    threads: [],
    pending: 1,
    delivery: "Waiting for an eligible session",
  };
  const withCodeRabbit = (id: string) => parked(id, { inspector: summary({ codeRabbit }) });
  const spent = [{ status: "blocked", phase: "round_limit", round: 4, maxRepairRounds: 3 }];

  const released = fakeDaemon({
    sessions: () => [withCodeRabbit("spent")],
    workflowRuns: () => spent,
    findings: async () => response([draft()]),
    codeRabbitAutoResolve: true,
  });
  assert.equal((await runReviewFollowup(released.client, CFG, LEADER)).size, 1);
  assert.equal(released.injected.length, 1);
  assert.match(released.injected[0]!.text, /The handler dereferences `user` before checking it\./);
  assert.equal(released.injected[0]!.codeRabbit, undefined, "the route would refuse a claim while the run is open");

  // The same session with no run carries the claim, so the case above is CodeRabbit turned off.
  const unbound = fakeDaemon({
    sessions: () => [withCodeRabbit("unbound")],
    findings: async () => response([draft()]),
    codeRabbitAutoResolve: true,
  });
  assert.equal((await runReviewFollowup(unbound.client, CFG, LEADER)).size, 1);
  assert.deepEqual(unbound.injected[0]!.codeRabbit, { prKey: KEY, observationId: "obs-1" });
});

test("a released run that resumes during the read is not typed across", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("resumed")],
    workflowRuns: (afterRead) => [afterRead
      ? { status: "waiting_for_new_head", phase: "inspector_findings", round: 4, maxRepairRounds: 6 }
      : { status: "blocked", phase: "round_limit", round: 4, maxRepairRounds: 3 }],
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 0);
  assert.deepEqual(fake.injected, []);
  assert.deepEqual(fake.calls, [
    "sessions", ...ADOPTED_READ, "workflowRuns", `findings:${KEY}`, "sessions", ...ADOPTED_READ, "workflowRuns",
  ]);
});

test("an Inspector round that finishes during the read is held, then relayed exactly once", async () => {
  // The snapshot still says round 3; the route already answers for round 4. Typing would
  // stamp round 3 with round 4's findings, and the next pass would relay round 4 again.
  const raced = fakeDaemon({
    sessions: () => [parked("race")],
    findings: async () => response([draft({ round: 4 })], 4),
  });
  assert.equal((await runReviewFollowup(raced.client, CFG, LEADER)).size, 0);
  assert.deepEqual(raced.injected, []);

  const caughtUp = () => [parked("race", { inspector: summary({ round: 4 }) })];
  const next = fakeDaemon({ sessions: caughtUp, findings: async () => response([draft({ round: 4 })], 4) });
  assert.equal((await runReviewFollowup(next.client, CFG, LEADER)).size, 1);
  assert.equal(next.injected.length, 1);

  const after = fakeDaemon({ sessions: caughtUp, findings: async () => response([draft({ round: 4 })], 4) });
  assert.equal((await runReviewFollowup(after.client, CFG, LEADER)).size, 0);
  assert.deepEqual(after.injected, [], "round 4 is relayed once");
});

test("a failed read is held: nothing typed, no stamp, and the next pass relays", async () => {
  const failed = fakeDaemon({
    sessions: () => [parked("flaky")],
    findings: async () => Promise.reject(new Error("GET /api/inspector/findings -> 503")),
  });
  assert.equal((await runReviewFollowup(failed.client, CFG, LEADER)).size, 0);
  assert.deepEqual(failed.injected, []);
  assert.deepEqual(failed.calls, ["sessions", ...ADOPTED_READ, "workflowRuns", `findings:${KEY}`], "no recheck, no inject");

  // A shape the client's schema refused throws the same way.
  const unparsed = fakeDaemon({
    sessions: () => [parked("flaky")],
    findings: async () => Promise.reject(new Error("Expected array, received null")),
  });
  assert.equal((await runReviewFollowup(unparsed.client, CFG, LEADER)).size, 0);
  assert.deepEqual(unparsed.injected, []);

  const retry = fakeDaemon({ sessions: () => [parked("flaky")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(retry.client, CFG, LEADER)).size, 1);
  assert.equal(retry.injected.length, 1, "round 3 was never recorded as relayed");
});

test("findings resolved before the read: nothing else open, so the pass skips without stamping", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("resolved")],
    findings: async () => response([draft({ status: "resolved" })]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 0);
  assert.deepEqual(fake.injected, []);
});

test("findings resolved before the read, CI still red: the CI half goes out alone", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("red", { prChecks: "failing" })],
    findings: async () => response([]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 1);
  const text = fake.injected[0]!.text;
  assert.match(text, /^PR #7 needs follow-through: its CI checks are failing\./);
  assert.doesNotMatch(text, /unresolved finding/);
});

test("a nudge without findings types with no read", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("ci", { inspector: summary({ open: 0 }), prChecks: "failing" })],
    findings: async () => assert.fail("no findings to read"),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 1);
  assert.ok(!fake.calls.some((call) => call.startsWith("findings:")));
});

test("a delivery the daemon refused frees the pane and leaves the round to retry", async () => {
  const refused = fakeDaemon({
    sessions: () => [parked("gone")],
    findings: async () => response([draft()]),
    inject: async () => Promise.reject(new InjectError("pane gone", false)),
  });
  assert.equal((await runReviewFollowup(refused.client, CFG, LEADER)).size, 0);

  const retry = fakeDaemon({ sessions: () => [parked("gone")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(retry.client, CFG, LEADER)).size, 1);
  assert.equal(retry.injected.length, 1);
});

test("a worker that lost the lease types nothing", async () => {
  const fake = fakeDaemon({ sessions: () => [parked("follower")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(fake.client, CFG, () => false)).size, 0);
  assert.deepEqual(fake.injected, []);
});

// ---- a PR the Inspector adopted that the session card no longer carries ----

const BRANCH = "feat/adopted";

/** The live example: the card shows no PR while the checkout sits on the adopted PR's branch. */
function detached(id: string): Session {
  return parked(id, { prUrl: null, prNumber: null, prState: null, inspector: null, gitBranch: BRANCH });
}

function adoptedBy(id: string, over: Partial<InspectorInspection> = {}): InspectorInspection {
  return mkInspection({ key: KEY, url: PR_URL, sessionId: id, repoRoot: REPO, headRefName: BRANCH, ...over });
}

const unreadable = async () => Promise.reject(new Error("GET /api/inspector/prs?state=open -> 503"));

test("an adopted PR the card does not carry is relayed with its findings' text", async () => {
  const fake = fakeDaemon({
    sessions: () => [detached("adopted")],
    openInspections: async () => [adoptedBy("adopted")],
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 1);
  assert.deepEqual(fake.calls, [
    "sessions", ...ADOPTED_READ, "workflowRuns", `findings:${KEY}`,
    "sessions", ...ADOPTED_READ, "workflowRuns", "inject",
  ]);
  const { id, text } = fake.injected[0]!;
  assert.equal(id, "adopted");
  assert.match(text, /^PR #7 needs follow-through: GitHub Inspector has 1 unresolved finding on it/);
  assert.match(text, /The handler dereferences `user` before checking it\./);
});

test("a failed adoption read still relays the card's PR", async () => {
  const fake = fakeDaemon({
    sessions: () => [parked("card-only")],
    openInspections: unreadable,
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 1);
  assert.equal(fake.injected.length, 1);
});

test("a failed adoption read keeps the adopted PR's mark, so its round is not relayed twice", async () => {
  const OTHER = "owner/repo#9";
  for (const [id, session] of [
    ["flaky-detached", detached("flaky-detached")],
    ["flaky-alongside", parked("flaky-alongside", { gitBranch: BRANCH })],
  ] as const) {
    const sessions = () => [session];
    const readable = async () => [
      adoptedBy(id, { key: OTHER, url: "https://github.com/owner/repo/pull/9", number: 9 }),
    ];
    const findings = async () => response([draft()]);
    let relayedTo: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const relayed = fakeDaemon({ sessions, openInspections: readable, findings });
      await runReviewFollowup(relayed.client, CFG, LEADER);
      relayedTo = [...relayedTo, ...relayed.calls.filter((c) => c.startsWith("findings:"))];
    }
    assert.ok(relayedTo.includes(`findings:${OTHER}`), `${id}: the adopted PR was relayed`);

    const failed = fakeDaemon({ sessions, openInspections: unreadable, findings });
    await runReviewFollowup(failed.client, CFG, LEADER);
    assert.deepEqual(failed.injected, [], `${id}: nothing new on the card's PR`);

    const recovered = fakeDaemon({ sessions, openInspections: readable, findings });
    assert.equal((await runReviewFollowup(recovered.client, CFG, LEADER)).size, 0);
    assert.deepEqual(recovered.injected, [], `${id}: round 3 was already relayed`);
  }
});

test("an adopted PR on a session an open run holds is not relayed", async () => {
  const active = WORKFLOW_RUN_STATUSES.find((s) => !["completed", "cancelled", "failed"].includes(s));
  assert.ok(active);
  const fake = fakeDaemon({
    sessions: () => [detached("held")],
    openInspections: async () => [adoptedBy("held")],
    workflowRuns: () => [{ status: active }],
    findings: async () => assert.fail("a held session reads nothing"),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 0);
  assert.deepEqual(fake.injected, []);
});

test("an adopted PR that closes during the findings read is not typed", async () => {
  const fake = fakeDaemon({
    sessions: () => [detached("closing")],
    openInspections: async (afterRead) => (afterRead ? [] : [adoptedBy("closing")]),
    findings: async () => response([draft()]),
  });
  assert.equal((await runReviewFollowup(fake.client, CFG, LEADER)).size, 0);
  assert.deepEqual(fake.injected, []);
});

// ---- the held-findings log line ----

const ACTIVE_RUN = WORKFLOW_RUN_STATUSES.find((s) => !["completed", "cancelled", "failed"].includes(s))!;

/** The Foreman lines one pass wrote about `name`. */
async function heldLines(name: string, fake: ReturnType<typeof fakeDaemon>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await runReviewFollowup(fake.client, CFG, LEADER);
  } finally {
    console.log = original;
  }
  return lines.filter((line) => line.startsWith(`[foreman] ${name}`) && line.includes(": holding "));
}

function heldDaemon(session: () => Session, runs: () => Array<{ status: string }> = () => [{ status: ACTIVE_RUN }]) {
  return fakeDaemon({
    sessions: () => [session()],
    workflowRuns: runs,
    findings: async () => assert.fail("a held session reads nothing"),
  });
}

test("a held PR with findings is logged once per round and reason", async () => {
  let round = 3;
  let runs: Array<{ status: string }> = [{ status: ACTIVE_RUN }];
  let state: Session["state"] = "idle";
  const pass = () =>
    heldLines("held-log", heldDaemon(() => parked("held-log", { state, inspector: summary({ open: 2, round }) }), () => runs));

  assert.deepEqual(await pass(), [
    "[foreman] held-log: holding 2 GitHub Inspector finding(s) on owner/repo#7 (round 3) - an active workflow owns this session",
  ]);
  assert.deepEqual(await pass(), [], "the same round and reason is not logged again");

  round = 4;
  assert.deepEqual(await pass(), [
    "[foreman] held-log: holding 2 GitHub Inspector finding(s) on owner/repo#7 (round 4) - an active workflow owns this session",
  ]);

  runs = [];
  state = "awaiting_input";
  assert.deepEqual(await pass(), [
    "[foreman] held-log: holding 2 GitHub Inspector finding(s) on owner/repo#7 (round 4) - the session needs a human",
  ]);
  assert.deepEqual(await pass(), []);

  runs = [{ status: ACTIVE_RUN }];
  state = "idle";
  assert.deepEqual(await pass(), [], "a reason already logged this round stays quiet when it returns");
});

test("two held PRs on one session are each logged once", async () => {
  const pass = () =>
    heldLines(
      "held-pair",
      fakeDaemon({
        sessions: () => [parked("held-pair", { gitBranch: BRANCH })],
        openInspections: async () => [
          adoptedBy("held-pair", { key: "owner/repo#8", url: "https://github.com/owner/repo/pull/8", number: 8 }),
        ],
        workflowRuns: () => [{ status: ACTIVE_RUN }],
        findings: async () => assert.fail("a held session reads nothing"),
      }),
    );

  assert.deepEqual(await pass(), [
    "[foreman] held-pair: holding 1 GitHub Inspector finding(s) on owner/repo#7 (round 3) - an active workflow owns this session",
    "[foreman] held-pair: holding 1 GitHub Inspector finding(s) on owner/repo#8 (round 3) - an active workflow owns this session",
  ]);
  assert.deepEqual(await pass(), []);
});

test("a hold the freshness recheck finds is logged in the same pass, and a routine one is not", async () => {
  const owned = fakeDaemon({
    sessions: () => [parked("held-recheck")],
    workflowRuns: (afterRead) => (afterRead ? [{ status: ACTIVE_RUN }] : []),
    findings: async () => response([draft()]),
  });
  assert.deepEqual(await heldLines("held-recheck", owned), [
    "[foreman] held-recheck: holding 1 GitHub Inspector finding(s) on owner/repo#7 (round 3) - an active workflow owns this session",
  ]);
  assert.deepEqual(owned.injected, []);

  const busy = fakeDaemon({
    sessions: (afterRead) => [parked("held-recheck-busy", afterRead ? { state: "working", lastActivity: Date.now() } : {})],
    findings: async () => response([draft()]),
  });
  assert.deepEqual(await heldLines("held-recheck-busy", busy), []);
  assert.deepEqual(busy.injected, []);
});

test("the recheck counts the read's findings, so findings resolved before it are not logged as held", async () => {
  const resolved = fakeDaemon({
    sessions: () => [parked("held-recheck-resolved")],
    findings: async () => response([draft({ status: "resolved" })]),
  });
  assert.deepEqual(await heldLines("held-recheck-resolved", resolved), []);

  const twoLeft = fakeDaemon({
    sessions: () => [parked("held-recheck-count", { inspector: summary({ open: 3 }) })],
    workflowRuns: (afterRead) => (afterRead ? [{ status: ACTIVE_RUN }] : []),
    findings: async () =>
      response([draft(), draft({ id: "c2", fingerprint: "fp-2" }), draft({ id: "c3", fingerprint: "fp-3", status: "resolved" })]),
  });
  assert.deepEqual(await heldLines("held-recheck-count", twoLeft), [
    "[foreman] held-recheck-count: holding 2 GitHub Inspector finding(s) on owner/repo#7 (round 3) - an active workflow owns this session",
  ]);
});

test("a recheck whose read is for another round logs the fresh snapshot's count with its round", async () => {
  const raced = fakeDaemon({
    sessions: (afterRead) => [
      parked("held-recheck-round", { inspector: afterRead ? summary({ open: 1, round: 4 }) : summary({ open: 2, round: 3 }) }),
    ],
    findings: async () => response([draft(), draft({ id: "c2", fingerprint: "fp-2" })], 3),
  });
  assert.deepEqual(await heldLines("held-recheck-round", raced), [
    "[foreman] held-recheck-round: holding 1 GitHub Inspector finding(s) on owner/repo#7 (round 4) - " +
      "the findings read and the snapshot are from different GitHub Inspector rounds",
  ]);
  assert.deepEqual(raced.injected, []);
});

test("a stale read that found nothing logs the round mismatch, not 'nothing to act on'", async () => {
  const raced = fakeDaemon({
    sessions: (afterRead) => [
      parked("held-stale-empty", { inspector: afterRead ? summary({ open: 1, round: 4 }) : summary({ open: 1, round: 3 }) }),
    ],
    findings: async () => response([draft({ status: "resolved" })], 3),
  });
  assert.deepEqual(await heldLines("held-stale-empty", raced), [
    "[foreman] held-stale-empty: holding 1 GitHub Inspector finding(s) on owner/repo#7 (round 4) - " +
      "the findings read and the snapshot are from different GitHub Inspector rounds",
  ]);
  assert.deepEqual(raced.injected, []);
});

test("a stale read with review tracking turned off during it logs the real reason", async () => {
  const fake = fakeDaemon({
    sessions: (afterRead) => [
      parked("held-stale-off", { inspector: afterRead ? summary({ open: 1, round: 4 }) : summary({ open: 1, round: 3 }) }),
    ],
    findings: async () => response([draft({ status: "resolved" })], 3),
    config: { ...CFG, trackReviewFeedback: false } as ForemanConfig,
  });
  assert.deepEqual(await heldLines("held-stale-off", fake), [
    "[foreman] held-stale-off: holding 1 GitHub Inspector finding(s) on owner/repo#7 (round 4) - " +
      "no enabled review comments or failing CI",
  ]);
});

test("an exited card and its re-minted successor keep each other's holds", async () => {
  const pass = () =>
    heldLines(
      "held-twin",
      fakeDaemon({
        sessions: () => [
          parked("held-twin-old", { agentSessionId: "agent-held-twin", state: "exited" }),
          parked("held-twin-new", {
            agentSessionId: "agent-held-twin",
            prUrl: null,
            prNumber: null,
            prState: null,
            inspector: null,
            gitBranch: BRANCH,
          }),
        ],
        openInspections: async () => [
          adoptedBy("held-twin-new", { key: "owner/repo#8", url: "https://github.com/owner/repo/pull/8", number: 8 }),
        ],
        workflowRuns: () => [{ status: ACTIVE_RUN }],
        findings: async () => assert.fail("a held session reads nothing"),
      }),
    );

  assert.deepEqual(await pass(), [
    "[foreman] held-twin-old: holding 1 GitHub Inspector finding(s) on owner/repo#7 (round 3) - the session exited",
    "[foreman] held-twin-new: holding 1 GitHub Inspector finding(s) on owner/repo#8 (round 3) - an active workflow owns this session",
  ]);
  assert.deepEqual(await pass(), [], "neither card's prune erases the other's history");
});

test("a card whose summary lags a round does not reset the newer round's history", async () => {
  const pass = () =>
    heldLines(
      "held-lag",
      heldDaemon(() => parked("held-lag-new", { agentSessionId: "agent-held-lag", inspector: summary({ round: 4 }) })),
    );
  const lagging = () =>
    heldLines(
      "held-lag",
      fakeDaemon({
        sessions: () => [
          parked("held-lag-old", { agentSessionId: "agent-held-lag", state: "exited", inspector: summary({ round: 3 }) }),
          parked("held-lag-new", { agentSessionId: "agent-held-lag", inspector: summary({ round: 4 }) }),
        ],
        workflowRuns: () => [{ status: ACTIVE_RUN }],
        findings: async () => assert.fail("a held session reads nothing"),
      }),
    );

  assert.deepEqual(await pass(), [
    "[foreman] held-lag-new: holding 1 GitHub Inspector finding(s) on owner/repo#7 (round 4) - an active workflow owns this session",
  ]);
  assert.deepEqual(await lagging(), [], "the round-3 card is older than what was logged");
  assert.deepEqual(await lagging(), []);
});

test("a session whose id is re-minted keeps its logged holds", async () => {
  const held = (id: string) => heldDaemon(() => parked(id, { agentSessionId: "agent-held-remint" }));
  assert.equal((await heldLines("held-remint-a", held("held-remint-a"))).length, 1);
  assert.deepEqual(await heldLines("held-remint-b", held("held-remint-b")), []);
});

test("a held PR the session stops following is forgotten, so its return logs again", async () => {
  let adoptedOpen = true;
  const pass = () =>
    heldLines(
      "held-prune",
      fakeDaemon({
        sessions: () => [parked("held-prune", { gitBranch: BRANCH })],
        openInspections: async () =>
          adoptedOpen
            ? [adoptedBy("held-prune", { key: "owner/repo#8", url: "https://github.com/owner/repo/pull/8", number: 8 })]
            : [],
        workflowRuns: () => [{ status: ACTIVE_RUN }],
        findings: async () => assert.fail("a held session reads nothing"),
      }),
    );
  const line8 =
    "[foreman] held-prune: holding 1 GitHub Inspector finding(s) on owner/repo#8 (round 3) - an active workflow owns this session";

  assert.equal((await pass()).length, 2);
  adoptedOpen = false;
  assert.deepEqual(await pass(), []);
  adoptedOpen = true;
  assert.deepEqual(await pass(), [line8], "#7 stayed remembered; #8 was pruned while it was gone");
});

test("a held PR without findings logs nothing", async () => {
  const fake = heldDaemon(() => parked("held-clean", { inspector: summary({ open: 0 }) }));
  assert.deepEqual(await heldLines("held-clean", fake), []);
});

test("the routine waiting skips log nothing", async () => {
  const working = heldDaemon(() => parked("held-working", { state: "working", lastActivity: Date.now() }), () => []);
  assert.deepEqual(await heldLines("held-working", working), []);

  const relayed = fakeDaemon({ sessions: () => [parked("held-relayed")], findings: async () => response([draft()]) });
  assert.equal((await runReviewFollowup(relayed.client, CFG, LEADER)).size, 1);
  const again = heldDaemon(() => parked("held-relayed"), () => []);
  assert.deepEqual(await heldLines("held-relayed", again), [], "already nudged this round");
});
