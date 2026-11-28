import { z } from "zod";
import { RepositoryViewFieldsSchema } from "@shared/repository-access.ts";
import type { WorkflowStore } from "../store.ts";
import { workflowErrorCode, workflowLog } from "../log.ts";
import { digestSchema, sha256, type Manifest, unavailable } from "./format.ts";

const metadata = RepositoryViewFieldsSchema.omit({
  snapshotDigest: true,
  objectView: true,
  worktree: true,
  index: true,
}).extend({
  repository: digestSchema,
  pathsDigest: digestSchema,
  objectCount: z.int().nonnegative(),
  fileCount: z.int().positive(),
  byteCount: z.int().nonnegative(),
  allowed: z.int().nonnegative(),
  denied: z.int().nonnegative(),
});
export function summarize(m: Manifest) {
  const { worktree: _w, index: _i, ...view } = m.view;
  const allowed = m.paths.filter((p) => p.allowed).length;
  return metadata.parse({
    ...view,
    repository: m.repository,
    pathsDigest: sha256(JSON.stringify(m.paths)),
    objectCount: m.objects.length,
    fileCount: m.objects.length + 1,
    byteCount: m.objects.reduce(
      (s, o) => s + o.size + o.type.length + String(o.size).length + 2,
      Buffer.byteLength(JSON.stringify(m)),
    ),
    allowed,
    denied: m.paths.length - allowed,
  });
}
const artifact = z.strictObject({
  digest: digestSchema,
  locator: z.string(),
  state: z.enum(["creating", "ready", "cleanup_pending", "failed"]),
  created_at: z.int(),
  verification_error: z.string().nullable(),
  verified_at: z.int().nullable(),
  cleanup_requested_at: z.int().nullable(),
  cleanup_attempted_at: z.int().nullable(),
  cleanup_error: z.string().nullable(),
  metadata_json: z.string().transform((v) => metadata.parse(JSON.parse(v))),
});
const claim = z.strictObject({
  submission_id: z.string(),
  digest: digestSchema,
  state: z.enum(["provisional", "active", "release_pending", "released"]),
  created_at: z.int(),
  activated_at: z.int().nullable(),
  released_at: z.int().nullable(),
});
const artifactDomain = artifact.transform((row) => ({
  ...row.metadata_json,
  digest: row.digest,
  locator: row.locator,
  state: row.state,
  createdAt: row.created_at,
  verifiedAt: row.verified_at,
  verificationError: row.verification_error,
  cleanupRequestedAt: row.cleanup_requested_at,
  cleanupAttemptedAt: row.cleanup_attempted_at,
  cleanupError: row.cleanup_error,
}));
export type WorkflowRepositoryArtifact = z.infer<typeof artifactDomain>;
export type WorkflowRepositorySnapshotClaim = z.infer<typeof claim>;
export type WorkflowRepositorySnapshot = {
  submissionId: string;
  digest: string;
  locator: string;
  artifact: WorkflowRepositoryArtifact;
  claim: WorkflowRepositorySnapshotClaim;
};
export const locatorFor = (digest: string) => `repository-v1-${digestSchema.parse(digest)}`;

