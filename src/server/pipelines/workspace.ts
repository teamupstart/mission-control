import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type {
  PipelineCommission,
  PipelineCommissionAttempt,
  PipelineRun,
  PipelineWorkspaceCapabilities,
  PipelineWorkspaceReason,
  PipelineWorkspaceView,
} from "@shared/pipeline.ts";
import type { Task } from "@shared/types.ts";
import {
  advancePipelineCommissionEvidence,
  getPipelineCommission,
} from "../db.ts";
import { readEngineerRunMarkerAsync } from "./conductor/state.ts";
import { run } from "../util/exec.ts";

const NONE: PipelineWorkspaceCapabilities = {
  diff: false,
  files: false,
  write: false,
  comment: false,
  shell: false,
  externalOpen: false,
  manualWorkflow: false,
};
const READ_ONLY: PipelineWorkspaceCapabilities = { ...NONE, diff: true, files: true };
const LIVE: PipelineWorkspaceCapabilities = {
  diff: true,
  files: true,
  write: true,
  comment: true,
  shell: true,
  externalOpen: true,
  manualWorkflow: true,
};

export interface PipelineWorkspaceResolution {
  view: PipelineWorkspaceView;
  liveRoot: string | null;
  commission: PipelineCommission;
}

/** Cheap, fail-closed projection used while asynchronous identity validation is pending. */
export function projectPipelineWorkspace(input: {
  task: Pick<Task, "pipelineWorkspacePath">;
  commission: PipelineCommission;
  linkedRun: PipelineRun | null;
}): PipelineWorkspaceResolution {
  const active = activeAttempt(input.commission);
  const attempt = active ?? {
    attempt: input.commission.activeAttempt ?? 0,
    origin: "mission_control" as const,
    launchKey: "",
    engineerRunId: null,
    previousEngineerRunId: null,
    providerRevision: 0,
    state: "failed" as const,
    terminalReason: null,
    evidenceCommit: null,
    evidenceCommitProvenance: null,
    evidenceFrozenAt: null,
    updatedAt: input.commission.updatedAt,
  };
  const implementationPath = input.linkedRun?.worktree ?? null;
  const reportedPath = implementationPath ?? input.commission.authoringWorktree ??
    input.task.pipelineWorkspacePath ?? null;
  if (!active || input.commission.lifecycle === "unsupported") {
    return {
      view: view(input.commission, attempt, {
        kind: implementationPath ? "implementation" : "authoring",
        availability: "missing",
        reportedPath,
        branch: implementationPath ? null : input.commission.authoringBranch,
        reason: active ? "identity_conflict" : "unsupported_attempt",
        capabilities: NONE,
      }),
      liveRoot: null,
      commission: input.commission,
    };
  }
  return {
    view: view(input.commission, attempt, {
      kind: implementationPath ? "implementation" : "authoring",
      availability: "pending",
      reportedPath,
      branch: implementationPath ? null : input.commission.authoringBranch,
      reason: "provider_pending",
      capabilities: NONE,
    }),
    liveRoot: null,
    commission: input.commission,
  };
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await run("git", ["-C", cwd, ...args], {
    timeoutMs: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.code === 0 && !result.overflowed,
    stdout: result.stdout.trim(),
  };
}

async function commitAt(repoRoot: string, revision: string): Promise<string | null> {
  if (!revision || revision.startsWith("-") || revision.includes("\0")) return null;
  const resolved = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(resolved.stdout)) return null;
  return resolved.stdout.toLowerCase();
}

async function objectExists(repoRoot: string, commit: string | null): Promise<boolean> {
  return commit !== null && await commitAt(repoRoot, commit) === commit.toLowerCase();
}

async function pathEntryExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

function activeAttempt(commission: PipelineCommission): PipelineCommissionAttempt | null {
  return commission.attempts.find((attempt) => attempt.attempt === commission.activeAttempt) ?? null;
}

function view(
  commission: PipelineCommission,
  attempt: PipelineCommissionAttempt,
  input: {
    kind: "authoring" | "implementation";
    availability: PipelineWorkspaceView["availability"];
    reportedPath: string | null;
    branch: string | null;
    reason: PipelineWorkspaceReason | null;
    capabilities: PipelineWorkspaceCapabilities;
  },
): PipelineWorkspaceView {
  return {
    authority: "provider",
    kind: input.kind,
    availability: input.availability,
    reportedPath: input.reportedPath,
    branch: input.branch,
    commit: attempt.evidenceCommit,
    commitProvenance: attempt.evidenceCommitProvenance,
    commitFrozenAt: attempt.evidenceFrozenAt,
    planSlug: commission.planSlug,
    attempt: attempt.attempt,
    providerRevision: attempt.providerRevision,
    reason: input.reason,
    capabilities: input.capabilities,
  };
}

