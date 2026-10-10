import { mkdirSync, renameSync, lstatSync, realpathSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PlanManifestSchema, SavePlanInputSchema, PLAN_CONTENT_LIMITS, managedPlanPreview, type PlanManifest, type SavePlanInput, type ManagedPlanRevision } from "@shared/managed-plans.ts";
import { openDb } from "../db.ts";
import { STATE_DIR } from "../config.ts";
import { resolveRepoRoot } from "../repos.ts";
import { getSkillsConfig, skillsConfigProblem } from "../skills/config.ts";
import { validateStaticReportHtml } from "../archives/html.ts";
import { run } from "../util/exec.ts";
import { PlanStoreError, digest, readSafe, replaceSafe, safePath } from "./files.ts";
export { PlanStoreError } from "./files.ts";

export interface PlanAuthority {
  sessionId: string; taskId: string | null; episodeId: string | null;
  repoSlot: string; checkout: string; repoRoot: string;
  /** Recheck live attribution after asynchronous Git work, immediately before mutation. */
  assertCurrent?: () => void;
}
interface PlanRow {
  id: string; repo_root: string; repo_key: string; store_path: string; slug: string; policy: string;
  current_revision: number;
}
interface RevisionRow {
  plan_id: string; revision: number; request_id: string; request_hash: string; manifest_hash: string;
  status: string; checkout_root: string; intent: string;
  session_id: string; task_id: string | null; episode_id: string | null; repo_slot: string;
}
const IntentSchema = z.object({ writes: z.array(z.object({ name: z.string(), before: z.string().nullable() }).strict()), manifest: PlanManifestSchema }).strict();
const queues = new Map<string, Promise<unknown>>();
async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}

export async function planRepository(authority: PlanAuthority): Promise<{ repoKey: string; repoRoot: string; localStore: string }> {
  const repoRoot = await resolveRepoRoot(authority.repoRoot);
  if (!repoRoot) throw new PlanStoreError("The authorized repository is unavailable", 404);
  const repoKey = digest(repoRoot);
  const label = path.basename(repoRoot).replace(/[^a-zA-Z0-9_-]/g, "-") || "repository";
  return { repoRoot, repoKey, localStore: path.join(STATE_DIR, "plans", label, repoKey) };
}

function row(id: string): PlanRow {
  const found = openDb().prepare("SELECT * FROM managed_plans WHERE id = ?").get(id) as unknown as PlanRow | undefined;
  if (!found) throw new PlanStoreError("No such managed plan", 404);
  return found;
}
function revisionRow(id: string, revision: number): RevisionRow {
  const found = openDb().prepare("SELECT * FROM managed_plan_revisions WHERE plan_id = ? AND revision = ?").get(id, revision) as unknown as RevisionRow | undefined;
  if (!found) throw new PlanStoreError("No such plan revision", 404);
  return found;
}
function revisionPath(plan: PlanRow, revision: number): string { return `${plan.store_path}/${revision}`; }
function retainedRoot(): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return realpathSync(STATE_DIR);
}
function manifestFor(plan: PlanRow, saved: RevisionRow): PlanManifest {
  const bytes = readSafe(retainedRoot(), `${revisionPath(plan, saved.revision)}/manifest.json`);
  if (!bytes || digest(bytes) !== saved.manifest_hash) throw new PlanStoreError("Plan manifest is missing or corrupt");
  const manifest = PlanManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.planId !== plan.id || manifest.repoKey !== plan.repo_key || manifest.revision !== saved.revision || JSON.stringify(manifest.policy) !== plan.policy) throw new PlanStoreError("Plan manifest identity mismatch");
  for (const file of manifest.files) {
    const body = readSafe(retainedRoot(), `${revisionPath(plan, saved.revision)}/${file.name}`);
    if (!body || body.length !== file.bytes || digest(body) !== file.sha256) throw new PlanStoreError(`Saved plan file is missing or corrupt: ${file.name}`);
  }
  return manifest;
}
function receipt(manifest: PlanManifest): ManagedPlanRevision {
  return { manifest, preview: managedPlanPreview(manifest.planId, manifest.revision), requiredPaths: manifest.files.flatMap((file) => file.checkoutPath ? [file.checkoutPath] : []) };
}

