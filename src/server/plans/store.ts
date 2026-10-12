import { mkdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ManagedPlanPolicySchema, PlanManifestSchema, SavePlanInputSchema, PLAN_CONTENT_LIMITS, managedPlanPreview, type ManagedPlanPolicy, type PlanManifest, type SavePlanInput, type ManagedPlanRevision, type ManagedPlanCatalog } from "@shared/managed-plans.ts";
import type { Task } from "@shared/types.ts";
import { openDb } from "../db.ts";
import { STATE_DIR } from "../config.ts";
import { resolveRepoRoot } from "../repos.ts";
import { getSkillsConfig, skillsConfigProblem } from "../skills/config.ts";
import { validateStaticReportHtml } from "../archives/html.ts";
import { run } from "../util/exec.ts";
import { PlanStoreError, digest, readSafe, replaceSafe, withPlanDirectory } from "./files.ts";
export { PlanStoreError } from "./files.ts";

export interface PlanAuthority {
  sessionId: string; taskId: string | null; episodeId: string | null;
  repoSlot: string; checkout: string; repoRoot: string;
  policy?: ManagedPlanPolicy | null;
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
interface SavePlanHooks {
  beforeCheckoutWrite?: () => Promise<void>;
  afterRevisionStaged?: () => Promise<void>;
  afterCheckoutWrite?: (name: string) => void;
  beforeCheckoutRename?: (name: string) => void;
  beforeRetainedPublish?: () => void;
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
  return planRepositoryLocation(repoRoot);
}

/** Task repository preparation has already resolved these canonical owner paths. */
export function planRepositoryLocation(repoRoot: string) {
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
function manifestMetadataFor(plan: PlanRow, saved: RevisionRow): PlanManifest {
  const bytes = readSafe(retainedRoot(), `${revisionPath(plan, saved.revision)}/manifest.json`);
  if (!bytes || digest(bytes) !== saved.manifest_hash) throw new PlanStoreError("Plan manifest is missing or corrupt");
  const manifest = PlanManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.planId !== plan.id || manifest.repoKey !== plan.repo_key || manifest.revision !== saved.revision || JSON.stringify(manifest.policy) !== plan.policy) throw new PlanStoreError("Plan manifest identity mismatch");
  return manifest;
}
function manifestFor(plan: PlanRow, saved: RevisionRow): PlanManifest {
  const manifest = manifestMetadataFor(plan, saved);
  for (const file of manifest.files) {
    const body = readSafe(retainedRoot(), `${revisionPath(plan, saved.revision)}/${file.name}`);
    if (!body || body.length !== file.bytes || digest(body) !== file.sha256) throw new PlanStoreError(`Saved plan file is missing or corrupt: ${file.name}`);
  }
  return manifest;
}
function receipt(manifest: PlanManifest): ManagedPlanRevision {
  return { manifest, preview: managedPlanPreview(manifest.planId, manifest.revision), requiredPaths: manifest.files.flatMap((file) => file.checkoutPath ? [file.checkoutPath] : []) };
}

function readyRevisionRow(id: string, revision: number): RevisionRow {
  const saved = revisionRow(id, revision);
  if (saved.status !== "ready") throw new PlanStoreError("Plan revision is incomplete; retry its save request to recover");
  return saved;
}
/** Operator API reads exact durable identities; MCP additionally checks repository ownership. */
export function readPlanRevision(id: string, revision: number): ManagedPlanRevision {
  const saved = readyRevisionRow(id, revision);
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
  const reservation = authority.taskId ? openDb().prepare("SELECT plan_id, policy FROM managed_plan_reservations WHERE task_id = ? AND repo_key = ?").get(authority.taskId, repository.repoKey) as { plan_id: string; policy: string } | undefined : undefined;
  return { version: 2, ...repository, repoSlot: authority.repoSlot, checkoutRoot: authority.checkout, sourceRoot: "docs/plans", reservedPlanId: reservation?.plan_id ?? null,
    policy: reservation ? ManagedPlanPolicySchema.parse(JSON.parse(reservation.policy)) : authority.policy ?? newPlanPolicy() };
}

export function newPlanPolicy(): ManagedPlanPolicy {
  const problem = skillsConfigProblem();
  if (problem) throw new PlanStoreError(problem);
  const config = getSkillsConfig();
  return config.planStorage === "local"
    ? { version: 2, storage: "local", commitPlanHtml: config.commitPlanHtml }
    : { storage: "repository", commitPlanHtml: config.commitPlanHtml };
}

/** Pre-policy plan tasks keep Git publication, with the saved HTML choice at first pin. */
export function planPolicyForTask(task: Pick<Task, "kind" | "planPolicy" | "planPolicyError">): ManagedPlanPolicy | null {
  if (task.planPolicyError) throw new PlanStoreError(task.planPolicyError);
  if (task.kind !== "plan") return null;
  return task.planPolicy ?? { storage: "repository", commitPlanHtml: newPlanPolicy().commitPlanHtml };
}

/** Identity is reserved before a plan task launches or binds its selected workflow. */
export function reserveTaskPlan(authority: Pick<PlanAuthority, "taskId" | "repoRoot" | "policy">): void {
  if (!authority.taskId || !authority.policy) return;
  const repository = planRepositoryLocation(authority.repoRoot);
  openDb().prepare("INSERT OR IGNORE INTO managed_plan_reservations VALUES (?, ?, ?, ?)")
    .run(authority.taskId, repository.repoKey, randomUUID(), JSON.stringify(authority.policy));
}

/** Launch and assignment explicitly pin identity for every repository before delivery. */
export function reserveTaskPlans(task: Task): void {
  const policy = planPolicyForTask(task);
  if (!policy) return;
  for (const repoRoot of [task.repoRoot, ...task.extraRepos.map((repo) => repo.repoRoot)]) {
    reserveTaskPlan({ taskId: task.id, repoRoot, policy });
  }
}

export function planRecord(id: string) { return row(id); }
export function planRevisionRecord(id: string, revision: number) { return readyRevisionRow(id, revision); }
export async function listPlans(authority: PlanAuthority | PlanAuthority[], cursor?: string): Promise<ManagedPlanCatalog> {
  const authorities = Array.isArray(authority) ? authority : [authority];
  const repoKeys = [...new Set((await Promise.all(authorities.map(planRepository))).map((repo) => repo.repoKey))];
  authorities.forEach((current) => current.assertCurrent?.());
  if (!repoKeys.length) return { plans: [], nextCursor: null };
  const db = openDb();
  const scope = `repo_key IN (${repoKeys.map(() => "?").join(",")}) AND current_revision > 0`;
  // Slugs never change; the id orders equal slugs across attached repositories.
  // A cursor is a bookmark, never a grant to read a repository no longer issued.
  const after = cursor ? db.prepare(`SELECT slug, id FROM managed_plans WHERE ${scope} AND id = ?`).get(...repoKeys, cursor) as Pick<PlanRow, "slug" | "id"> | undefined : undefined;
  if (cursor && !after) throw new PlanStoreError("Plan catalog cursor is unavailable in the issued repositories; refresh the catalog", 400);
  const rows = db.prepare(`SELECT * FROM managed_plans WHERE ${scope}${after ? " AND (slug > ? OR (slug = ? AND id > ?))" : ""} ORDER BY slug, id LIMIT 101`)
    .all(...repoKeys, ...(after ? [after.slug, after.slug, after.id] : [])) as unknown as PlanRow[];
  const page = rows.slice(0, 100);
  // Discovery verifies bounded manifest metadata; opening an exact revision verifies its bytes.
  return { plans: page.map((plan) => receipt(manifestMetadataFor(plan, readyRevisionRow(plan.id, plan.current_revision)))), nextCursor: rows.length > 100 ? page.at(-1)!.id : null };
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

function assertWriteAuthority(authority: PlanAuthority, saved: RevisionRow): void {
  authority.assertCurrent?.();
  if (saved.checkout_root !== authority.checkout || saved.repo_slot !== authority.repoSlot) throw new PlanStoreError("Saved plan checkout or repository slot is no longer issued to its writer", 403);
  if (saved.session_id !== authority.sessionId || saved.task_id !== authority.taskId || saved.episode_id !== authority.episodeId) throw new PlanStoreError("Saved plan writer attribution changed", 403);
}

async function finish(plan: PlanRow, saved: RevisionRow, authority: PlanAuthority, hooks: SavePlanHooks): Promise<ManagedPlanRevision> {
  const manifest = manifestFor(plan, saved);
  if (saved.status === "ready") return receipt(manifest);
  if (saved.status !== "pending" && saved.status !== "staging") throw new PlanStoreError("Unknown plan write state");
  if (await resolveRepoRoot(saved.checkout_root) !== plan.repo_root) throw new PlanStoreError("Pending plan checkout no longer belongs to its repository");
  const intent = IntentSchema.parse(JSON.parse(saved.intent)).writes;
  await hooks.beforeCheckoutWrite?.();
  assertWriteAuthority(authority, saved);
  // Preflight the whole intent before writing any file. Matching writes are replay-safe.
  for (const entry of intent) {
    const file = manifest.files.find((f) => f.name === entry.name && f.checkoutPath)!;
    const bytes = readSafe(saved.checkout_root, file.checkoutPath!);
    const actual = bytes ? digest(bytes) : null;
    if (actual !== entry.before && actual !== file.sha256) throw new PlanStoreError(`Operator edit conflicts with ${file.checkoutPath}; pending revision remains incomplete`);
  }
  for (const entry of intent) {
    const file = manifest.files.find((f) => f.name === entry.name)!;
    const bytes = readSafe(retainedRoot(), `${revisionPath(plan, saved.revision)}/${file.name}`)!;
    replaceSafe(saved.checkout_root, file.checkoutPath!, bytes, entry.before, () => hooks.beforeCheckoutRename?.(file.name));
    hooks.afterCheckoutWrite?.(file.name);
  }
  const db = openDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Check the whole output set after all replacements and after acquiring the ledger lock.
    // A concurrent editor can have changed an earlier output while later files were written.
    for (const file of manifest.files.filter((file) => file.checkoutPath)) {
      const bytes = readSafe(saved.checkout_root, file.checkoutPath!);
      if (!bytes || bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new PlanStoreError(`Checkout output ${file.checkoutPath} no longer matches its saved digest; pending revision remains incomplete`);
    }
    db.prepare("UPDATE managed_plan_revisions SET status = 'ready', intent = '{}' WHERE plan_id = ? AND revision = ?").run(plan.id, saved.revision);
    db.prepare("UPDATE managed_plans SET current_revision = ? WHERE id = ?").run(saved.revision, plan.id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return receipt(manifest);
}

/** Saves never approve, publish, stage Git, or satisfy task dependencies. */
export async function savePlan(authority: PlanAuthority, request: SavePlanInput, hooks: SavePlanHooks = {}): Promise<ManagedPlanRevision> {
  authority = { ...authority, checkout: realpathSync(authority.checkout) };
  const input = SavePlanInputSchema.parse(request);
  validateFiles(input);
  const context = await planContext(authority);
  if (await resolveRepoRoot(authority.checkout) !== context.repoRoot) throw new PlanStoreError("Checkout does not belong to the authorized repository", 403);
  return exclusive(context.repoKey, async () => {
    authority.assertCurrent?.();
    const db = openDb();
    const requestHash = digest(JSON.stringify({ ...input, files: [...input.files].sort((a, b) => a.name.localeCompare(b.name)), repoKey: context.repoKey, sessionId: authority.sessionId, episodeId: authority.episodeId }));
    const replay = db.prepare("SELECT * FROM managed_plan_revisions WHERE request_id = ?").get(input.requestId) as unknown as RevisionRow | undefined;
    if (replay) {
      if (replay.request_hash !== requestHash) throw new PlanStoreError("Save request identity was reused with different content or attribution");
      assertWriteAuthority(authority, replay);
      if (replay.status === "staging") stageRevision(row(replay.plan_id), replay, input.files, hooks.beforeRetainedPublish);
      return finish(row(replay.plan_id), replay, authority, hooks);
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
      const id = context.reservedPlanId && !db.prepare("SELECT 1 FROM managed_plans WHERE id = ?").get(context.reservedPlanId) ? context.reservedPlanId : randomUUID();
      plan = { id, repo_root: context.repoRoot, repo_key: context.repoKey, store_path: path.relative(STATE_DIR, path.join(context.localStore, id)), slug: input.slug, policy: JSON.stringify(context.policy), current_revision: 0 };
    }
    if (plan.current_revision !== input.expectedRevision) throw new PlanStoreError("Stale expected plan revision");
    if (db.prepare("SELECT 1 FROM managed_plan_revisions WHERE plan_id = ? AND status != 'ready'").get(plan.id)) throw new PlanStoreError("A previous save is incomplete; retry its exact request first");
    const previous = plan.current_revision ? readPlanRevision(plan.id, plan.current_revision).manifest : null;
    const checkoutRevision = db.prepare("SELECT revision FROM managed_plan_revisions WHERE plan_id = ? AND checkout_root = ? AND status = 'ready' ORDER BY revision DESC LIMIT 1")
      .get(plan.id, authority.checkout) as { revision: number } | undefined;
    const checkoutPrevious = checkoutRevision
      ? checkoutRevision.revision === plan.current_revision ? previous : readPlanRevision(plan.id, checkoutRevision.revision).manifest
      : null;
    const policy = ManagedPlanPolicySchema.parse(JSON.parse(plan.policy));
    const files = [...input.files].sort((a, b) => a.name.localeCompare(b.name));
    const manifest: PlanManifest = { version: 1, planId: plan.id, repoKey: plan.repo_key, slug: plan.slug, revision: plan.current_revision + 1, policy, createdAt: Date.now(), files: files.map((file) => {
      const source = file.name.endsWith(".html") ? file.name.replace(/\.html$/, ".md") : null;
      return { name: file.name, bytes: Buffer.byteLength(file.content), sha256: digest(file.content), source, sourceSha256: source ? digest(files.find((f) => f.name === source)!.content) : null, checkoutPath: policy.storage === "repository" && (file.name.endsWith(".md") || (policy.commitPlanHtml && file.name.endsWith(".html"))) ? `docs/plans/${plan.slug}/${file.name}` : null };
    }) };
    if (previous?.files.some((old) => old.checkoutPath && !manifest.files.some((file) => file.checkoutPath === old.checkoutPath))) throw new PlanStoreError("Removing existing checkout outputs requires an explicit migration");
    const intent = manifest.files.filter((f) => f.checkoutPath).map((file) => {
      const bytes = readSafe(authority.checkout, file.checkoutPath!);
      // A linked checkout may never have received this output. Once written there,
      // absence is an operator deletion, even if the latest revision was saved elsewhere.
      const checkoutFile = checkoutPrevious?.files.find((old) => old.checkoutPath === file.checkoutPath);
      const latestFile = previous?.files.find((old) => old.checkoutPath === file.checkoutPath);
      const before = bytes ? digest(bytes) : null;
      // Accept unchanged local output or the latest repository output received through Git.
      const unchanged = before === null ? !checkoutFile : before === checkoutFile?.sha256 || before === latestFile?.sha256;
      if (!unchanged) throw new PlanStoreError(`Operator edit conflicts with ${file.checkoutPath}`);
      return { name: file.name, before };
    });
    const ignored = intent.length ? await run("git", ["-C", authority.checkout, "check-ignore", "--", ...manifest.files.flatMap((file) => file.checkoutPath ? [file.checkoutPath] : [])]) : { code: 1, outcomeUnknown: false, overflowed: false, stdout: "" };
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
    stageRevision(plan, saved, input.files, hooks.beforeRetainedPublish);
    await hooks.afterRevisionStaged?.();
    return finish(plan, saved, authority, hooks);
  });
}

/** Journal first, then publish all retained bytes by rename. An authorized retry uses
 * the frozen manifest and verifies any bytes already retained before the interruption. */
function stageRevision(plan: PlanRow, saved: RevisionRow, files: SavePlanInput["files"], beforePublish?: () => void): void {
  const manifest = IntentSchema.parse(JSON.parse(saved.intent)).manifest;
  const root = retainedRoot();
  const destination = revisionPath(plan, saved.revision);
  withPlanDirectory(root, plan.store_path, (directory) => {
    // The repository queue excludes live stages. Only UUID staging directories are
    // scratch; numeric published revisions and symlink entries are never removed.
    for (const name of directory.names()) {
      if (/^staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) directory.removeDirectory(name);
    }
    const published = readSafe(root, `${destination}/manifest.json`);
    if (published) { manifestFor(plan, saved); return; }
    const stage = `staging-${randomUUID()}`;
    try {
      directory.directory(stage, true, (staging) => {
        for (const file of files) staging.write(file.name, Buffer.from(file.content));
        staging.write("manifest.json", Buffer.from(JSON.stringify(manifest)));
        for (const file of manifest.files) if (digest(staging.read(file.name)!) !== file.sha256) throw new PlanStoreError("Staged plan verification failed");
      });
      beforePublish?.();
      directory.publish(stage, String(saved.revision));
    } catch (error) { directory.removeDirectory(stage); throw error; }
  });
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