function latest(commission: PipelineCommission): PipelineCommission {
  return getPipelineCommission(commission.id) ?? commission;
}

async function recordLiveCommit(
  commission: PipelineCommission,
  attempt: PipelineCommissionAttempt,
  commit: string,
): Promise<PipelineCommission | null> {
  if (attempt.evidenceFrozenAt !== null) {
    return attempt.evidenceCommit === commit ? commission : null;
  }
  if (attempt.evidenceCommit === commit) return commission;
  if (attempt.evidenceCommit) {
    const ancestor = await git(commission.repoRoot, [
      "merge-base",
      "--is-ancestor",
      attempt.evidenceCommit,
      commit,
    ]);
    if (!ancestor.ok) return null;
  }
  const outcome = advancePipelineCommissionEvidence({
    commissionId: commission.id,
    attempt: attempt.attempt,
    previousCommit: attempt.evidenceCommit,
    commit,
    provenance: "live_validation",
  });
  if (outcome === "stored") return latest(commission);
  const refreshed = latest(commission);
  const refreshedAttempt = activeAttempt(refreshed);
  if (!refreshedAttempt) return null;
  if (refreshedAttempt.evidenceCommit === commit) return refreshed;
  if (refreshedAttempt.evidenceFrozenAt !== null || !refreshedAttempt.evidenceCommit) return null;
  if (!(await git(refreshed.repoRoot, [
    "merge-base",
    "--is-ancestor",
    refreshedAttempt.evidenceCommit,
    commit,
  ])).ok) return null;
  const retried = advancePipelineCommissionEvidence({
    commissionId: refreshed.id,
    attempt: refreshedAttempt.attempt,
    previousCommit: refreshedAttempt.evidenceCommit,
    commit,
    provenance: "live_validation",
  });
  return retried === "stored" ? latest(refreshed) : null;
}

async function freezeLegacyBranch(
  commission: PipelineCommission,
  attempt: PipelineCommissionAttempt,
): Promise<PipelineCommission> {
  if (attempt.evidenceCommit !== null || attempt.evidenceFrozenAt !== null) return commission;
  if (!commission.authoringBranch) return commission;
  const commit = await commitAt(commission.repoRoot, commission.authoringBranch);
  if (!commit) return commission;
  advancePipelineCommissionEvidence({
    commissionId: commission.id,
    attempt: attempt.attempt,
    previousCommit: null,
    commit,
    provenance: "legacy_branch_resolution",
    frozenAt: Date.now(),
  });
  return latest(commission);
}

async function validateLive(
  commission: PipelineCommission,
  attempt: PipelineCommissionAttempt,
  reportedPath: string,
  expectedBranch: string | null,
): Promise<
  | { ok: true; root: string; branch: string; commit: string }
  | { ok: false; reason: "missing" | "invalid_worktree" | "identity_conflict" }