/** Operator API reads exact durable identities; MCP additionally checks repository ownership. */
export function readPlanRevision(id: string, revision: number): ManagedPlanRevision {
  const saved = revisionRow(id, revision);
  if (saved.status !== "ready") throw new PlanStoreError("Plan revision is incomplete; retry its save request to recover");
  return receipt(manifestFor(row(id), saved));
}
export function readPlanFile(id: string, revision: number, name: string): Buffer {
  const { manifest } = readPlanRevision(id, revision);
  const file = manifest.files.find((f) => f.name === name);
  if (!file) throw new PlanStoreError("File is not in this exact revision", 404);
  const bytes = readSafe(retainedRoot(), `${revisionPath(row(id), revision)}/${file.name}`);
  if (!bytes || digest(bytes) !== file.sha256) throw new PlanStoreError("Plan file digest mismatch");
  return bytes;
}
export async function planContext(authority: PlanAuthority) {
  const repository = await planRepository(authority);
  const problem = skillsConfigProblem();
  if (problem) throw new PlanStoreError(problem);
  return { ...repository, repoSlot: authority.repoSlot, checkoutRoot: authority.checkout, sourceRoot: "docs/plans", policy: { storage: "repository" as const, commitPlanHtml: getSkillsConfig().commitPlanHtml } };
}
export async function listPlans(authority: PlanAuthority): Promise<ManagedPlanRevision[]> {
  const { repoKey } = await planRepository(authority);
  const rows = openDb().prepare("SELECT * FROM managed_plans WHERE repo_key = ? AND current_revision > 0 ORDER BY slug LIMIT 100").all(repoKey) as unknown as PlanRow[];
  return rows.map((plan) => readPlanRevision(plan.id, plan.current_revision));
}
export async function authorizePlan(authority: PlanAuthority, id: string): Promise<void> {
  if (row(id).repo_key !== (await planRepository(authority)).repoKey) throw new PlanStoreError("Plan belongs to a different repository", 403);
}

function validateFiles(input: SavePlanInput): void {
  const names = new Set<string>();
  let total = 0;
  for (const file of input.files) {
    const name = file.name.toLowerCase();
    if (names.has(name)) throw new PlanStoreError("Duplicate or case-colliding plan filenames", 400);
    names.add(name);
    const bytes = Buffer.byteLength(file.content);
    if (Buffer.from(file.content).toString("utf8") !== file.content || file.content.includes("\0") || bytes > PLAN_CONTENT_LIMITS.fileBytes) throw new PlanStoreError("Invalid UTF-8 text or oversized plan file", 400);
    total += bytes;
  }
  if (total > PLAN_CONTENT_LIMITS.totalBytes) throw new PlanStoreError("Plan bundle exceeds its size limit", 400);
  const targets = new Set(input.files.map((f) => f.name));
  if (!targets.has("plan.md") || !targets.has("plan.html")) throw new PlanStoreError("A complete plan needs plan.md and plan.html", 400);
  for (const file of input.files) {
    if (file.name.endsWith(".md") && !targets.has(file.name.replace(/\.md$/, ".html"))) throw new PlanStoreError(`Missing rendering for ${file.name}`, 400);
    if (file.name.endsWith(".html") && !targets.has(file.name.replace(/\.html$/, ".md"))) throw new PlanStoreError(`Missing Markdown source for ${file.name}`, 400);
    if (/\.(html|svg|css)$/.test(file.name)) {
      const validation = validateStaticReportHtml(file.name.endsWith(".css") ? `<style>${file.content}</style>` : file.content, targets, true);
      if (!validation.ok) throw new PlanStoreError(`${file.name}: ${validation.problems.map((p) => p.message).join("; ")}`, 400);
    }
  }
}

