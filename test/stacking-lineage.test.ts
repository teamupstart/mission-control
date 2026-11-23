import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { InspectorPr, Task } from "../src/shared/types.ts";
import type { PrRefs, PrSnapshot } from "../src/server/inspector/github.ts";
import type { StackGitHub } from "../src/server/stacking/github.ts";

// A stacked pull request's lineage on its Inspector row, the base correction that uses it,
// the release check that frees it, and the PR-opening instruction that names the same base.
// Real SQLite in a temp home; GitHub is a scripted seam.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-lineage-"));
process.env.HARNESS_HOME = home;
const { openDb, adoptInspectorPr, getInspectorPr, loadInspectorInspections, recordInspectorPrLineage, updateInspectorPr } = await import("../src/server/db.ts");
const { adoptStackLineage, correctStackBase, refreshStackRelease, reviewedStackBase, stackPrInstruction } = await import(
  "../src/server/stacking/lineage.ts"
);
const { maybeMerge } = await import("../src/server/shipping/merge.ts");
const { adoptOpenedPr } = await import("../src/server/inspector/worker.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const PARENT = "https://github.com/acme/repo/pull/7";
const REPLACEMENT_PARENT = "https://github.com/acme/repo/pull/8";
const CUT = "c".repeat(40);
const PARENT_HEAD = "d".repeat(40);
const MERGE = "e".repeat(40);
const CHILD_HEAD = "f".repeat(40);

let nextNumber = 100;

function adopt(url: string, adoptedAt = 1_000, state: "open" | "closed" = "open"): string {
  const number = Number(url.split("/").at(-1));
  const [owner, repo] = url.replace("https://github.com/", "").split("/");
  const key = `${owner}/${repo}#${number}`;
  adoptInspectorPr({
    key, url, owner: owner!, repo: repo!, number, repoRoot: "/repo", cwd: "/repo", sessionId: "s1", source: "hook",
    state, headSha: null, reviewPosture: null, round: 0, lastReviewedAt: null, lastError: null, failCount: 0,
    lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: null, mergeBlock: null,
    observedHeadSha: null, observedState: null, observedAt: null, headRefName: null, title: null,
    adoptedAt, updatedAt: adoptedAt,
  });
  return key;
}

function childUrl(repo = "repo"): string {
  nextNumber += 1;
  return `https://github.com/acme/${repo}/pull/${nextNumber}`;
}

function stackedTask(over: Partial<Task> = {}): Task {
  return mkTask({
    id: "child", status: "running", repoRoot: "/repo", stackParentTaskId: "parent",
    stackBaseBranch: "feat/parent", stackBaseSha: CUT, stackPrUrl: PARENT, ...over,
  });
}

interface Gh {
  refs: Map<string, PrRefs>;
  ancestry: Map<string, boolean>;
  /** `${base}...${head}` -> merge base. Absent = GitHub could not answer. */
  mergeBases: Map<string, string>;
  compares: string[];
  retargets: { number: number; base: string }[];
  repositories: { owner: string; repo: string }[];
}

function gh(): Gh {
  return {
    refs: new Map(), ancestry: new Map(), mergeBases: new Map(), compares: [], retargets: [],
    repositories: [{ owner: "acme", repo: "repo" }],
  };
}

function seam(g: Gh): StackGitHub {
  return {
    prRefs: async (_cwd, url) => {
      const refs = g.refs.get(url);
      return refs ? { ok: true, value: refs } : { ok: false, error: "unreadable" };
    },
    isAncestor: async (_cwd, _o, _r, ancestor, head) => {
      const answer = g.ancestry.get(`${ancestor}..${head}`);
      return answer === undefined ? { ok: false, error: "compare failed" } : { ok: true, value: answer };
    },
    compare: async (_cwd, _o, _r, base, head) => {
      const answer = g.ancestry.get(`${base}..${head}`);
      return answer === undefined ? { ok: false, error: "compare failed" } : { ok: true, value: { contains: answer, behindBy: answer ? 0 : 1 } };
    },
    mergeBase: async (_cwd, _o, _r, base, head) => {
      g.compares.push(`${base}...${head}`);
      const answer = g.mergeBases.get(`${base}...${head}`);
      return answer === undefined ? { ok: false, error: "compare failed" } : { ok: true, value: answer };
    },
    branchSha: async () => ({ ok: false, reason: "unused", outcomeUnknown: false }),
    repositories: async () => g.repositories,
    primaryRepository: async () => g.repositories[0] ?? null,
    retarget: async (_cwd, _o, _r, number, base) => {
      g.retargets.push({ number, base });
      return { ok: true };
    },
  };
}

function refs(over: Partial<PrRefs> = {}): PrRefs {
  return { state: "OPEN", isDraft: false, headSha: PARENT_HEAD, headRefName: "feat/parent", baseRefName: "main",
    defaultBranch: "main", mergeCommitSha: null, ...over };
}

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: "OPEN", headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "main", defaultBranch: "main",
    mergeCommitSha: null, title: "child", body: "", isDraft: false, threads: [], reviews: [],
    reviewsPageInfo: { hasPreviousPage: false, startCursor: null }, createdAt: 0, mergeable: "MERGEABLE",
    reviewDecision: null, checks: "passing", ...over,
  };
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs");
});