> {
  if (!isAbsolute(reportedPath)) return { ok: false, reason: "identity_conflict" };
  let root: string;
  let repoRoot: string;
  let worktreesRoot: string;
  try {
    root = await realpath(reportedPath);
    repoRoot = await realpath(commission.repoRoot);
    worktreesRoot = await realpath(join(repoRoot, ".worktrees"));
  } catch {
    return { ok: false, reason: await pathEntryExists(reportedPath) ? "invalid_worktree" : "missing" };
  }
  // Provider event paths and MCP-reported paths reach the same authority boundary. A
  // matching Git common directory alone is insufficient: it would also accept the main
  // checkout or an unrelated linked worktree and grant writes and shell access there.
  if (dirname(root) !== worktreesRoot) return { ok: false, reason: "identity_conflict" };
  const [top, common, branch, head] = await Promise.all([
    git(root, ["rev-parse", "--show-toplevel"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    commitAt(root, "HEAD"),
  ]);
  try {
    if (
      !top.ok || !common.ok || !branch.ok || !head
    ) return { ok: false, reason: "invalid_worktree" };
    if (
      await realpath(top.stdout) !== root ||
      await realpath(dirname(common.stdout)) !== repoRoot ||
      (expectedBranch !== null && branch.stdout !== expectedBranch)
    ) return { ok: false, reason: "identity_conflict" };
  } catch {
    return { ok: false, reason: "invalid_worktree" };
  }
  const marker = await readEngineerRunMarkerAsync(root);
  if (marker) {
    try {
      if (
        (attempt.engineerRunId !== null && marker.engineerRunId !== attempt.engineerRunId) ||
        await realpath(marker.repoRoot) !== repoRoot ||
        (commission.planSlug !== null && marker.planSlug !== commission.planSlug) ||
        (expectedBranch !== null && marker.branch !== expectedBranch)
      ) return { ok: false, reason: "identity_conflict" };
    } catch {
      return { ok: false, reason: "identity_conflict" };
    }
  }
  if (attempt.evidenceCommit && attempt.evidenceCommit !== head) {
    if (attempt.evidenceFrozenAt !== null) return { ok: false, reason: "identity_conflict" };
    if (!(await git(repoRoot, ["merge-base", "--is-ancestor", attempt.evidenceCommit, head])).ok) {
      return { ok: false, reason: "identity_conflict" };
    }
  }
  return { ok: true, root, branch: branch.stdout, commit: head };
}

/** Resolve the only workspace identity a managed Pipeline session may expose or act on. */
export async function resolvePipelineWorkspace(input: {
  task: Pick<Task, "pipelineWorkspacePath">;
  commission: PipelineCommission;
  linkedRun: PipelineRun | null;
}): Promise<PipelineWorkspaceResolution> {
  let commission = input.commission;
  let attempt = activeAttempt(commission);
  if (!attempt) {
    const synthetic: PipelineCommissionAttempt = {
      attempt: commission.activeAttempt ?? 0,
      origin: "mission_control",
      launchKey: "",
      engineerRunId: null,
      previousEngineerRunId: null,
      providerRevision: 0,
      state: "failed",
      terminalReason: null,
      evidenceCommit: null,
      evidenceCommitProvenance: null,
      evidenceFrozenAt: null,
      updatedAt: commission.updatedAt,
    };
    return {
      view: view(commission, synthetic, {
        kind: "authoring",
        availability: "missing",
        reportedPath: commission.authoringWorktree ?? input.task.pipelineWorkspacePath ?? null,
        branch: commission.authoringBranch,
        reason: "unsupported_attempt",
        capabilities: NONE,
      }),
      liveRoot: null,
      commission,
    };
  }

  const implementationPath = input.linkedRun?.worktree ?? null;
  const authoringPath = commission.authoringWorktree ?? input.task.pipelineWorkspacePath ?? null;
  const kind = implementationPath ? "implementation" : "authoring";
  const reportedPath = implementationPath ?? authoringPath;
  const expectedBranch = kind === "authoring" ? commission.authoringBranch : null;
  if (commission.lifecycle === "unsupported") {
    const evidenceAvailable = await objectExists(commission.repoRoot, attempt.evidenceCommit);
    return {
      view: view(commission, attempt, {
        kind,
        availability: "missing",
        reportedPath,
        branch: expectedBranch,
        reason: "identity_conflict",
        capabilities: evidenceAvailable ? READ_ONLY : NONE,
      }),
      liveRoot: null,
      commission,
    };
  }
  let liveFailure: "missing" | "invalid_worktree" | "identity_conflict" | null = null;
  if (reportedPath) {
    const validated = await validateLive(
      commission,
      attempt,
      reportedPath,
      expectedBranch,
    );
    if (validated.ok) {
      const recorded = await recordLiveCommit(commission, attempt, validated.commit);
      if (recorded) {
        commission = recorded;
        attempt = activeAttempt(commission) ?? attempt;
        return {
          view: view(commission, attempt, {
            kind,
            availability: "available",
            reportedPath: validated.root,
            branch: validated.branch,
            reason: null,
            capabilities: LIVE,
          }),
          liveRoot: validated.root,
          commission,
        };
      }
      commission = latest(commission);
      attempt = activeAttempt(commission) ?? attempt;
    } else {
      liveFailure = validated.reason;
    }
  }

  if (!reportedPath && !commission.authoringBranch) {
    return {
      view: view(commission, attempt, {
        kind,
        availability: "pending",
        reportedPath: null,
        branch: null,
        reason: "provider_pending",
        capabilities: NONE,
      }),
      liveRoot: null,
      commission,
    };
  }

  const invalidExistingPath = reportedPath !== null && await pathEntryExists(reportedPath);
  if (!invalidExistingPath) commission = await freezeLegacyBranch(commission, attempt);
  attempt = activeAttempt(commission) ?? attempt;
  const evidenceAvailable = await objectExists(commission.repoRoot, attempt.evidenceCommit);
  return {
    view: view(commission, attempt, {
      kind,
      availability: "missing",
      reportedPath,
      branch: commission.authoringBranch,
      reason: liveFailure === "identity_conflict"
        ? "identity_conflict"
        : invalidExistingPath
          ? liveFailure === "invalid_worktree"
            ? "invalid_worktree"
            : "identity_conflict"
          : evidenceAvailable
            ? "worktree_missing"
            : "evidence_unavailable",
      capabilities: evidenceAvailable ? READ_ONLY : NONE,
    }),
    liveRoot: null,
    commission,
  };
}