export class RepositoryOwnership {
  constructor(private store: WorkflowStore) {}
  recordLocalLease(workloadId: string, leaseId: string, nonce: string) {
    this.store.transact(db => {
      if (!db.prepare("SELECT 1 FROM workflow_repository_local_owners WHERE workload_id=?").get(workloadId)) return;
      if (!db.prepare("UPDATE workflow_repository_local_owners SET lease_id=?, lease_nonce=? WHERE workload_id=? AND lease_id IS NULL")
        .run(leaseId, nonce, workloadId).changes) unavailable();
    });
  }
  localLease(leaseId: string) {
    return this.store.transact(db => db.prepare("SELECT group_pid FROM workflow_repository_local_owners WHERE lease_id=?").get(leaseId));
  }
  attach(submissionId: string, digest: string, manifest: Manifest, publish: () => void) {
    return this.store.transact((db) => {
      if (
        !db.prepare("SELECT 1 FROM workflow_submissions WHERE id=? AND status='capturing'").get(submissionId)
      )
        unavailable();
      const now = Date.now(),
        locator = locatorFor(digest);
      // Startup can release a pre-activation claim while another holder keeps its
      // digest alive. Retire that record before restoring readiness on the new claim.
      db.prepare("DELETE FROM workflow_repository_snapshot_claims WHERE submission_id=? AND state='released'")
        .run(submissionId);
      db.prepare(
        `INSERT INTO workflow_repository_artifacts
        (digest,locator,state,metadata_json,created_at,verified_at) VALUES(?,?,'ready',?,?,?)
        ON CONFLICT(digest) DO UPDATE SET state='ready', verified_at=excluded.verified_at,
          cleanup_requested_at=NULL, cleanup_attempted_at=NULL, cleanup_error=NULL, verification_error=NULL`,
      ).run(digest, locator, JSON.stringify(summarize(manifest)), now, now);
      const previous = db
        .prepare("SELECT * FROM workflow_repository_snapshot_claims WHERE submission_id=?")
        .get(submissionId);
      if (previous) {
        if (previous.digest !== digest || previous.state !== "provisional") unavailable();
      } else
        db.prepare(
          `INSERT INTO workflow_repository_snapshot_claims(submission_id,digest,state,created_at)
        VALUES(?,?,'provisional',?)`,
        ).run(submissionId, digest, now);
      publish();
      return { submissionId, digest, locator };
    });
  }
  active(submissionId: string): WorkflowRepositorySnapshot | null {
    return this.store.transact((db) => {
      const c = db
        .prepare("SELECT * FROM workflow_repository_snapshot_claims WHERE submission_id=? AND state='active'")
        .get(submissionId);
      if (!c) return null;
      const a = db
        .prepare("SELECT * FROM workflow_repository_artifacts WHERE digest=? AND state='ready'")
        .get(c.digest!);
      if (!a) return null;
      const ready = artifactDomain.parse(a);
      return {
        submissionId,
        digest: ready.digest,
        locator: ready.locator,
        artifact: ready,
        claim: claim.parse(c),
      };
    });
  }
  release(submissionId: string) {
    this.store.transact((db) =>
      db
        .prepare(
          `UPDATE workflow_repository_snapshot_claims SET state='released', released_at=?
      WHERE submission_id=? AND state!='released'`,
        )
        .run(Date.now(), submissionId),
    );
  }
  recoverProvisional() {
    this.store.transact((db) =>
      db
        .prepare(
          `UPDATE workflow_repository_snapshot_claims SET state='released',
      released_at=? WHERE state='release_pending' OR (state='provisional' AND NOT EXISTS
        (SELECT 1 FROM workflow_submissions s JOIN workflow_runs r ON r.id=s.run_id WHERE s.id=submission_id
          AND (s.status='waiting_for_evidence_readiness' OR (s.status='failed' AND r.current_phase='evidence_reconciliation_error')
               OR EXISTS (SELECT 1 FROM workflow_submissions child WHERE child.parent_submission_id=s.id AND child.refinement_reason='evidence_recovery'
                 AND (child.status='capturing' OR (child.status='failed' AND r.status='blocked' AND r.current_phase='capture_interrupted'))))))`,
        )
        .run(Date.now()),
    );
  }
  queueUnclaimed() {
    this.store.transact((db) =>
      db
        .prepare(
          `UPDATE workflow_repository_artifacts SET state='cleanup_pending',
      cleanup_requested_at=? WHERE state!='cleanup_pending' AND NOT EXISTS
      (SELECT 1 FROM workflow_repository_snapshot_claims c WHERE c.digest=workflow_repository_artifacts.digest
       AND c.state!='released')`,
        )
        .run(Date.now()),
    );
  }
  hasArtifact(digest: string) {
    return this.store.transact((db) =>
      Boolean(db.prepare("SELECT 1 FROM workflow_repository_artifacts WHERE digest=?").get(digest)),
    );
  }
  artifacts() {
    return this.store.transact((db) =>
      db
        .prepare("SELECT * FROM workflow_repository_artifacts")
        .all()
        .map((row) => artifactDomain.parse(row)),
    );
  }
  verified(digest: string) {
    this.store.transact((db) =>
      db
        .prepare(
          "UPDATE workflow_repository_artifacts SET state='ready', verified_at=?, verification_error=NULL WHERE digest=? AND state IN ('ready','failed')",
        )
        .run(Date.now(), digest),
    );
  }
  unavailable(digest: string | null) {
    this.store.transact((db) => {
      const update = "UPDATE workflow_repository_artifacts SET state='failed', verification_error='artifact_unavailable' WHERE state='ready'";
      if (digest === null) db.prepare(update).run();
      else db.prepare(update + " AND digest=?").run(digest);
    });
  }
  cleanup(digest: string, remove: () => void) {
    return this.store.transact((db) => {
      if (
        db
          .prepare("SELECT 1 FROM workflow_repository_snapshot_claims WHERE digest=? AND state!='released'")
          .get(digest)
      )
        return false;
      try {
        remove();
      } catch (error) {
        workflowLog("warn", { event: "repository_digest_cleanup", error: workflowErrorCode(error) });
        db.prepare(
          `UPDATE workflow_repository_artifacts SET state='cleanup_pending',cleanup_attempted_at=?,
          cleanup_error='deletion_failed' WHERE digest=?`,
        ).run(Date.now(), digest);
        return false;
      }
      db.prepare("DELETE FROM workflow_repository_snapshot_claims WHERE digest=? AND state='released'").run(
        digest,
      );
      db.prepare("DELETE FROM workflow_repository_artifacts WHERE digest=?").run(digest);
      return true;
    });
  }
  status() {
    return this.store.transact((db) =>
      db
        .prepare(
          `SELECT
      (SELECT count(*) FROM workflow_repository_snapshot_claims WHERE state='active') AS active,
      count(*) FILTER(WHERE state='cleanup_pending') AS cleanup,
      coalesce(sum(json_extract(metadata_json,'$.byteCount')),0) AS bytes FROM workflow_repository_artifacts`,
        )
        .get(),
    );
  }
}
