import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Credential lifetime only. This journal never owns a task, binding, or database. */
export interface ResumeLease {
  version: 1;
  id: string;
  root: string;
  conversation: string;
  sourceSessionId: string;
  home: string;
  createdAt: number;
}
export type ResumeDecision =
  | { state: "claimed"; pid: number; startMs: number }
  | { state: "revoked" };
export interface ResumeLeaseStatus {
  lease: ResumeLease;
  state: "preparing" | "pending" | "claimed" | "revoked" | "completed";
  deadline: number | null;
  owner: { pid: number; startMs: number } | null;
}
export const RESUME_START_MS = 120_000;
const ID = /^[a-f0-9-]{36}$/;

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Publish whole private records, including after a process or machine crash. */
export function writeResumeRecord(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  syncDirectory(dirname(path));
}

function directory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path
    || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("unsafe managed resume directory; retained for inspection");
  }
}

function record<T>(path: string): T | null {
  let info;
  try { info = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024
    || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("unsafe managed resume record; retained for inspection");
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function resumeLeaseRoot(stateDir: string): string {
  // Canonical daemon state identity partitions both control records and disposable homes.
  const identity = createHash("sha256").update(realpathSync(stateDir)).digest("hex");
  const parent = join(realpathSync(tmpdir()), "mission-control-resumes");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  directory(parent);
  const root = join(parent, identity);
  for (const path of [root, join(root, "leases"), join(root, "homes")]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
    directory(path);
  }
  return root;
}

function leaseDir(root: string, id: string): string {
  if (!ID.test(id)) throw new Error("invalid managed resume attempt");
  for (const path of [root, join(root, "leases"), join(root, "homes")]) directory(path);
  const dir = join(root, "leases", id);
  directory(dir);
  return dir;
}

export function readResumeLease(root: string, id: string): ResumeLease {
  const dir = leaseDir(root, id);
  const lease = record<ResumeLease>(join(dir, "lease.json"));
  if (!lease || lease.version !== 1 || lease.id !== id || lease.root !== root
    || lease.home !== join(root, "homes", id) || typeof lease.conversation !== "string" || typeof lease.sourceSessionId !== "string"
    || !Number.isFinite(lease.createdAt)) throw new Error(`managed resume ${id} is malformed; retained for inspection`);
  return lease;
}

export function resumeLeaseStatus(lease: ResumeLease): ResumeLeaseStatus {
  const dir = leaseDir(lease.root, lease.id);
  const persisted = readResumeLease(lease.root, lease.id);
  if (lease.home !== persisted.home || lease.conversation !== persisted.conversation
    || lease.sourceSessionId !== persisted.sourceSessionId || lease.createdAt !== persisted.createdAt) {
    throw new Error("foreign managed resume lease; retained for inspection");
  }
  const intent = record<{ deadline: number }>(join(dir, "intent.json"));
  if (intent && !Number.isFinite(intent.deadline)) throw new Error("invalid managed resume start deadline");
  const decision = record<ResumeDecision>(join(dir, "decision.json"));
  if (decision && decision.state !== "revoked" && !(decision.state === "claimed"
    && Number.isSafeInteger(decision.pid) && decision.pid > 0 && Number.isFinite(decision.startMs))) {
    throw new Error("invalid managed resume owner; retained for inspection");
  }
  const completion = record<{ pid: number; startMs: number }>(join(dir, "completed.json"));
  if (completion && (decision?.state !== "claimed" || completion.pid !== decision.pid
    || completion.startMs !== decision.startMs)) throw new Error("invalid managed resume completion");
  return { lease, state: completion ? "completed" : decision?.state ?? (intent ? "pending" : "preparing"),
    deadline: intent?.deadline ?? null, owner: decision?.state === "claimed" ? { pid: decision.pid, startMs: decision.startMs } : null };
}

/** One immutable hard link is the CAS. A crashed contender leaves no lock to steal. */
function decide(lease: ResumeLease, value: ResumeDecision): boolean {
  const dir = leaseDir(lease.root, lease.id);
  const proposal = join(dir, `${randomUUID()}.proposal`);
  writeResumeRecord(proposal, value);
  try {
    linkSync(proposal, join(dir, "decision.json"));
    syncDirectory(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally { rmSync(proposal, { force: true }); }
}

export function claimResumeLease(lease: ResumeLease, pid: number, startMs: number, now = Date.now()): boolean {
  const status = resumeLeaseStatus(lease);
  if (status.state !== "pending" || status.deadline! <= now || !Number.isSafeInteger(pid)
    || pid <= 0 || !Number.isFinite(startMs)) return false;
  try { directory(lease.home); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; // Revocation won during validation.
    throw error;
  }
  return decide(lease, { state: "claimed", pid, startMs });
}

export function beginResumeLaunch(lease: ResumeLease, now = Date.now()): void {
  if (resumeLeaseStatus(lease).state !== "preparing") throw new Error("managed resume already attempted");
  writeResumeRecord(join(leaseDir(lease.root, lease.id), "intent.json"), { deadline: now + RESUME_START_MS });
}

/** Only revocation or the wrapper's positive completion authorizes removal. */
function clean(lease: ResumeLease): void {
  const status = resumeLeaseStatus(lease);
  if (status.state !== "revoked" && status.state !== "completed") return;
  try { directory(lease.home); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(lease.home, { recursive: true, force: true });
  syncDirectory(dirname(lease.home));
}

export function revokeResumeLease(lease: ResumeLease): boolean {
  const status = resumeLeaseStatus(lease);
  if (status.state === "claimed" || status.state === "completed") return false;
  if (status.state !== "revoked" && !decide(lease, { state: "revoked" })) return false;
  clean(lease);
  return true;
}

/** Called only by the guard after child exit and a successful descendant lifetime check. */
export function completeResumeLease(lease: ResumeLease, pid: number, startMs: number): void {
  const status = resumeLeaseStatus(lease);
  if ((status.state !== "claimed" && status.state !== "completed") || status.owner?.pid !== pid || status.owner.startMs !== startMs) {
    throw new Error("managed resume completion does not own its lease");
  }
  if (status.state !== "completed") writeResumeRecord(join(leaseDir(lease.root, lease.id), "completed.json"), { pid, startMs });
  clean(lease);
}

export function reconcileResumeLeases(root: string, now = Date.now(), preparing = new Set<string>()): ResumeLeaseStatus[] {
  directory(root);
  const statuses: ResumeLeaseStatus[] = [];
  // Bad records are quarantined in place. Fail closed, including admission of another launch.
  for (const id of readdirSync(join(root, "leases"))) {
    const lease = readResumeLease(root, id);
    const status = resumeLeaseStatus(lease);
    if ((status.state === "preparing" && !preparing.has(id))
      || (status.state === "pending" && status.deadline! <= now)) revokeResumeLease(lease);
    clean(lease);
    statuses.push(resumeLeaseStatus(lease));
  }
  return statuses;
}

export function createResumeLease(root: string, conversation: string, preparing: Set<string>, sourceSessionId = ""): ResumeLease {
  const current = reconcileResumeLeases(root, Date.now(), preparing).find((s) =>
    s.lease.conversation === conversation && ["preparing", "pending", "claimed"].includes(s.state));
  if (current) throw new Error(resumeLeaseDiagnostic(current));
  const id = randomUUID();
  const lease: ResumeLease = { version: 1, id, root, conversation, sourceSessionId,
    home: join(root, "homes", id), createdAt: Date.now() };
  const dir = join(root, "leases", id);
  // Reconciliation only sees complete records. A crash during this write leaves a private,
  // credential-free staging directory outside leases/, never a malformed published lease.
  const staging = join(root, `.lease-${id}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    writeResumeRecord(join(staging, "lease.json"), lease);
    renameSync(staging, dir);
    syncDirectory(dirname(dir));
  } finally { rmSync(staging, { recursive: true, force: true }); }
  preparing.add(id);
  // The durable lease exists before any credential or launch configuration does.
  try { mkdirSync(lease.home, { mode: 0o700 }); } catch (error) {
    preparing.delete(id);
    revokeResumeLease(lease);
    throw error;
  }
  return lease;
}

export function resumeLeaseDiagnostic(status: ResumeLeaseStatus): string {
  if (status.state === "completed" || status.state === "revoked") {
    return `Managed resume ${status.lease.id} is ${status.state}; its prepared environment has been released.`;
  }
  return `Managed resume ${status.lease.id} is ${status.state}. ` + (status.state === "claimed"
    ? "Its terminal may still be using the prepared environment. Close the exact resumed agent normally; use the session's Stop action if needed. Recheck before resuming again."
    : "No additional terminal was started. Recheck after the two-minute start deadline; an unclaimed attempt will be revoked safely.");
}