test("the first child pull request is seeded from the task's dispatch", async () => {
  const url = childUrl();
  const key = adopt(url);
  assert.equal(adoptStackLineage(key, { task: stackedTask(), episodeId: "ep1" }, 2_000), true);
  const lineage = getInspectorPr(key)?.stack;
  assert.deepEqual(lineage && { ...lineage }, {
    taskId: "child", episode: "ep1", adoptedAt: 2_000, parentPrUrl: PARENT, baseSha: CUT,
    releasedHeadSha: null, releasedBasis: null, history: [], note: null, observation: null, awaitReplacementAt: null,
  });
  // Written once: a second adoption signal cannot rewrite it.
  assert.equal(adoptStackLineage(key, { task: stackedTask({ stackPrUrl: REPLACEMENT_PARENT }), episodeId: "ep1" }, 3_000), false);
  assert.equal(getInspectorPr(key)?.stack?.parentPrUrl, PARENT);
});

test("an unstacked task, and a stacked task's secondary-repository pull request, get no lineage", async () => {
  const plainKey = adopt(childUrl());
  assert.equal(adoptStackLineage(plainKey, { task: mkTask({ id: "child", status: "running" }), episodeId: "ep1" }, 2_000), false);
  assert.equal(getInspectorPr(plainKey)?.stack, null);
  const secondaryKey = adopt(childUrl("second"));
  assert.equal(adoptStackLineage(secondaryKey, { task: stackedTask(), episodeId: "ep1" }, 2_000), false);
  assert.equal(getInspectorPr(secondaryKey)?.stack, null);
});

test("a later child pull request in the same episode inherits the latest previous row unchanged", async () => {
  const first = adopt(childUrl());
  adoptStackLineage(first, { task: stackedTask(), episodeId: "ep1" }, 2_000);
  // A replacement parent took over the first row's lineage (the Phase 2 transition).
  openDb().prepare("UPDATE inspector_prs SET stack_parent_pr_url = ?, stack_lineage_history = ? WHERE key = ?")
    .run(REPLACEMENT_PARENT, JSON.stringify([{ from: PARENT, to: REPLACEMENT_PARENT, at: 2_500 }]), first);
  // The task's own fields still name the original parent; the replacement must not revert.
  const second = adopt(childUrl(), 3_000);
  adoptStackLineage(second, { task: stackedTask(), episodeId: "ep1" }, 3_000);
  const inherited = getInspectorPr(second)!.stack!;
  assert.equal(inherited.parentPrUrl, REPLACEMENT_PARENT);
  assert.equal(inherited.baseSha, CUT);
  assert.deepEqual(inherited.history, [{ from: PARENT, to: REPLACEMENT_PARENT, at: 2_500 }]);
  assert.equal(inherited.adoptedAt, 3_000);
});

