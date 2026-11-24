import { lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { PersonaWorkloadResultSchema } from "@shared/repository-access.ts";
import { WORKFLOW_EXECUTION_LIMITS } from "@shared/workflow.ts";
import { ProviderFailure } from "../../llm/provider-failure.ts";
import { terminateCheckGroup, unwatchCheckGroup } from "../check-group.ts";
import { spawnCheckProcess, TailRing } from "../check-spawn.ts";
import type { WorkflowStore } from "../store.ts";
import type { WorkflowRepositoryArtifactService } from "../repository-artifact/service.ts";
import { RepositoryCapabilityError, type RepositoryProviderLaunch } from "./providers.ts";

export class LocalRepositoryWorkloadOwnership {
  constructor(private readonly store: WorkflowStore, private readonly authorized: (id: string) => boolean) {}

  recordHome(workloadId: string, path: string) {
    const stat = lstatSync(path, { bigint: true });
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !stat.isDirectory() || !/^mission-repository-workload-[a-zA-Z0-9]+$/.test(basename(path)))
      throw new Error("Unexpected repository workload home");
    const changed = this.store.transact(db => db.prepare(`UPDATE workflow_repository_local_owners
      SET home_path=?, home_dev=?, home_ino=? WHERE workload_id=? AND home_path IS NULL`)
      .run(realpathSync(path), String(stat.dev), String(stat.ino), workloadId));
    if (!changed.changes) throw new Error("Missing repository workload owner");
  }

  async runProvider(launch: RepositoryProviderLaunch, node: string, bundle: string) {
    const id = launch.request.workloadId;
    const reply = new TailRing(WORKFLOW_EXECUTION_LIMITS.verdictJsonBytes + 64 * 1024);
    const outcome = await spawnCheckProcess({
      attemptId: id, command: [node, bundle], cwd: launch.cwd, env: launch.env, signal: launch.signal,
      interruptionReason: "Repository reviewer was cancelled",
      timeoutMs: Math.max(1, launch.request.deadline - Date.now()),
      input: JSON.stringify({ request: launch.request, binary: launch.binary, mcp: launch.mcp }),
      maxOutputBytes: 0, capture: { push: (kind, chunk) => { if (kind === "stdout") reply.push(chunk); } },
      onSupervisorReady: ({ pid, identity }) => {
        this.store.transact(db => {
          if (!this.authorized(id) || Date.now() >= launch.request.deadline) throw new Error("Repository provider launch authorization expired");
          const changed = db.prepare(`UPDATE workflow_repository_local_owners SET group_pid=?, group_identity=?
            WHERE workload_id=? AND group_pid IS NULL AND lease_id IS NOT NULL`).run(pid, identity, id);
          if (!changed.changes) throw new Error("Repository workload lost ownership before provider launch");
        });
      },
    });
    if (outcome.emptiness !== "empty") throw new Error("Repository provider group cleanup is unconfirmed");
    const supervisor = outcome.supervisor;
    if (supervisor) this.clearEmptyGroup(id, supervisor.pid, supervisor.identity);
    const { text, truncatedBytes } = reply.read();
    if (truncatedBytes || outcome.result.kind !== "exited" || outcome.result.exitCode !== 0)
      throw new Error("Repository provider worker did not return a complete result");
    const result = PersonaWorkloadResultSchema.parse(JSON.parse(text));
    if (result.status === "completed") return { verdict: result.result.verdict, usage: result.usage ?? {} };
    if (result.code === "invalid_verdict") return { verdict: null, usage: result.usage ?? {} };
    if (result.providerFailure) throw new ProviderFailure(result.code, null, result.providerFailure);
    if (result.capabilityReason) throw new RepositoryCapabilityError(result.capabilityReason);
    throw new Error(result.code);
  }

  private clearEmptyGroup(id: string, pid: number, identity: string) {
    this.store.transact(db => db.prepare(`UPDATE workflow_repository_local_owners
      SET group_pid=NULL, group_identity=NULL WHERE workload_id=? AND group_pid=? AND group_identity=?`)
      .run(id, pid, identity));
  }

  /** A gated but never launched provider has no PID. Unknown identities and foreign directories stay held. */
  async confirmClosed(id: string, service: WorkflowRepositoryArtifactService) {
    const row = this.store.repositoryLocalOwner(id);
    if (!row) throw new Error("Missing repository workload cleanup record");
    if (row.group_pid !== null || row.group_identity !== null) {
      const pid = Number(row.group_pid);
      if (!Number.isSafeInteger(pid) || pid <= 1 || typeof row.group_identity !== "string" || !row.group_identity
          || await terminateCheckGroup(pid, row.group_identity) !== "empty")
        throw new Error("Repository provider group cleanup is unconfirmed");
      this.clearEmptyGroup(id, pid, row.group_identity);
      unwatchCheckGroup(pid);
    }
    if (row.lease_id !== null) await service.releaseLocalLease(String(row.lease_id), String(row.lease_nonce));
    if (row.home_path !== null) {
      const path = row.home_path;
      if (typeof path !== "string" || dirname(path) !== realpathSync(tmpdir()) || !/^mission-repository-workload-[a-zA-Z0-9]+$/.test(basename(path)))
        throw new Error("Invalid repository workload home");
      const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (stat) {
        if (!stat.isDirectory() || String(stat.dev) !== row.home_dev || String(stat.ino) !== row.home_ino)
          throw new Error("Repository workload home ownership changed");
        rmSync(path, { recursive: true });
      }
    }
  }
}
