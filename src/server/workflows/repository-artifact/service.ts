import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { STATE_DIR } from "../../config.ts";
import { workflowErrorCode, workflowLog } from "../log.ts";
import type {
  RepositoryArtifactMaterializer,
  RepositoryMaterializationRequest,
  RepositoryViewLease,
} from "../persona-workload/contracts.ts";
import type { WorkflowStore } from "../store.ts";
import {
  descriptor,
  isArtifactIntegrityFailure,
  RepositoryCaptureChanged,
  oid,
  digestSchema,
  unavailable,
  verifyDirectory,
  type Manifest,
} from "./format.ts";
import { locatorFor, RepositoryOwnership } from "./ownership.ts";
import { seal, sampleCheckoutBoundary, type RepositoryCaptureInput } from "./seal.ts";
import { RepositoryArtifactStorage } from "./storage.ts";

export interface WorkflowRepositoryArtifactCandidate {
  readonly boundary: string;
  id: string;
  nonce: string;
  digest: string;
}
export interface WorkflowRepositoryProvisionalSnapshot {
  submissionId: string;
  digest: string;
  locator: string;
}
const markerSchema = z.strictObject({
  id: z.uuid(),
  nonce: z.uuid(),
  kind: z.enum(["pending", "leases"]),
  createdAt: z.int().positive(),
});
type Marker = z.infer<typeof markerSchema>;
type Namespace = Marker["kind"] | "digests";
type ActiveRequestLookup = (workloadId: string) => RepositoryMaterializationRequest | null;

function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Only flat artifact files may be removed or displaced, even in a digest directory we own.
function publishedFiles(path: string) {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) return null;
  const files = readdirSync(path);
  let bytes = 0;
  for (const file of files) {
    if (file !== "manifest.json" && !oid.safeParse(file).success) return null;
    const stat = lstatSync(join(path, file));
    if (!stat.isFile()) return null;
    bytes += stat.size;
  }
  return { files, bytes };
}

const cleanupTicket = /^([a-f0-9-]{36})\.(\d+)\.(\d+)\.cleanup$/;

function finishRemoval(parent: string, ticket: string) {
  const match = cleanupTicket.exec(ticket) ?? unavailable();
  const id = z.uuid().parse(match[1]);
  const proof = join(parent, ticket);
  const linked = lstatSync(proof, { bigint: true });
  if (!linked.isFile()) unavailable();
  const marker = markerSchema.parse(JSON.parse(readFileSync(proof, "utf8")));
  if (marker.id !== id || marker.kind !== basename(parent)) unavailable();
  const path = join(parent, id);
  const dir = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (dir) {
    if (!dir.isDirectory() || String(dir.dev) !== match[2] || String(dir.ino) !== match[3]) unavailable();
    const owner = join(path, "owner.json");
    const inside = lstatSync(owner, { bigint: true, throwIfNoEntry: false });
    if (inside) {
      if (inside.dev !== linked.dev || inside.ino !== linked.ino) unavailable();
      syncDirectory(parent);
      unlinkSync(owner);
    }
    rmdirSync(path);
  }
  syncDirectory(parent);
  unlinkSync(proof);
  return path;
}

function removeMarkedDirectory(path: string) {
  const owner = join(path, "owner.json");
  for (const name of readdirSync(path)) {
    if (name !== "owner.json") rmSync(join(path, name), { recursive: true });
  }
  // Keep a durable link to the marker outside the directory until its removal
  // is durable. The directory identity prevents a replay from removing a replacement.
  const dir = lstatSync(path, { bigint: true });
  const parent = dirname(path);
  const ticket = basename(path) + "." + dir.dev + "." + dir.ino + ".cleanup";
  syncDirectory(path);
  linkSync(owner, join(parent, ticket));
  finishRemoval(parent, ticket);
}