test("inheritance copies the highest stack_adopted_at, the higher rowid breaking a tie", async () => {
  const a = adopt(childUrl());
  const b = adopt(childUrl());
  adoptStackLineage(a, { task: stackedTask(), episodeId: "ep1" }, 5_000);
  adoptStackLineage(b, { task: stackedTask(), episodeId: "ep1" }, 5_000);
  // Two rows of one episode adopted in the same millisecond, naming different parents.
  const setParent = openDb().prepare("UPDATE inspector_prs SET stack_parent_pr_url = ?, stack_adopted_at = 5000 WHERE key = ?");
  setParent.run("https://github.com/acme/repo/pull/1", a);
  setParent.run("https://github.com/acme/repo/pull/2", b);
  const c = adopt(childUrl());
  adoptStackLineage(c, { task: stackedTask(), episodeId: "ep1" }, 6_000);
  assert.equal(getInspectorPr(c)!.stack!.parentPrUrl, "https://github.com/acme/repo/pull/2", "tie on time: the later row wins");
  openDb().prepare("UPDATE inspector_prs SET stack_adopted_at = 7000 WHERE key = ?").run(a);
  const d = adopt(childUrl());
  adoptStackLineage(d, { task: stackedTask(), episodeId: "ep1" }, 8_000);
  assert.equal(getInspectorPr(d)!.stack!.parentPrUrl, "https://github.com/acme/repo/pull/1", "the most recently adopted wins");
});

test("inheritance ignores another repository's rows and never crosses an episode", async () => {
  // A row of the same task and episode in ANOTHER repository, with a different parent. It can
  // only exist by hand (adoption refuses a pull request outside the parent's repository), so
  // it is seeded directly - the lookup must still never read it.
  const elsewhere = adopt("https://github.com/acme/fork/pull/3");
  recordInspectorPrLineage(elsewhere, { taskId: "child", episode: "ep1", adoptedAt: 2_000, parentPrUrl: REPLACEMENT_PARENT, baseSha: CUT, history: [] });
  const first = adopt(childUrl());
  adoptStackLineage(first, { task: stackedTask(), episodeId: "ep1" }, 3_000);
  assert.equal(getInspectorPr(first)!.stack!.parentPrUrl, PARENT, "a different repository's row is not this one's lineage");

  // Rescheduled: a new episode cut on a new parent seeds from the new dispatch.
  const NEW_CUT = "1".repeat(40);
  const rescheduled = stackedTask({ stackPrUrl: REPLACEMENT_PARENT, stackBaseSha: NEW_CUT, stackBaseBranch: "feat/new-parent" });
  const next = adopt(childUrl(), 4_000);
  adoptStackLineage(next, { task: rescheduled, episodeId: "ep2" }, 4_000);
  assert.deepEqual(
    { parent: getInspectorPr(next)!.stack!.parentPrUrl, base: getInspectorPr(next)!.stack!.baseSha },
    { parent: REPLACEMENT_PARENT, base: NEW_CUT },
  );
  assert.match(stackPrInstruction(rescheduled, "ep2") ?? "", /pull\/8/);
});

test("an unstacked dispatch's pull request gets no lineage, even after an earlier stacked episode", async () => {
  const first = adopt(childUrl());
  adoptStackLineage(first, { task: stackedTask(), episodeId: "ep1" }, 2_000);
  const unstacked = mkTask({ id: "child", status: "running", stackParentTaskId: null, stackBaseBranch: null, stackBaseSha: null, stackPrUrl: null });
  const later = adopt(childUrl(), 3_000);
  assert.equal(adoptStackLineage(later, { task: unstacked, episodeId: "ep2" }, 3_000), false);
  assert.equal(getInspectorPr(later)!.stack, null);
});

async function stackedRow(_g: Gh): Promise<string> {
  const url = childUrl();
  const key = adopt(url);
  adoptStackLineage(key, { task: stackedTask(), episodeId: "ep1" }, 2_000);
  return key;
}

test("base correction: a wrong base while the parent is open moves to the parent's branch", async () => {
  const g = gh();
  const key = await stackedRow(g);
  g.refs.set(PARENT, refs());
  g.refs.set(getInspectorPr(key)!.url, refs({ headRefName: "feat/child", baseRefName: "main" }));
  assert.equal(await correctStackBase(key, seam(g), 3_000), "retargeted");
  assert.deepEqual(g.retargets, [{ number: getInspectorPr(key)!.number, base: "feat/parent" }]);
  assert.match(getInspectorPr(key)!.stack!.note ?? "", /main to feat\/parent/);
});

