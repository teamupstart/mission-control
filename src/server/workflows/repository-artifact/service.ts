import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
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

// Only flat artifact files may be removed or displaced, even in a digest directory we own.
function publishedFiles(path: string) {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) unavailable();
  const files = readdirSync(path);
  for (const file of files) {
    if ((file !== "manifest.json" && !oid.safeParse(file).success) || !lstatSync(join(path, file)).isFile())
      unavailable();
  }
  return files;
}

function removeMarkedDirectory(path: string) {
  const owner = join(path, "owner.json");
  for (const name of readdirSync(path)) {
    if (name !== "owner.json") rmSync(join(path, name), { recursive: true });
  }
  // Keep the ownership proof until every payload entry is gone. If final removal
  // fails, leave the same directory marked for the next reconciliation.
  const directory = lstatSync(path);
  const marker = readFileSync(owner);
  unlinkSync(owner);
  try {
    rmdirSync(path);
  } catch (error) {
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.dev === directory.dev && current.ino === directory.ino)
      writeFileSync(owner, marker, { flag: "wx", mode: 0o600 });
    throw error;
  }
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
      const entry = lstatSync(directory, { throwIfNoEntry: false });
      if (!entry) {
        if (!create) return undefined;
        mkdirSync(directory, { mode: 0o700 });
      } else if (!entry.isDirectory()) unavailable();
      if (realpathSync(directory) !== directory) unavailable();
    }
    return path;
  }
  private allocate(kind: Marker["kind"]) {
    const marker: Marker = { kind, id: randomUUID(), nonce: randomUUID(), createdAt: Date.now() };
    const path = join(this.namespace(kind), marker.id);
    mkdirSync(path, { mode: 0o700 });
    try {
      writeFileSync(join(path, "owner.tmp"), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
      renameSync(join(path, "owner.tmp"), join(path, "owner.json"));
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
    await this.start();
    return this.measured("repository_seal", async () => {
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
    return this.measured("repository_boundary", () => sampleCheckoutBoundary(checkout, signal));
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
    let replace = false;
    try {
      manifest = await verifyDirectory(existing ? dest : src, digest, signal);
    } catch (error) {
      if (!existing || signal.aborted || !isArtifactIntegrityFailure(error) || !this.ownership.hasArtifact(digest))
        throw error;
      this.ownership.unavailable(digest);
      manifest = await verifyDirectory(src, digest, signal);
      replace = true;
    }
    const publish = () => {
      if (replace) {
        const previous = join(pending, "previous");
        publishedFiles(dest);
        renameSync(dest, previous);
        try {
          renameSync(src, dest);
        } catch (error) {
          renameSync(previous, dest);
          throw error;
        }
      } else if (!existing) renameSync(src, dest);
    };
    return { manifest, publish };
  }
  private async recoverPromotion(pending: string) {
    const intent = join(pending, "promotion");
    if (!existsSync(intent)) return;
    if (!lstatSync(intent).isFile()) unavailable();
    const digest = digestSchema.parse(readFileSync(intent, "utf8"));
    if (this.ownership.hasArtifact(digest)) {
      // The intent precedes publication. Replaying it verifies whichever copy
      // survived, including when a missing directory left no "previous" backup.
      // Only the original transaction can attach the incoming submission.
      const { publish } = await this.preparePublication(pending, digest);
      publish();
      this.ownership.verified(digest);
      return;
    }
    const root = this.namespace("digests", false);
    if (!root) return;
    const path = join(root, digest);
    if (existsSync(join(pending, "artifact"))) return;
    if (!existsSync(path)) return;
    await verifyDirectory(path, digest, AbortSignal.timeout(600_000));
    if (!this.ownership.cleanup(digest, () => renameSync(path, join(pending, "artifact")))) unavailable();
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
        writeFileSync(join(pending, "promotion.tmp"), candidate.digest, { mode: 0o600 });
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
    return verifyDirectory(join(this.namespace("digests"), digest), digest, signal, lease ? { root: lease, storage: this.storage } : undefined,
      () => this.ownership.unavailable(digest));
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
    return this.exclusive(() =>
      this.measured("repository_materialize", async () => {
        this.checkRequest(identity);
        signal.throwIfAborted();
        const { marker, path } = this.allocate("leases");
        try {
          const manifest = await this.verifyPublished(identity.digest, signal, path);
          this.checkRequest(identity);
          this.ownership.verified(identity.digest);
          return {
            identity,
            descriptor: descriptor(manifest, identity.digest, marker.id),
            objectDirectory: path,
            release: async () => {
              if (this.live.has(marker.id)) this.remove("leases", marker.id, marker.nonce);
            },
          };
        } catch (error) {
          this.abandon(marker);
          throw error;
        }
      }),
    );
  }
  async release(submissionId: string) {
    this.ownership.release(submissionId);
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
  reconcile() {
    return this.exclusive(async () => {
      let deleted = 0,
        orphans = 0;
      if (!this.started) this.ownership.recoverProvisional();
      for (const kind of ["pending", "leases"] as const) {
        const directory = this.namespace(kind, false);
        if (!directory) continue;
        for (const id of readdirSync(directory)) {
          if (this.live.has(id)) continue;
          try {
            const path = this.marked(kind, id);
            if (kind === "pending") await this.recoverPromotion(path);
            this.removeDirectory(path);
            deleted++;
          } catch (error) {
            workflowLog("warn", { event: "repository_orphan_cleanup", error: workflowErrorCode(error) });
            orphans++;
          }
        }
      }
      this.ownership.queueUnclaimed();
      const rows = this.ownership.artifacts();
      const root = this.namespace("digests", false);
      const present = new Set(root ? readdirSync(root) : []);
      for (const row of rows) {
        if (row.state === "cleanup_pending") {
          if (
            this.ownership.cleanup(row.digest, () => {
              if (!root || !present.has(row.digest)) return;
              const path = join(root, row.digest);
              for (const file of publishedFiles(path)) unlinkSync(join(path, file));
              rmdirSync(path);
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