async function finish(plan: PlanRow, saved: RevisionRow, beforeWrite: () => Promise<void>): Promise<ManagedPlanRevision> {
  const manifest = manifestFor(plan, saved);
  if (saved.status === "ready") return receipt(manifest);
  if (saved.status !== "pending" && saved.status !== "staging") throw new PlanStoreError("Unknown plan write state");
  if (await resolveRepoRoot(saved.checkout_root) !== plan.repo_root) throw new PlanStoreError("Pending plan checkout no longer belongs to its repository");
  const intent = IntentSchema.parse(JSON.parse(saved.intent)).writes;
  await beforeWrite();
  // Preflight the whole intent before writing any file. Matching writes are replay-safe.
  for (const entry of intent) {
    const file = manifest.files.find((f) => f.name === entry.name && f.checkoutPath)!;
    const bytes = readSafe(saved.checkout_root, file.checkoutPath!);
    const actual = bytes ? digest(bytes) : null;
    if (actual !== entry.before && actual !== file.sha256) throw new PlanStoreError(`Operator edit conflicts with ${file.checkoutPath}; pending revision remains incomplete`);
  }
  for (const entry of intent) {
    const file = manifest.files.find((f) => f.name === entry.name)!;
    const current = readSafe(saved.checkout_root, file.checkoutPath!);
    if (current && digest(current) === file.sha256) continue;
    const bytes = readSafe(retainedRoot(), `${revisionPath(plan, saved.revision)}/${file.name}`)!;
    replaceSafe(saved.checkout_root, file.checkoutPath!, bytes, entry.before);
  }
  const db = openDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE managed_plan_revisions SET status = 'ready', intent = '{}' WHERE plan_id = ? AND revision = ?").run(plan.id, saved.revision);
    db.prepare("UPDATE managed_plans SET current_revision = ? WHERE id = ?").run(saved.revision, plan.id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return receipt(manifest);
}

/** Saves never approve, publish, stage Git, or satisfy task dependencies. */
export async function savePlan(authority: PlanAuthority, request: SavePlanInput, hooks: { beforeCheckoutWrite?: () => Promise<void>; afterRevisionStaged?: () => Promise<void> } = {}): Promise<ManagedPlanRevision> {
  authority = { ...authority, checkout: realpathSync(authority.checkout) };
  const input = SavePlanInputSchema.parse(request);
  validateFiles(input);
  const context = await planContext(authority);
  if (await resolveRepoRoot(authority.checkout) !== context.repoRoot) throw new PlanStoreError("Checkout does not belong to the authorized repository", 403);
  return exclusive(context.repoKey, async () => {
    authority.assertCurrent?.();
    const beforeWrite = async () => { await hooks.beforeCheckoutWrite?.(); authority.assertCurrent?.(); };
    const db = openDb();
    const requestHash = digest(JSON.stringify({ ...input, files: [...input.files].sort((a, b) => a.name.localeCompare(b.name)), repoKey: context.repoKey, sessionId: authority.sessionId, episodeId: authority.episodeId }));
    const replay = db.prepare("SELECT * FROM managed_plan_revisions WHERE request_id = ?").get(input.requestId) as unknown as RevisionRow | undefined;
    if (replay) {
      if (replay.request_hash !== requestHash) throw new PlanStoreError("Save request identity was reused with different content or attribution");
      if (replay.status === "staging") stageRevision(row(replay.plan_id), replay, input.files);
      return finish(row(replay.plan_id), replay, beforeWrite);
    }
    let plan: PlanRow;
    if (input.planId) {
      plan = row(input.planId);
      if (plan.repo_key !== context.repoKey) throw new PlanStoreError("Plan belongs to a different repository", 403);
      if (plan.slug !== input.slug) throw new PlanStoreError("A plan's directory cannot change");
    } else {
      if (db.prepare("SELECT id FROM managed_plans WHERE repo_key = ? AND slug = ?").get(context.repoKey, input.slug)) throw new PlanStoreError("This plan already exists; use its id and expected revision");
      const existing = path.join(authority.checkout, "docs/plans", input.slug);
      const tracked = await run("git", ["-C", authority.checkout, "ls-files", "--", `docs/plans/${input.slug}/`]);
      if (tracked.code !== 0 || tracked.stdout.trim()) throw new PlanStoreError("Existing tracked plans cannot be adopted or migrated by a new-plan save");
      if (existsSync(existing) || (() => { try { return !!lstatSync(existing); } catch { return false; } })()) throw new PlanStoreError("Unmanaged plan already exists. Edit its tracked layout explicitly; migration is not supported");
      const id = randomUUID();
      plan = { id, repo_root: context.repoRoot, repo_key: context.repoKey, store_path: path.relative(STATE_DIR, path.join(context.localStore, id)), slug: input.slug, policy: JSON.stringify(context.policy), current_revision: 0 };
    }
    if (plan.current_revision !== input.expectedRevision) throw new PlanStoreError("Stale expected plan revision");
    if (db.prepare("SELECT 1 FROM managed_plan_revisions WHERE plan_id = ? AND status != 'ready'").get(plan.id)) throw new PlanStoreError("A previous save is incomplete; retry its exact request first");
    const previous = plan.current_revision ? readPlanRevision(plan.id, plan.current_revision).manifest : null;
    const policy = previous?.policy ?? context.policy;
    const files = [...input.files].sort((a, b) => a.name.localeCompare(b.name));
    const manifest: PlanManifest = { version: 1, planId: plan.id, repoKey: plan.repo_key, slug: plan.slug, revision: plan.current_revision + 1, policy, createdAt: Date.now(), files: files.map((file) => {
      const source = file.name.endsWith(".html") ? file.name.replace(/\.html$/, ".md") : null;
      return { name: file.name, bytes: Buffer.byteLength(file.content), sha256: digest(file.content), source, sourceSha256: source ? digest(files.find((f) => f.name === source)!.content) : null, checkoutPath: file.name.endsWith(".md") || (policy.commitPlanHtml && file.name.endsWith(".html")) ? `docs/plans/${plan.slug}/${file.name}` : null };
    }) };
    if (previous?.files.some((old) => old.checkoutPath && !manifest.files.some((file) => file.checkoutPath === old.checkoutPath))) throw new PlanStoreError("Removing existing checkout outputs requires an explicit migration");
    const intent = manifest.files.filter((f) => f.checkoutPath).map((file) => {
      const before = previous?.files.find((f) => f.name === file.name)?.sha256 ?? null;
      const bytes = readSafe(authority.checkout, file.checkoutPath!);
      if ((bytes ? digest(bytes) : null) !== before) throw new PlanStoreError(`Operator edit conflicts with ${file.checkoutPath}`);
      return { name: file.name, before };
    });
    const ignored = await run("git", ["-C", authority.checkout, "check-ignore", "--", ...manifest.files.flatMap((file) => file.checkoutPath ? [file.checkoutPath] : [])]);
    if (ignored.code !== 1 || ignored.outcomeUnknown || ignored.overflowed) {
      throw new PlanStoreError(ignored.code === 0 ? `Required plan outputs are ignored by Git: ${ignored.stdout.trim()}` : "Could not verify Git eligibility of plan outputs");
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    authority.assertCurrent?.();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!input.planId) db.prepare("INSERT INTO managed_plans (id, repo_root, repo_key, store_path, slug, policy, session_id, task_id, episode_id, repo_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(plan.id, plan.repo_root, plan.repo_key, plan.store_path, plan.slug, plan.policy, authority.sessionId, authority.taskId, authority.episodeId, authority.repoSlot);
      db.prepare("INSERT INTO managed_plan_revisions VALUES (?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?)").run(plan.id, manifest.revision, input.requestId, requestHash, digest(manifestBytes), realpathSync(authority.checkout), JSON.stringify({ writes: intent, manifest }), authority.sessionId, authority.taskId, authority.episodeId, authority.repoSlot);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const saved = revisionRow(plan.id, manifest.revision);
    stageRevision(plan, saved, input.files);
    await hooks.afterRevisionStaged?.();
    return finish(plan, saved, beforeWrite);
  });
}

/** Journal first, then publish all retained bytes by rename. An authorized retry uses
 * the frozen manifest and verifies any bytes already retained before the interruption. */
function stageRevision(plan: PlanRow, saved: RevisionRow, files: SavePlanInput["files"]): void {
  const manifest = IntentSchema.parse(JSON.parse(saved.intent)).manifest;
  const root = retainedRoot();
  const destination = revisionPath(plan, saved.revision);
  const published = readSafe(root, `${destination}/manifest.json`);
  if (published) { manifestFor(plan, saved); return; }
  const stage = `${plan.store_path}/staging-${randomUUID()}`;
  try {
    for (const file of files) replaceSafe(root, `${stage}/${file.name}`, Buffer.from(file.content), null);
    replaceSafe(root, `${stage}/manifest.json`, Buffer.from(JSON.stringify(manifest)), null);
    for (const file of manifest.files) if (digest(readSafe(root, `${stage}/${file.name}`)!) !== file.sha256) throw new PlanStoreError("Staged plan verification failed");
    safePath(root, `${destination}/manifest.json`);
    renameSync(path.join(root, stage), path.join(root, destination));
  } catch (error) { rmSync(path.join(root, stage), { recursive: true, force: true }); throw error; }
}

/** Startup has no live writer authority. Only an attributed save retry may apply an intent. */
export function pendingPlanWriteWarnings(): string[] {
  const pending = openDb().prepare("SELECT plan_id, revision FROM managed_plan_revisions WHERE status IN ('pending', 'staging')").all() as unknown as Pick<RevisionRow, "plan_id" | "revision">[];
  return pending.map((saved) => `${saved.plan_id}/${saved.revision}: Plan revision is incomplete; retry its exact save request from a currently registered session`);
}

/** Exact latest revision authored in this work episode, even after checkout removal. */
export function managedPlanCaptureScopes(taskId: string | null, episodeId: string | null) {
  if (!taskId) return [];
  if (openDb().prepare("SELECT 1 FROM managed_plan_revisions WHERE task_id = ? AND episode_id IS ? AND status != 'ready'").get(taskId, episodeId)) throw new PlanStoreError("A managed plan save is incomplete; retry its exact request before cleanup");
  const rows = openDb().prepare(`SELECT r.* FROM managed_plan_revisions r WHERE r.task_id = ? AND r.episode_id IS ? AND r.status = 'ready'
    AND r.revision = (SELECT MAX(s.revision) FROM managed_plan_revisions s WHERE s.plan_id = r.plan_id AND s.task_id = r.task_id AND s.episode_id IS r.episode_id AND s.status = 'ready')`).all(taskId, episodeId) as unknown as RevisionRow[];
  return rows.map((saved) => ({ slot: saved.repo_slot, directory: `docs/plans/${row(saved.plan_id).slug}`, title: null,
    managed: { planId: saved.plan_id, revision: saved.revision } }));
}

export function retainedPlanFiles(id: string, revision: number) {
  const { manifest } = readPlanRevision(id, revision);
  const plan = row(id);
  return manifest.files.map((file) => ({ ...file, retainedPath: `${revisionPath(plan, revision)}/${file.name}` }));
}