test("base correction never retargets to a closed or merged parent's branch", async () => {
  for (const state of ["CLOSED", "MERGED"] as const) {
    // A replacement child opened against main after its parent finished stays on main.
    const g = gh();
    const key = await stackedRow(g);
    g.refs.set(PARENT, refs({ state }));
    g.refs.set(getInspectorPr(key)!.url, refs({ headRefName: "feat/child-2", baseRefName: "main" }));
    assert.equal(await correctStackBase(key, seam(g), 3_000), "unchanged", state);
    assert.deepEqual(g.retargets, [], state);
    // A child still on the finished parent's branch moves to the default branch, not stays.
    g.refs.set(getInspectorPr(key)!.url, refs({ headRefName: "feat/child-2", baseRefName: "feat/parent" }));
    assert.equal(await correctStackBase(key, seam(g), 3_000), "retargeted", state);
    assert.deepEqual(g.retargets, [{ number: getInspectorPr(key)!.number, base: "main" }], state);
  }
});

test("a base correction GitHub refuses reports failed and records GitHub's reason", async () => {
  const g = gh();
  const key = await stackedRow(g);
  g.refs.set(PARENT, refs());
  g.refs.set(getInspectorPr(key)!.url, refs({ headRefName: "feat/child", baseRefName: "main" }));
  const attempts: string[] = [];
  const refusing: StackGitHub = {
    ...seam(g),
    retarget: async (_cwd, _o, _r, _number, base) => {
      attempts.push(base);
      return { ok: false, error: "gh api (retarget pull request) failed (exit 1): HTTP 422: Validation Failed", outcomeUnknown: false };
    },
  };
  assert.equal(await correctStackBase(key, refusing, 3_000), "failed");
  assert.deepEqual(attempts, ["feat/parent"], "it asked for the parent's branch exactly once");
  const note = getInspectorPr(key)!.stack!.note ?? "";
  assert.match(note, /^could not move the base from main to feat\/parent: /);
  assert.match(note, /HTTP 422: Validation Failed/, "GitHub's own refusal is kept, not flattened");
  assert.doesNotMatch(note, /^base moved/, "a refusal is never reported as a correction");
  // The lineage itself is untouched by the failure: the hold keeps reading the same parent.
  assert.equal(getInspectorPr(key)!.stack!.parentPrUrl, PARENT);
  // And the reason reaches the ledger projection GET /api/inspector/prs serves the dashboard.
  const served = loadInspectorInspections(50).find((row) => row.key === key);
  assert.equal(served?.stack?.note, note);
});

test("base correction with an unreadable parent changes nothing", async () => {
  const g = gh();
  const key = await stackedRow(g);
  g.refs.set(getInspectorPr(key)!.url, refs({ headRefName: "feat/child", baseRefName: "main" }));
  assert.equal(await correctStackBase(key, seam(g), 3_000), "unknown");
  assert.deepEqual(g.retargets, []);
});

test("the PR-opening instruction names the same expected base", async () => {
  const g = gh();
  // The first child, at dispatch: the open parent's branch.
  assert.match(stackPrInstruction(stackedTask(), undefined) ?? "", /--base feat\/parent/);
  assert.match(stackPrInstruction(stackedTask(), undefined) ?? "", /Stacked on #7/);
  assert.equal(stackPrInstruction(mkTask({ id: "x" }), undefined), null);
  // A replacement child after the current parent closed or merged: the default branch.
  const key = await stackedRow(g);
  const parentKey = adopt(PARENT, 500);
  for (const observed of ["CLOSED", "MERGED"] as const) {
    updateInspectorPr(parentKey, { observedState: observed, headRefName: "feat/parent" }, 4_000);
    const text = stackPrInstruction(stackedTask(), "ep1") ?? "";
    assert.match(text, /against the repository's default branch/, observed);
    assert.doesNotMatch(text, /--base feat\/parent/, observed);
  }
  assert.ok(getInspectorPr(key)?.stack);
});

function rowOf(key: string): InspectorPr {
  return getInspectorPr(key)!;
}

test("stack-hold: an automatic retarget with no restack stays held", async () => {
  const g = gh();
  const key = await stackedRow(g);
  g.refs.set(PARENT, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  g.ancestry.set(`${MERGE}..${CHILD_HEAD}`, false);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot(), "/repo", seam(g), 3_000), false);
  assert.equal(rowOf(key).stack!.releasedHeadSha, null);
});

test("stack-hold: releases only on ancestry, and re-checks every later head", async () => {
  const g = gh();
  const key = await stackedRow(g);
  g.refs.set(PARENT, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  g.ancestry.set(`${MERGE}..${CHILD_HEAD}`, true);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot(), "/repo", seam(g), 3_000), true);
  assert.equal(rowOf(key).stack!.releasedHeadSha, CHILD_HEAD);
  // An unrelated push that does not carry the merge commit is held again.
  const LATER = "9".repeat(40);
  g.ancestry.set(`${MERGE}..${LATER}`, false);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: LATER }), "/repo", seam(g), 4_000), false);
  assert.equal(rowOf(key).stack!.releasedHeadSha, CHILD_HEAD, "the release is for the head it was verified on");
  // A compare failure holds.
  const OTHER = "8".repeat(40);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: OTHER }), "/repo", seam(g), 4_000), false);
  // Still on the parent's branch: not even asked.
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: OTHER, baseRefName: "feat/parent" }), "/repo", seam(g), 4_000), false);
});