export class WorkflowRepositoryArtifactService implements RepositoryArtifactMaterializer {
  private static readonly services = new Map<string, WorkflowRepositoryArtifactService>();
  static forRoot(store: WorkflowStore, root = join(STATE_DIR, "workflow-repositories"), storage?: RepositoryArtifactStorage) {
    const path = resolve(root);
    const canonical = join(realpathSync(dirname(path)), basename(path));
    let service = this.services.get(canonical);
    if (!service) {
      service = new WorkflowRepositoryArtifactService(store, canonical, storage);
      this.services.set(canonical, service);
    }
    return service;
  }

  private readonly ownership: RepositoryOwnership;
  private readonly live = new Set<string>();
  private readonly candidates = new Map<string, WorkflowRepositoryArtifactCandidate>();
  private readonly checkouts = new WeakMap<WorkflowRepositoryArtifactCandidate, string>();
  private tail: Promise<void> = Promise.resolve();
  private started = false;
  private failures = 0;
  private activeRequest?: ActiveRequestLookup;

  private constructor(store: WorkflowStore, private readonly root: string, private readonly storage = new RepositoryArtifactStorage()) {
    this.ownership = new RepositoryOwnership(store);
  }

  /** Install or revoke the trusted supervisor's dispatch lookup on the daemon's existing service. */
  setActiveRequestLookup(lookup: ActiveRequestLookup | undefined) {
    this.activeRequest = lookup;
  }

