import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InspectorVerdictSchema, type LocalInspectorFinding } from "../src/shared/inspector-review.ts";
import { emptyWorkflowCommandView, type WorkflowCommandArtifactDescriptor } from "../src/shared/workflow.ts";
import { planLocalReview } from "../src/server/inspector/verdict.ts";
import { runCheck, type RunCheckInput } from "../src/server/workflows/checks.ts";

const major = { path: "./app.ts", line: 42, severity: "major", title: "Handle the empty result", body: "The next call receives undefined." } as const;
const minor = { ...major, severity: "minor", title: "Report the fallback" } as const;

test("local planning uses real lines, scrubs findings, and rejects findings outside the submitted diff", () => {
  const plan = planLocalReview({
    verdict: InspectorVerdictSchema.parse({ summary: "Summary", findings: [
      { ...major, severity: "minor" }, major, { ...minor, body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, { ...major, path: "unchanged.ts" },
    ] }),
    changedPaths: new Set(["app.ts"]), previous: [], prompted: new Set(), blockingSeverity: "major",
  });
  assert.deepEqual(plan.findings.map(f => [f.path, f.line, f.severity]), [["app.ts", 42, "major"], ["app.ts", 42, "minor"]]);
  assert.match(plan.findings[1]!.body, /redacted/i);
  assert.equal(plan.blocked, true);

  const subsequent = (resolved: string[], prompted: Set<string>, severity: "major" | "minor") => planLocalReview({
    verdict: InspectorVerdictSchema.parse({ summary: "", resolved }), changedPaths: new Set(["app.ts"]),
    previous: plan.findings, prompted, blockingSeverity: severity,
  });
  const fingerprint = plan.findings[0]!.fingerprint;
  assert.equal(subsequent([fingerprint], new Set(), "major").blocked, true);
  const repaired = subsequent([fingerprint], new Set([fingerprint]), "major");
  assert.equal(repaired.blocked, false);
  assert.deepEqual(repaired.findings.map(f => f.severity), ["minor"]);
  assert.equal(subsequent([fingerprint], new Set([fingerprint]), "minor").blocked, true);
  const reRaised = planLocalReview({
    verdict: InspectorVerdictSchema.parse({ summary: "", findings: [{ ...major, severity: "minor" }], resolved: [fingerprint] }),
    changedPaths: new Set(["app.ts"]), previous: plan.findings, prompted: new Set([fingerprint]), blockingSeverity: "major",
  });
  assert.equal(reRaised.blocked, true);
  assert.equal(reRaised.findings[0]?.severity, "major");
});

test("Local Inspector skips when preview or review is off, even when Commands are denied", async () => {
  const input = preflight();
  for (const toggles of [{ preview: false }, { enabled: false }, { localReview: false }, { captured: false }]) {
    const result = await runCheck({
      ...input, policy: { checksEnabled: false, repoAllowlist: [] },
      localInspector: { ...input.localInspector!, ...toggles },
    });
    assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
  }
});

test("Local Inspector blocks on denied Commands before claiming an execution or reviewing", async () => {
  const input = preflight();
  for (const { policy, reason } of [
    { policy: { checksEnabled: false, repoAllowlist: ["/fixture"] }, reason: /Workflow Commands are switched off/ },
    { policy: { checksEnabled: true, repoAllowlist: [] }, reason: /This repository is not on the workflow allowlist/ },
  ]) {
    const result = await runCheck({ ...input, policy,
      localInspector: { ...input.localInspector!, captured: true },
    });
    assert.equal(result.kind, "action_required");
    assert.equal(result.localInspector?.status, "blocked");
    assert.match(result.reason, reason);
  }
});

test("Local Inspector handles Block and Skip for exhaustion and returns a missing-artifact reservation", async () => {
  const input = preflight();
  const cap = { ...input, reserveRun: () => ({ granted: false, spent: 10 }) };
  const blocked = await runCheck(cap);
  assert.equal(blocked.kind, "action_required");
  const skipped = await runCheck({ ...cap, command: { ...input.command!, onBudgetExhausted: "skip" } });
  assert.equal(skipped.kind === "outcome" && skipped.outcome.status, "budget_spent");
  const finding = { ...major, path: "app.ts", fingerprint: "a".repeat(12) };
  const skipCommand = { ...input.command!, onBudgetExhausted: "skip" } as const;
  const knownBlocker = await runCheck({ ...cap, command: skipCommand,
    localInspector: { ...input.localInspector!, previous: () => [finding] },
  });
  assert.equal(knownBlocker.kind, "action_required");
  assert.match(knownBlocker.reason, /blocking findings remain unresolved/);
  assert.partialDeepStrictEqual(knownBlocker.localInspector, { status: "blocked", findingCount: 1 });
  const advisory = await runCheck({ ...cap, command: skipCommand,
    localInspector: { ...input.localInspector!, previous: () => [{ ...finding, severity: "minor" }] },
  });
  assert.equal(advisory.kind === "outcome" && advisory.outcome.status, "budget_spent");
  let released = 0;
  const missing = await runCheck({
    ...input, reserveRun: () => ({ granted: true, spent: 0, release: () => { released++; } }),
  });
  assert.equal(missing.kind === "action_required" && missing.localInspector?.status, "blocked");
  assert.equal(released, 1);
});

test("Local Inspector uses the pinned diff and carries findings, while an oversized patch or provider error blocks", async t => {
  const root = mkdtempSync(join(tmpdir(), "mission-local-inspector-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(root, "configuration"), "approved file before replacement\n");
  symlinkSync("configuration", join(root, "into-file"));
  writeFileSync(join(root, "into-link"), "original regular file\n");
  writeFileSync(join(root, "mode-only"), "contents stay the same\n");
  git("add", "configuration", "into-file", "into-link", "mode-only");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "app.ts"), "submitted code\n");
  writeFileSync(join(root, ".env"), "NEVER_IN_REVIEW_PROMPT");
  rmSync(join(root, "configuration"));
  mkdirSync(join(root, "configuration"));
  writeFileSync(join(root, "configuration", ".env"), "PRIVATE_CHILD_VALUE\n");
  writeFileSync(join(root, "configuration", "public settings"), "approved replacement child\u2028diff --git is file content\n");
  rmSync(join(root, "into-file"));
  writeFileSync(join(root, "into-file"), "replacement regular file\n");
  rmSync(join(root, "into-link"));
  symlinkSync("into-file", join(root, "into-link"));
  git("add", "-A");
  git("update-index", "--chmod=+x", "mode-only");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "submitted");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(root, "app.ts"), "post-capture content\n");

  const input = preflight();
  const previous = planLocalReview({ verdict: InspectorVerdictSchema.parse({ summary: "", findings: [major] }),
    changedPaths: new Set(["app.ts"]), previous: [], prompted: new Set(), blockingSeverity: "major" }).findings;
  let calls = 0;
  let releases = 0;
  const enabled: RunCheckInput = {
    ...input, cwd: root, repoRoot: root, headSha: head, policy: { checksEnabled: true, repoAllowlist: [root] },
    reserveRun: () => ({ granted: true, spent: 0, release: () => { releases++; } }),
    localInspector: {
      ...input.localInspector!, hasArtifact: () => true, goal: "Fix the workflow", round: 2,
      compare: async () => ({ head, mergeBase: base, baseRef: "origin/main", baseTip: base, empty: false, error: null }),
      previous: () => previous,
      review: async prompt => {
        calls++;
        assert.match(prompt, /<run-goal>\nFix the workflow\n<\/run-goal>/);
        assert.match(prompt, /\+submitted code/);
        assert.match(prompt, new RegExp(previous[0]!.fingerprint));
        assert.match(prompt, /-approved file before replacement/);
        assert.match(prompt, /\+approved replacement child/);
        assert.match(prompt, /diff --git a\/into-file b\/into-file\ndeleted file mode 120000/);
        assert.match(prompt, /\+replacement regular file/);
        assert.match(prompt, /-original regular file/);
        assert.match(prompt, /diff --git a\/into-link b\/into-link\nnew file mode 120000/);
        assert.match(prompt, /diff --git a\/mode-only b\/mode-only\nold mode 100644\nnew mode 100755/);
        assert.doesNotMatch(prompt, /NEVER_IN_REVIEW_PROMPT|PRIVATE_CHILD_VALUE|configuration\/\.env|post-capture content/);
        return JSON.stringify({ summary: "", resolved: [previous[0]!.fingerprint] });
      },
    },
  };
  const result = await runCheck(enabled);
  assert.equal(result.kind === "outcome" && result.outcome.status, "passed");
  assert.equal(calls, 1);
  const failure = await runCheck({ ...enabled, localInspector: { ...enabled.localInspector!,
    review: async () => { throw new Error("provider unavailable"); },
  } });
  assert.equal(failure.kind === "action_required" && failure.localInspector?.status, "blocked");

  await t.test("blocks when the resolved head differs from the submitted head and releases the reservation", async () => {
    const callsBefore = calls;
    const releasesBefore = releases;
    const result = await runCheck({ ...enabled, headSha: base });
    assert.equal(result.kind, "action_required");
    assert.equal(result.localInspector?.status, "blocked");
    assert.match(result.reason, /could not resolve the submitted comparison/);
    assert.equal(calls, callsBefore, "the mismatched head must block before provider review");
    assert.equal(releases, releasesBefore + 1);
  });

  await t.test("blocks when a valid finding cannot be retained", async () => {
    const before = releases;
    const result = await runCheck({ ...enabled, localInspector: { ...enabled.localInspector!,
      previous: () => [],
      review: async () => JSON.stringify({ summary: "An issue remains", findings: [major] }),
      retain: findings => {
        assert.deepEqual(findings.map(({ path, severity, title }) => ({ path, severity, title })), [
          { path: "app.ts", severity: major.severity, title: major.title },
        ]);
        return [];
      },
    } });
    assert.equal(result.kind, "action_required");
    assert.equal(result.localInspector?.status, "blocked");
    assert.match(result.reason, /Local Inspector findings could not be retained/);
    assert.equal(releases, before + 1);
  });

  await t.test("applies the Command severity and retains a minor finding on both pass and fail", async () => {
    const defaultCommand = emptyWorkflowCommandView("inspector");
    const cases = [
      { command: defaultCommand, threshold: "major", status: "passed" },
      { command: { ...defaultCommand, inspectorSeverity: "minor" }, threshold: "minor", status: "failed" },
    ] as const;
    const artifact: WorkflowCommandArtifactDescriptor = {
      id: "minor-finding", kind: "findings", captureState: "complete", availability: "retained",
      observedBytes: 128, retainedBytes: 128, droppedBytes: 0, sha256: null, unavailableReason: null,
    };
    for (const { command, threshold, status } of cases) {
      const retained: LocalInspectorFinding[] = [];
      const result = await runCheck({ ...enabled, command, localInspector: { ...enabled.localInspector!,
        previous: () => [],
        review: async () => JSON.stringify({ summary: "Advisory finding", findings: [minor] }),
        retain: findings => {
          retained.push(...findings);
          return [artifact];
        },
      } });
      assert.equal(result.kind, "outcome");
      assert.equal(result.outcome.status, status);
      assert.partialDeepStrictEqual(result.outcome.localInspector, { status, blockingSeverity: threshold, findingCount: 1 });
      assert.deepEqual(result.outcome.artifacts, [artifact]);
      assert.equal(retained.length, 1);
      assert.partialDeepStrictEqual(retained[0], { ...minor, path: "app.ts" });
    }
  });

  const prior = process.env.MISSION_INSPECTOR_MAX_DIFF_BYTES;
  t.after(() => { if (prior === undefined) delete process.env.MISSION_INSPECTOR_MAX_DIFF_BYTES; else process.env.MISSION_INSPECTOR_MAX_DIFF_BYTES = prior; });
  process.env.MISSION_INSPECTOR_MAX_DIFF_BYTES = "16";
  const oversized = await runCheck(enabled);
  assert.match(oversized.kind === "action_required" ? oversized.reason : "", /diff exceeds the Inspector byte cap/);
  assert.equal(calls, 1);
  assert.equal(releases, 4);
});

function preflight(): RunCheckInput {
  const unreachable = (): never => assert.fail("The stage must not dispatch");
  return {
    slot: "inspector", cwd: "/fixture", repoRoot: "/fixture", headSha: "b".repeat(40), publicationTreeOid: "c".repeat(40),
    command: emptyWorkflowCommandView("inspector"),
    policy: { checksEnabled: true, repoAllowlist: ["/fixture"] }, reserveRun: unreachable,
    localInspector: {
      preview: true, enabled: true, localReview: true, captured: undefined,
      hasArtifact: () => false, compare: async () => ({ head: "b".repeat(40), baseRef: "origin/main",
        baseTip: "a".repeat(40), mergeBase: "a".repeat(40), empty: false, error: null }),
      goal: "", round: 1, previous: () => [], review: unreachable, retain: () => [],
    },
  };
}