test("stack-hold: a closed parent releases only once the child carries none of it", async () => {
  const g = gh();
  const key = await stackedRow(g);
  g.refs.set(PARENT, refs({ state: "CLOSED", headSha: PARENT_HEAD }));
  // The parent pushed again before closing: its last head is absent, the cut commit is not.
  g.ancestry.set(`${CUT}..${CHILD_HEAD}`, true);
  g.ancestry.set(`${PARENT_HEAD}..${CHILD_HEAD}`, false);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot(), "/repo", seam(g), 3_000), false);
  // Merging main into that child does not help: the parent's commits stay in its ancestry.
  const MERGED_MAIN = "7".repeat(40);
  g.ancestry.set(`${CUT}..${MERGED_MAIN}`, true);
  g.ancestry.set(`${PARENT_HEAD}..${MERGED_MAIN}`, true);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: MERGED_MAIN }), "/repo", seam(g), 3_000), false);
  // Moved onto main: neither the cut commit nor the parent's last head.
  const MOVED = "6".repeat(40);
  g.ancestry.set(`${CUT}..${MOVED}`, false);
  g.ancestry.set(`${PARENT_HEAD}..${MOVED}`, false);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: MOVED }), "/repo", seam(g), 3_000), true);
});

test("stack-hold reads the CURRENT parent", async () => {
  const g = gh();
  const key = await stackedRow(g);
  g.refs.set(PARENT, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  g.ancestry.set(`${MERGE}..${CHILD_HEAD}`, true);
  // The current parent is now a replacement that is still open.
  openDb().prepare("UPDATE inspector_prs SET stack_parent_pr_url = ? WHERE key = ?").run(REPLACEMENT_PARENT, key);
  g.refs.set(REPLACEMENT_PARENT, refs({ headRefName: "feat/replacement" }));
  assert.equal(await refreshStackRelease(rowOf(key), snapshot(), "/repo", seam(g), 3_000), false);
});

test("the hold survives the Stacked pull requests setting being switched off", async () => {
  const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
  const inspector = setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  setShippingConfig({ autoMerge: true, repoAllowlist: ["/repo"], soakMinutes: 0, stacking: "merge" });
  const g = gh();
  const key = await stackedRow(g);
  updateInspectorPr(key, { headSha: CHILD_HEAD, reviewPosture: "live", round: 1, reviewComplete: true, reviewedBaseRef: "main" }, 3_000);
  const merged = await maybeMerge(inspector, rowOf(key), "/repo", snapshot(), new Map(), 1_000_000);
  assert.equal(merged, false);
  assert.equal(rowOf(key).mergeBlock, "stack-hold");
  assert.equal(rowOf(key).stack!.parentPrUrl, PARENT, "the setting never changes or clears lineage");

  // On the parent's branch it is the stacked-base block instead.
  const merged2 = await maybeMerge(inspector, rowOf(key), "/repo", snapshot({ baseRefName: "feat/parent" }), new Map(), 1_000_000);
  assert.equal(merged2, false);
  assert.equal(rowOf(key).mergeBlock, "stacked-base");
});

test("a stacked child is adopted WITH its lineage, so YOLO can never see it as an ordinary pull request", async () => {
  const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
  const inspector = setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  setShippingConfig({ autoMerge: true, repoAllowlist: ["/repo"], soakMinutes: 0 });
  const url = childUrl();
  const registry = {
    taskForSession: () => stackedTask(),
    workEpisodeForSession: () => ({ episodeId: "ep1" }) as never,
  };
  // The hook's adoption, exactly as the Inspector runs it. Read the row back in the SAME
  // synchronous turn: there is no await between adoption and the lineage write, so there is
  // no moment at which the row exists without it - which is what let a child opened straight
  // against the default branch be evaluated without the stack hold.
  assert.equal(adoptOpenedPr(registry, { url, sessionId: "s1", cwd: "/repo", repoRoot: "/repo" }, 2_000), true);
  const key = `acme/repo#${url.split("/").at(-1)}`;
  const adopted = getInspectorPr(key)!;
  assert.equal(adopted.stack?.parentPrUrl, PARENT, "lineage is on the row the moment it is adopted");
  assert.equal(adopted.stack?.baseSha, CUT);

  // The worst case for the gate: reviewed clean, live, CI green, on the default branch.
  updateInspectorPr(key, { headSha: CHILD_HEAD, reviewPosture: "live", round: 1, reviewComplete: true, reviewedBaseRef: "main" }, 3_000);
  const merged = await maybeMerge(inspector, getInspectorPr(key)!, "/repo", snapshot(), new Map(), 1_000_000);
  assert.equal(merged, false, "a stacked child never merges before its stack is released");
  assert.equal(getInspectorPr(key)!.mergeBlock, "stack-hold");
});

test("an ordinary task's pull request is adopted without lineage, and one in another repository too", () => {
  const plain = childUrl();
  assert.equal(adoptOpenedPr({ taskForSession: () => mkTask({ id: "plain", status: "running" }), workEpisodeForSession: () => null },
    { url: plain, sessionId: "s1", cwd: "/repo", repoRoot: "/repo" }, 2_000), true);
  assert.equal(getInspectorPr(`acme/repo#${plain.split("/").at(-1)}`)!.stack, null);
  const secondary = childUrl("second");
  assert.equal(adoptOpenedPr({ taskForSession: () => stackedTask(), workEpisodeForSession: () => ({ episodeId: "ep1" }) as never },
    { url: secondary, sessionId: "s1", cwd: "/repo", repoRoot: "/repo" }, 2_000), true);
  assert.equal(getInspectorPr(`acme/second#${secondary.split("/").at(-1)}`)!.stack, null, "a secondary-repository pull request gets no lineage");
});

// ---- Inspector review 1: the reviewed base is a COMMIT, not just a branch name ------------

const BASE_V1 = "1".repeat(40);
const BASE_V2 = "2".repeat(40);
const REBASED = "3".repeat(40);
const MB_OLD = "4".repeat(40);
const MB_NEW = "5".repeat(40);

/** A stacked child reviewed at CHILD_HEAD against the parent branch at BASE_V1. */
async function reviewedStackedRow(g: Gh): Promise<string> {
  const key = await stackedRow(g);
  updateInspectorPr(key, {
    headSha: CHILD_HEAD, reviewPosture: "live", round: 1, reviewComplete: true,
    reviewedBaseRef: "feat/parent", reviewedBaseSha: BASE_V1,
  }, 3_000);
  return key;
}

const onParent = (baseSha: string) => snapshot({ baseRefName: "feat/parent", baseSha });

test("a parent rebased under an unchanged child head and base name invalidates the review", async () => {
  const g = gh();
  const key = await reviewedStackedRow(g);
  g.mergeBases.set(`${REBASED}...${CHILD_HEAD}`, MB_NEW);
  g.mergeBases.set(`${BASE_V1}...${CHILD_HEAD}`, MB_OLD);
  assert.equal(await reviewedStackBase(rowOf(key), onParent(REBASED), "/repo", seam(g), 4_000), "changed");
  assert.equal(rowOf(key).reviewedBaseSha, BASE_V1, "a changed diff never advances the reviewed base");
});

test("a parent that only moved forward keeps the review, and the new tip is recorded once", async () => {
  const g = gh();
  const key = await reviewedStackedRow(g);
  g.mergeBases.set(`${BASE_V2}...${CHILD_HEAD}`, MB_OLD);
  g.mergeBases.set(`${BASE_V1}...${CHILD_HEAD}`, MB_OLD);
  assert.equal(await reviewedStackBase(rowOf(key), onParent(BASE_V2), "/repo", seam(g), 4_000), "current");
  assert.equal(rowOf(key).reviewedBaseSha, BASE_V2);
  const calls = g.compares.length;
  assert.equal(await reviewedStackBase(rowOf(key), onParent(BASE_V2), "/repo", seam(g), 5_000), "current");
  assert.equal(g.compares.length, calls, "an unchanged tip asks GitHub nothing");
});

test("an unanswerable merge base for the current tip is unknown; a vanished reviewed tip is a change", async () => {
  const g = gh();
  const key = await reviewedStackedRow(g);
  assert.equal(await reviewedStackBase(rowOf(key), onParent(REBASED), "/repo", seam(g), 4_000), "unknown");
  g.mergeBases.set(`${REBASED}...${CHILD_HEAD}`, MB_NEW);
  assert.equal(
    await reviewedStackBase(rowOf(key), onParent(REBASED), "/repo", seam(g), 4_000),
    "changed",
    "the force-pushed tip GitHub no longer knows cannot vouch for the old diff",
  );
  assert.equal(await reviewedStackBase(rowOf(key), onParent(""), "/repo", seam(g), 4_000), "unknown", "no reported tip is unknown");
});

test("a review with no recorded base commit does not count for a stacked pull request", async () => {
  const g = gh();
  const key = await stackedRow(g);
  updateInspectorPr(key, { headSha: CHILD_HEAD, reviewPosture: "live", round: 1, reviewComplete: true, reviewedBaseRef: "feat/parent" }, 3_000);
  assert.equal(await reviewedStackBase(rowOf(key), onParent(BASE_V1), "/repo", seam(g), 4_000), "changed");
});

test("the base-commit check leaves ordinary default-branch pull requests and new heads alone", async () => {
  const g = gh();
  const plain = adopt(childUrl());
  updateInspectorPr(plain, { headSha: CHILD_HEAD, reviewPosture: "live", round: 1, reviewComplete: true, reviewedBaseRef: "main" }, 3_000);
  assert.equal(await reviewedStackBase(rowOf(plain), snapshot({ baseSha: BASE_V2 }), "/repo", seam(g), 4_000), "current");
  assert.equal(await reviewedStackBase(rowOf(plain), snapshot({ baseRefName: "" }), "/repo", seam(g), 4_000), "current",
    "an unknown base on an ordinary pull request is the merge gate's to refuse");
  const key = await reviewedStackedRow(g);
  assert.equal(await reviewedStackBase(rowOf(key), { ...onParent(REBASED), headSha: "9".repeat(40) }, "/repo", seam(g), 4_000), "current",
    "a new head is reviewed again on its own");
  assert.deepEqual(g.compares, []);
  // An ordinary pull request on a non-default base is checked the same way as a stacked one.
  updateInspectorPr(plain, { reviewedBaseRef: "release/1", reviewedBaseSha: BASE_V1 }, 5_000);
  g.mergeBases.set(`${REBASED}...${CHILD_HEAD}`, MB_NEW);
  g.mergeBases.set(`${BASE_V1}...${CHILD_HEAD}`, MB_OLD);
  assert.equal(await reviewedStackBase(rowOf(plain), snapshot({ baseRefName: "release/1", baseSha: REBASED }), "/repo", seam(g), 6_000), "changed");
});

// ---- Inspector review 2: a stored release is not trusted while the parent can come back ---

/** A child released against a parent that closed without merging, at MOVED (off the parent). */
async function releasedOnClosedParent(g: Gh): Promise<{ key: string; head: string }> {
  const key = await stackedRow(g);
  const MOVED = "6".repeat(40);
  g.refs.set(PARENT, refs({ state: "CLOSED", headSha: PARENT_HEAD }));
  g.ancestry.set(`${CUT}..${MOVED}`, false);
  g.ancestry.set(`${PARENT_HEAD}..${MOVED}`, false);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: MOVED }), "/repo", seam(g), 3_000), true);
  assert.equal(rowOf(key).stack!.releasedHeadSha, MOVED);
  updateInspectorPr(key, { headSha: MOVED, reviewPosture: "live", round: 1, reviewComplete: true, reviewedBaseRef: "main" }, 3_000);
  return { key, head: MOVED };
}