  private exclusive<T>(fn: () => Promise<T>) {
    const next = this.tail.then(fn);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async measured<T>(event: string, fn: () => Promise<T>) {
    const start = Date.now();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RepositoryCaptureChanged) throw error;
      this.failures++;
      workflowLog("warn", { event, error: workflowErrorCode(error) });
      return unavailable();
    } finally {
      workflowLog("info", { event, duration_ms: Date.now() - start });
    }
  }
  private namespace(kind: Namespace): string;
  private namespace(kind: Namespace, create: false): string | undefined;
  private namespace(kind: Namespace, create = true) {
    const path = join(this.root, kind);
    for (const directory of [this.root, path]) {
      const containsDigests = directory === this.root || kind === "digests";
      try {
        const entry = lstatSync(directory, { throwIfNoEntry: false });
        if (!entry) {
          if (!create) return undefined;
          if (containsDigests) this.ownership.unavailable(null);
          mkdirSync(directory, { mode: 0o700 });
        } else if (!entry.isDirectory()) unavailable();
        if (realpathSync(directory) !== directory) unavailable();
      } catch (error) {
        if (containsDigests && isArtifactIntegrityFailure(error)) this.ownership.unavailable(null);
        throw error;
      }
    }
    return path;
  }
  private syncAllocationPath(path: string) {
    syncDirectory(path);
    syncDirectory(dirname(path));
    syncDirectory(this.root);
    syncDirectory(dirname(this.root));
  }
  private syncDigestParent(namespace: string | undefined) {
    syncDirectory(namespace ?? (existsSync(this.root) ? this.root : dirname(this.root)));
  }
  private allocate(kind: Marker["kind"]) {
    const marker: Marker = { kind, id: randomUUID(), nonce: randomUUID(), createdAt: Date.now() };
    const path = join(this.namespace(kind), marker.id);
    mkdirSync(path, { mode: 0o700 });
    try {
      writeFileSync(join(path, "owner.tmp"), JSON.stringify(marker), { flag: "wx", mode: 0o600, flush: true });
      renameSync(join(path, "owner.tmp"), join(path, "owner.json"));
      this.syncAllocationPath(path);
    } catch (error) {
      // This call created the directory exclusively and has not handed it to anyone.
      try {
        rmSync(path, { recursive: true });
      } catch (cleanupError) {
        workflowLog("warn", { event: "repository_allocation_cleanup", error: workflowErrorCode(cleanupError) });
      }
      throw error;
    }
    this.live.add(marker.id);
    return { marker, path };
  }
  private marked(kind: Marker["kind"], id: string, nonce?: string) {
    const path = join(this.namespace(kind), z.uuid().parse(id));
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) unavailable();
    const owner = join(path, "owner.json");
    if (!lstatSync(owner).isFile()) unavailable();
    const marker = markerSchema.parse(JSON.parse(readFileSync(owner, "utf8")));
    if (marker.id !== id || marker.kind !== kind || (nonce && nonce !== marker.nonce)) unavailable();
    return path;
  }
  private forget(id: string) {
    this.live.delete(id);
    this.candidates.delete(id);
  }
  private remove(kind: Marker["kind"], id: string, nonce: string) {
    this.forget(id);
    this.removeDirectory(this.marked(kind, id, nonce));
  }
  private removeDirectory(path: string) {
    removeMarkedDirectory(path);
    this.storage.release(path);
  }
  private abandon(marker: Pick<Marker, "kind" | "id" | "nonce">) {
    try {
      this.remove(marker.kind, marker.id, marker.nonce);
    } catch (error) {
      workflowLog("warn", { event: marker.kind === "pending" ? "repository_pending_cleanup" : "repository_lease_cleanup",
        error: workflowErrorCode(error) });
    }
  }
  async prepare(
    input: RepositoryCaptureInput,
    signal: AbortSignal,
  ): Promise<WorkflowRepositoryArtifactCandidate> {
    return this.measured("repository_seal", async () => {
      await this.start();
      signal.throwIfAborted();
      const { marker, path } = this.allocate("pending");
      try {
        const { digest, boundary } = await seal(input, path, signal, { storage: this.storage });
        const candidate = Object.freeze({ id: marker.id, nonce: marker.nonce, digest, boundary });
        this.candidates.set(marker.id, candidate);
        this.checkouts.set(candidate, input.checkout);
        return candidate;
      } catch (error) {
        this.abandon(marker);
        throw error;
      }
    });
  }
  sampleBoundary(checkout: string, signal: AbortSignal) {
    return this.measured("repository_boundary", () => sampleCheckoutBoundary(checkout, signal, { storage: this.storage }));
  }
  async stillCurrent(candidate: WorkflowRepositoryArtifactCandidate, signal: AbortSignal) {
    const checkout = this.checkouts.get(candidate);
    if (!checkout || this.candidates.get(candidate.id) !== candidate) return false;
    try {
      return await this.sampleBoundary(checkout, signal) === candidate.boundary;
    } catch (error) {
      if (error instanceof RepositoryCaptureChanged) return false;
      throw error;
    }
  }
  private async preparePublication(pending: string, digest: string) {
    const src = join(pending, "artifact");
    const dest = join(this.namespace("digests"), digestSchema.parse(digest));
    const existing = lstatSync(dest, { throwIfNoEntry: false });
    const signal = AbortSignal.timeout(600_000);
    let manifest: Manifest;
    let displacedBytes: number | undefined;
    try {
      manifest = await verifyDirectory(existing ? dest : src, digest, signal, { syncFiles: true });
    } catch (error) {
      if (!existing || signal.aborted || !isArtifactIntegrityFailure(error) || !this.ownership.hasArtifact(digest))
        throw error;
      this.ownership.unavailable(digest);
      // Refuse an unknown layout before the caller records a replacement intent.
      if (lstatSync(join(pending, "previous"), { throwIfNoEntry: false })) unavailable();
      displacedBytes = (publishedFiles(dest) ?? unavailable()).bytes;
      manifest = await verifyDirectory(src, digest, signal, { syncFiles: true });
    }
    syncDirectory(existing && displacedBytes === undefined ? dest : src);
    if (displacedBytes !== undefined) this.storage.trackDisplaced(pending, displacedBytes);
    const syncRename = () => {
      syncDirectory(pending);
      syncDirectory(dirname(dest));
    };
    const publish = () => {
      // Persist both sides of the recovery path before the first rename. This
      // also covers a digest namespace recreated while replaying an older intent.
      this.syncAllocationPath(pending);
      if (displacedBytes !== undefined) {
        const previous = join(pending, "previous");
        this.storage.trackDisplaced(pending, (publishedFiles(dest) ?? unavailable()).bytes);
        try {
          renameSync(dest, previous);
        } catch (error) {
          this.storage.trackDisplaced(pending, 0);
          throw error;
        }
        syncRename();
        try {
          renameSync(src, dest);
        } catch (error) {
          renameSync(previous, dest);
          this.storage.trackDisplaced(pending, 0);
          syncRename();
          throw error;
        }
      } else if (!existing) renameSync(src, dest);
      // A new claim commits only after this callback. Recovery performs the
      // same sync before it restores the existing holders to ready.
      syncRename();
    };
    return { manifest, publish };
  }
  private async recoverPromotion(pending: string) {
    const intent = join(pending, "promotion");
    if (!existsSync(intent)) return;
    if (!lstatSync(intent).isFile()) unavailable();
    const digest = digestSchema.parse(readFileSync(intent, "utf8"));
    if (this.ownership.hasArtifact(digest)) {
      const namespace = this.namespace("digests", false);
      const dest = namespace && join(namespace, digest);
      // An earlier writer could record an intent before discovering foreign entries.
      // The untouched candidate and absence of a displaced directory prove no swap began.
      if (dest && lstatSync(dest, { throwIfNoEntry: false }) && existsSync(join(pending, "artifact")) &&
          !existsSync(join(pending, "previous")) && !publishedFiles(dest)) {
        this.ownership.unavailable(digest);
        return;
      }
      // The intent precedes publication. Replaying it verifies whichever copy
      // survived, including when a missing directory left no "previous" backup.
      // Only the original transaction can attach the incoming submission.
      const { publish } = await this.preparePublication(pending, digest);
      publish();
      this.ownership.verified(digest);
      return;
    }
    const root = this.namespace("digests", false);
    if (!root || !existsSync(join(root, digest))) {
      this.syncDigestParent(root);
      return;
    }
    const path = join(root, digest);
    if (existsSync(join(pending, "artifact"))) return;
    await verifyDirectory(path, digest, AbortSignal.timeout(600_000));
    if (!this.ownership.cleanup(digest, () => {
      this.storage.reclaimPublished(pending, (publishedFiles(path) ?? unavailable()).bytes,
        () => renameSync(path, join(pending, "artifact")));
      syncDirectory(pending);
      this.syncDigestParent(root);
    })) unavailable();
  }
  async discard(candidate: WorkflowRepositoryArtifactCandidate) {
    await this.exclusive(async () => {
      if (this.candidates.get(candidate.id) !== candidate) return;
      this.forget(candidate.id);
      const path = this.marked("pending", candidate.id, candidate.nonce);
      await this.recoverPromotion(path);
      this.removeDirectory(path);
    });
  }
  promote(
    candidate: WorkflowRepositoryArtifactCandidate,
    submissionId: string,
  ): Promise<WorkflowRepositoryProvisionalSnapshot> {
    return this.exclusive(() =>
      this.measured("repository_promote", async () => {
        if (this.candidates.get(candidate.id) !== candidate) unavailable();
        const pending = this.marked("pending", candidate.id, candidate.nonce);
        const { manifest, publish } = await this.preparePublication(pending, candidate.digest);
        writeFileSync(join(pending, "promotion.tmp"), candidate.digest, { mode: 0o600, flush: true });
        renameSync(join(pending, "promotion.tmp"), join(pending, "promotion"));
        const snapshot = this.ownership.attach(submissionId, candidate.digest, manifest, publish);
        this.abandon({ kind: "pending", id: candidate.id, nonce: candidate.nonce });
        return snapshot;
      }),
    );
  }
  private checkClaim(snapshot: WorkflowRepositoryProvisionalSnapshot) {
    const active = this.ownership.active(snapshot.submissionId);
    if (
      !active ||
      active.artifact.digest !== snapshot.digest ||
      active.artifact.locator !== snapshot.locator ||
      snapshot.locator !== locatorFor(snapshot.digest)
    )
      unavailable();
  }
  private checkRequest(request: RepositoryMaterializationRequest) {
    const active = this.activeRequest?.(request.workloadId);
    if (
      !active ||
      (["submissionId", "workloadId", "attemptId", "digest", "locator"] as const).some(
        (key) => !request[key] || active[key] !== request[key],
      )
    )
      unavailable();
    this.checkClaim(request);
  }
  private verifyPublished(digest: string, signal: AbortSignal, lease?: string) {
    signal.throwIfAborted();
    const root = this.namespace("digests", false);
    if (!root) {
      this.ownership.unavailable(null);
      return unavailable();
    }
    return verifyDirectory(join(root, digest), digest, signal, {
      lease: lease ? { root: lease, storage: this.storage } : undefined,
      onIntegrityFailure: () => this.ownership.unavailable(digest),
    });
  }
  verify(snapshot: WorkflowRepositoryProvisionalSnapshot, signal: AbortSignal) {
    return this.exclusive(() =>
      this.measured("repository_verify", async () => {
        this.checkClaim(snapshot);
        const manifest = await this.verifyPublished(snapshot.digest, signal);
        this.checkClaim(snapshot);
        this.ownership.verified(snapshot.digest);
        return { digest: snapshot.digest, objectCount: manifest.objects.length };
      }),
    );
  }
  materialize(request: RepositoryMaterializationRequest, signal: AbortSignal): Promise<RepositoryViewLease> {
    const identity = Object.freeze({ ...request });
    return this.measured("repository_materialize", async () => {
      if (!this.started) {
        this.checkRequest(identity);
        signal.throwIfAborted();
        await this.start();
      }
      return this.exclusive(async () => {
        this.checkRequest(identity);
        signal.throwIfAborted();
        const { marker, path } = this.allocate("leases");
        try {
          this.ownership.recordLocalLease(identity.workloadId, marker.id, marker.nonce);
          const manifest = await this.verifyPublished(identity.digest, signal, path);
          this.checkRequest(identity);
          this.ownership.verified(identity.digest);
          return {
            identity,
            descriptor: descriptor(manifest, identity.digest, marker.id),
            objectDirectory: path,
            release: async () => {
              if (this.ownership.localLease(marker.id)?.group_pid != null) unavailable();
              if (this.live.has(marker.id)) this.remove("leases", marker.id, marker.nonce);
            },
          };
        } catch (error) {
          this.abandon(marker);
          throw error;
        }
      });
    });
  }
  async release(submissionId: string) {
    this.ownership.release(submissionId);
  }
  /** The local supervisor proved the process group empty. Remove only its recorded lease. */
  releaseLocalLease(id: string, nonce: string) {
    return this.exclusive(async () => {
      z.uuid().parse(id);
      z.uuid().parse(nonce);
      const dir = this.namespace("leases", false);
      if (!dir) {
        this.storage.release(join(this.root, "leases", id));
        this.forget(id);
        return;
      }
      const ticket = readdirSync(dir).find(name => cleanupTicket.exec(name)?.[1] === id);
      if (ticket) {
        const proof = join(dir, ticket);
        if (!lstatSync(proof).isFile() || markerSchema.parse(JSON.parse(readFileSync(proof, "utf8"))).nonce !== nonce) unavailable();
        this.storage.release(finishRemoval(dir, ticket));
        this.forget(id);
      } else if (lstatSync(join(dir, id), { throwIfNoEntry: false })) {
        this.remove("leases", id, nonce);
      } else {
        this.storage.release(join(dir, id));
        this.forget(id);
      }
      syncDirectory(dir);
    });
  }
  activeSnapshot(submissionId: string) {
    return this.ownership.active(submissionId);
  }
  artifacts() {
    return this.ownership.artifacts();
  }
  status() {
    return { ...this.ownership.status(), failuresByCode: { artifact_unavailable: this.failures } };
  }

  private async start() {
    if (!this.started) await this.reconcile();
  }
  private async accountRetainedLease(directory: string, id: string, ticket?: RegExpExecArray) {
    const path = join(directory, id);
    try {
      if (ticket) {
        const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (!stat) {
          this.storage.release(path);
          return true;
        }
        if (!stat.isDirectory() || String(stat.dev) !== ticket[2] || String(stat.ino) !== ticket[3]) unavailable();
      } else this.marked("leases", id);
      await this.storage.restoreAbandoned(path, "leases");
      return true;
    } catch (error) {
      this.storage.reserveUnmeasured(path);
      workflowLog("warn", { event: "repository_orphan_accounting", error: workflowErrorCode(error) });
      return false;
    }
  }

  reconcile() {
    return this.exclusive(async () => {
      let deleted = 0,
        orphans = 0;
      const promotions: string[] = [];
      const cleanupFailed = async (error: unknown, owned: string | undefined, kind: "pending" | "leases") => {
        workflowLog("warn", { event: "repository_orphan_cleanup", error: workflowErrorCode(error) });
        if (owned) {
          try { await this.storage.restoreAbandoned(owned, kind); }
          catch (sizeError) {
            workflowLog("warn", { event: "repository_orphan_accounting", error: workflowErrorCode(sizeError) });
          }
        }
        orphans++;
      };
      if (!this.started) this.ownership.recoverProvisional();
      for (const kind of ["pending", "leases"] as const) {
        const directory = this.namespace(kind, false);
        if (!directory) continue;
        const names = readdirSync(directory);
        const removing = new Set<string>();
        for (const name of names) {
          const ticket = cleanupTicket.exec(name);
          if (!ticket) continue;
          removing.add(ticket[1]!);
          if (kind === "leases" && this.ownership.localLease(ticket[1]!)) {
            if (!await this.accountRetainedLease(directory, ticket[1]!, ticket)) orphans++;
            continue;
          }
          try {
            if (this.live.has(ticket[1]!)) unavailable();
            const path = finishRemoval(directory, name);
            this.storage.release(path);
            deleted++;
          } catch (error) {
            workflowLog("warn", { event: "repository_orphan_cleanup", error: workflowErrorCode(error) });
            orphans++;
          }
        }
        for (const id of names) {
          if (cleanupTicket.test(id) || this.live.has(id) || removing.has(id)) continue;
          if (kind === "leases" && this.ownership.localLease(id)) {
            // Retain the lease and its storage charge until provider cleanup is confirmed.
            if (!await this.accountRetainedLease(directory, id)) orphans++;
            continue;
          }
          let owned: string | undefined;
          try {
            owned = this.marked(kind, id);
            if (kind === "pending" && existsSync(join(owned, "promotion"))) {
              await this.storage.restoreAbandoned(owned, kind);
              promotions.push(owned);
              continue;
            }
            this.removeDirectory(owned);
            deleted++;
          } catch (error) {
            await cleanupFailed(error, owned, kind);
          }
        }
      }
      // Account for surviving candidates and leases before a rollback moves
      // any published bytes back into the shared temporary allowance.
      for (const pending of promotions) {
        try {
          await this.recoverPromotion(pending);
          this.removeDirectory(pending);
          deleted++;
        } catch (error) { await cleanupFailed(error, pending, "pending"); }
      }
      this.ownership.queueUnclaimed();
      const rows = this.ownership.artifacts();
      const root = this.namespace("digests", false);
      const present = new Set(root ? readdirSync(root) : []);
      for (const row of rows) {
        if (row.state === "cleanup_pending") {
          if (
            this.ownership.cleanup(row.digest, () => {
              if (root && present.has(row.digest)) {
                const path = join(root, row.digest);
                for (const file of (publishedFiles(path) ?? unavailable()).files) unlinkSync(join(path, file));
                rmdirSync(path);
              }
              // A prior removal may have succeeded while its sync failed. Persist
              // the observed absence before SQLite forgets who owned these bytes.
              this.syncDigestParent(root);
            })
          )
            deleted++;
        } else if (!present.has(row.digest)) this.ownership.unavailable(row.digest);
        present.delete(row.digest);
      }
      // Unknown bytes without a durable publication intent have no proven owner.
      orphans += present.size;
      this.started = true;
      if (deleted || orphans)
        workflowLog("info", { event: "repository_reconciled", deleted, failed: orphans });
      return { deleted, orphans };
    });
  }
}