test("a parent reopened after its child was released withdraws the release, and YOLO holds again", async () => {
  const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
  const inspector = setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  setShippingConfig({ autoMerge: true, repoAllowlist: ["/repo"], soakMinutes: 0, stacking: "stack" });
  const g = gh();
  const { key, head } = await releasedOnClosedParent(g);

  // Still closed: the stored release keeps passing on the same head.
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: head }), "/repo", seam(g), 4_000), true);
  assert.equal(rowOf(key).stack!.releasedHeadSha, head);

  // Reopened, child head unchanged: the prerequisite is open again.
  g.refs.set(PARENT, refs({ state: "OPEN", headSha: PARENT_HEAD }));
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: head }), "/repo", seam(g), 5_000), false);
  assert.equal(rowOf(key).stack!.releasedHeadSha, null, "the release is withdrawn, not trusted");
  const merged = await maybeMerge(inspector, rowOf(key), "/repo", snapshot({ headSha: head }), new Map(), 1_000_000);
  assert.equal(merged, false, "YOLO never merges a child whose prerequisite is open");
  assert.equal(rowOf(key).mergeBlock, "stack-hold");
});

test("a stored release whose parent cannot be read is withdrawn; one under a merged parent is final", async () => {
  const g = gh();
  const { key, head } = await releasedOnClosedParent(g);
  g.refs.delete(PARENT);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: head }), "/repo", seam(g), 4_000), false);
  assert.equal(rowOf(key).stack!.releasedHeadSha, null, "an unconfirmed release is not trusted");

  // A merged parent: once released for this head, the release stands without ancestry calls.
  const g2 = gh();
  const merged = await stackedRow(g2);
  g2.refs.set(PARENT, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  g2.ancestry.set(`${MERGE}..${CHILD_HEAD}`, true);
  assert.equal(await refreshStackRelease(rowOf(merged), snapshot(), "/repo", seam(g2), 4_000), true);
  g2.ancestry.clear();
  assert.equal(await refreshStackRelease(rowOf(merged), snapshot(), "/repo", seam(g2), 5_000), true, "a merge cannot be undone");
  assert.equal(rowOf(merged).stack!.releasedHeadSha, CHILD_HEAD);
});

// ---- Inspector review 16: a release keeps the parent state it was granted under ------------

test("a release granted under a closed parent is checked against the merge commit once that parent reopens and merges", async () => {
  const g = gh();
  const { key, head } = await releasedOnClosedParent(g);
  assert.equal(rowOf(key).stack!.releasedBasis, "closed");

  // The parent is reopened and merged. The child's head is unchanged and lacks the merge commit.
  g.refs.set(PARENT, refs({ state: "MERGED", headSha: PARENT_HEAD, mergeCommitSha: MERGE }));
  g.ancestry.set(`${MERGE}..${head}`, false);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: head }), "/repo", seam(g), 5_000), false,
    "the closed-parent release does not stand in for the merged-parent ancestry check");
  assert.equal(rowOf(key).stack!.releasedHeadSha, null, "and it is withdrawn");

  // Once the head carries the merge commit, it is released again - as merged, and final.
  const RESTACKED = "7".repeat(40);
  g.ancestry.set(`${MERGE}..${RESTACKED}`, true);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: RESTACKED }), "/repo", seam(g), 6_000), true);
  assert.deepEqual([rowOf(key).stack!.releasedHeadSha, rowOf(key).stack!.releasedBasis], [RESTACKED, "merged"]);
  g.ancestry.clear();
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: RESTACKED }), "/repo", seam(g), 7_000), true,
    "a release granted under a merged parent stands without asking again");
});

test("a closed-parent release that already carries the later merge commit is re-recorded as merged", async () => {
  const g = gh();
  const { key, head } = await releasedOnClosedParent(g);
  g.refs.set(PARENT, refs({ state: "MERGED", headSha: PARENT_HEAD, mergeCommitSha: MERGE }));
  g.ancestry.set(`${MERGE}..${head}`, true);
  assert.equal(await refreshStackRelease(rowOf(key), snapshot({ headSha: head }), "/repo", seam(g), 5_000), true);
  assert.deepEqual([rowOf(key).stack!.releasedHeadSha, rowOf(key).stack!.releasedBasis], [head, "merged"]);
});
