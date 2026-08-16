import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { LlmImageInput } from "@shared/llm.ts";
import type {
  WorkflowAgentEvidenceLocator,
  WorkflowEvidenceImage,
  WorkflowEvidenceRepositoryScope,
  WorkflowRetainedEvidenceLocator,
  WorkflowStagedEvidenceList,
  WorkflowUploadEvidenceLocator,
} from "@shared/workflow.ts";
import { WORKFLOW_IMAGE_LIMITS } from "@shared/workflow.ts";
import { sniffRasterImageMimeType } from "@shared/images.ts";
import { STATE_DIR } from "../config.ts";
import { resolveCheckoutFile, resolveRoots, isIgnored } from "../archives/checkout.ts";
import { isInside } from "../archives/paths.ts";
import {
  scoutRepoSlots,
  findScoutRepoSlot,
  type ScoutRepoTask,
} from "../scouts/repos.ts";
import { resolveImageUpload } from "../uploads.ts";
import { validateLlmImages } from "../llm/images.ts";
import type {
  WorkflowReservedEvidence,
  WorkflowStagedEvidenceWrite,
  WorkflowStore,
  WorkflowSubmissionImageWrite,
} from "./store.ts";

export const WORKFLOW_EVIDENCE_DIR = join(STATE_DIR, "workflow-evidence");
const RETAINED_DIR = join(WORKFLOW_EVIDENCE_DIR, "retained");
const TEMP_DIR = join(WORKFLOW_EVIDENCE_DIR, ".tmp");
const TRASH_DIR = join(WORKFLOW_EVIDENCE_DIR, ".trash");

export class WorkflowImageEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 = 409,
  ) {
    super(message);
    this.name = "WorkflowImageEvidenceError";
  }
}

interface InspectedImage {
  path: string;
  bytes: number;
  mimeType: WorkflowEvidenceImage["mimeType"];
  sha256: string;
  data: Buffer;
}

function cleanDisplayName(value: string): string {
  const printable = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("").trim();
  return (printable || "image").slice(0, WORKFLOW_IMAGE_LIMITS.displayNameChars);
}

function extensionFor(mimeType: WorkflowEvidenceImage["mimeType"]): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
  }
}

function inspectOpenFile(path: string, expected?: {
  bytes: number;
  mimeType: WorkflowEvidenceImage["mimeType"];
  sha256: string;
}): InspectedImage {
  let fd: number | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new WorkflowImageEvidenceError("image_symlink", "Evidence images cannot be symbolic links");
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new WorkflowImageEvidenceError("image_not_file", "Evidence image is not an ordinary file");
    }
    if (before.size <= 0 || before.size > WORKFLOW_IMAGE_LIMITS.maxBytesPerImage) {
      throw new WorkflowImageEvidenceError(
        "image_size",
        `Evidence image must be between 1 and ${WORKFLOW_IMAGE_LIMITS.maxBytesPerImage} bytes`,
      );
    }
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new WorkflowImageEvidenceError("image_changed", "Evidence image changed while it was read");
    }
    const mimeType = sniffRasterImageMimeType(data);
    if (!mimeType) {
      throw new WorkflowImageEvidenceError("image_mime", "Evidence is not a supported raster image");
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    const descriptor: LlmImageInput = {
      id: "staging-validation",
      path,
      mimeType,
      bytes: data.byteLength,
      sha256,
    };
    // Phase 1 remains the final format authority, including the static-GIF rule.
    validateLlmImages([descriptor]);
    if (
      expected
      && (
        expected.bytes !== data.byteLength
        || expected.mimeType !== mimeType
        || expected.sha256 !== sha256
      )
    ) {
      throw new WorkflowImageEvidenceError(
        "image_changed",
        "Evidence image changed after it was staged; register it again",
      );
    }
    return { path, bytes: data.byteLength, mimeType, sha256, data };
  } catch (error) {
    if (error instanceof WorkflowImageEvidenceError) throw error;
    throw new WorkflowImageEvidenceError("image_unreadable", "Evidence image could not be opened safely");
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function inspectCheckoutImage(root: string, locator: string): Promise<InspectedImage> {
  const resolved = await resolveCheckoutFile(root, locator);
  if (!resolved.ok) {
    throw new WorkflowImageEvidenceError("image_path", `Evidence path ${resolved.reason}`);
  }
  const inspected = inspectOpenFile(resolved.path);
  if (inspected.bytes !== resolved.bytes) {
    throw new WorkflowImageEvidenceError("image_changed", "Evidence image changed while it was resolved");
  }
  return inspected;
}

function rootForScope(
  roots: Awaited<ReturnType<typeof resolveRoots>>,
  scope: WorkflowEvidenceRepositoryScope,
): { realRoot: string; slot: string } {
  const selected = scope === "all" ? roots.find((root) => root.primary) ?? roots[0] : roots.find(
    (root) => root.slot === scope,
  );
  if (!selected?.realRoot) {
    throw new WorkflowImageEvidenceError(
      "repository_scope",
      `Repository scope ${scope} was not issued to this task`,
      403,
    );
  }
  return { realRoot: selected.realRoot, slot: selected.slot };
}

export async function stageAgentWorkflowEvidence(input: {
  store: WorkflowStore;
  noteKey: string;
  task: ScoutRepoTask;
  fallbackRoot: string | null;
  images: readonly WorkflowAgentEvidenceLocator[];
  now?: number;
}): Promise<WorkflowStagedEvidenceList> {
  const roots = await resolveRoots(scoutRepoSlots(input.task, input.fallbackRoot));
  const writes: WorkflowStagedEvidenceWrite[] = [];
  let aggregate = 0;
  for (const image of input.images) {
    const selected = rootForScope(roots, image.repositoryScope);
    // Resolve the exact issued root again rather than accepting any caller-provided root.
    if (image.repositoryScope !== "all" && !findScoutRepoSlot(scoutRepoSlots(input.task, input.fallbackRoot), image.repositoryScope)) {
      throw new WorkflowImageEvidenceError("repository_scope", "Evidence repository slot was not issued", 403);
    }
    const inspected = await inspectCheckoutImage(selected.realRoot, image.path);
    if (!(await isIgnored(selected.realRoot, image.path))) {
      throw new WorkflowImageEvidenceError(
        "image_not_ignored",
        "Workflow screenshots must be gitignored and must not be committed",
      );
    }
    aggregate += inspected.bytes;
    if (aggregate > WORKFLOW_IMAGE_LIMITS.maxAggregateBytes) {
      throw new WorkflowImageEvidenceError("image_aggregate", "Workflow evidence exceeds the aggregate byte limit");
    }
    writes.push({
      id: randomUUID(),
      clientItemId: image.clientItemId,
      sourceKind: "agent",
      sourceRoot: selected.realRoot,
      sourceLocator: image.path,
      displayName: cleanDisplayName(basename(image.path)),
      caption: image.caption.trim(),
      repositoryScope: image.repositoryScope,
      mimeType: inspected.mimeType,
      bytes: inspected.bytes,
      sha256: inspected.sha256,
    });
  }
  return input.store.stageWorkflowEvidence(input.noteKey, writes, input.now);
}

export async function stageUploadedWorkflowEvidence(input: {
  store: WorkflowStore;
  noteKey: string;
  task: ScoutRepoTask;
  fallbackRoot: string | null;
  images: readonly WorkflowUploadEvidenceLocator[];
  now?: number;
}): Promise<WorkflowStagedEvidenceList> {
  const roots = await resolveRoots(scoutRepoSlots(input.task, input.fallbackRoot));
  const writes: WorkflowStagedEvidenceWrite[] = [];
  let aggregate = 0;
  for (const image of input.images) {
    const selected = rootForScope(roots, image.repositoryScope);
    const upload = resolveImageUpload(image.uploadId, input.now);
    if (!upload) {
      throw new WorkflowImageEvidenceError("upload_unavailable", "The workflow upload is missing or expired", 410);
    }
    const inspected = inspectOpenFile(upload.path);
    aggregate += inspected.bytes;
    if (aggregate > WORKFLOW_IMAGE_LIMITS.maxAggregateBytes) {
      throw new WorkflowImageEvidenceError("image_aggregate", "Workflow evidence exceeds the aggregate byte limit");
    }
    writes.push({
      id: randomUUID(),
      clientItemId: image.clientItemId,
      sourceKind: "upload",
      // Reservation uses the issued checkout root for scope; capture uses the opaque locator.
      sourceRoot: selected.realRoot,
      sourceLocator: image.uploadId,
      displayName: cleanDisplayName(upload.name),
      caption: image.caption.trim(),
      repositoryScope: image.repositoryScope,
      mimeType: inspected.mimeType,
      bytes: inspected.bytes,
      sha256: inspected.sha256,
    });
  }
  return input.store.stageWorkflowEvidence(input.noteKey, writes, input.now);
}

/** Browser submit is synchronous today; resolve the same issued roots without changing it. */
export function stageUploadedWorkflowEvidenceSync(input: {
  store: WorkflowStore;
  noteKey: string;
  task: ScoutRepoTask;
  fallbackRoot: string | null;
  images: readonly WorkflowUploadEvidenceLocator[];
  now?: number;
}): WorkflowStagedEvidenceList {
  const roots = scoutRepoSlots(input.task, input.fallbackRoot).map((repo) => ({
    ...repo,
    realRoot: repo.root ? (() => {
      try { return realpathSync(repo.root); } catch { return null; }
    })() : null,
  }));
  const writes: WorkflowStagedEvidenceWrite[] = [];
  let aggregate = 0;
  for (const image of input.images) {
    const selected = rootForScope(roots, image.repositoryScope);
    const upload = resolveImageUpload(image.uploadId, input.now);
    if (!upload) {
      throw new WorkflowImageEvidenceError("upload_unavailable", "The workflow upload is missing or expired", 410);
    }
    const inspected = inspectOpenFile(upload.path);
    aggregate += inspected.bytes;
    if (aggregate > WORKFLOW_IMAGE_LIMITS.maxAggregateBytes) {
      throw new WorkflowImageEvidenceError("image_aggregate", "Workflow evidence exceeds the aggregate byte limit");
    }
    writes.push({
      id: randomUUID(),
      clientItemId: image.clientItemId,
      sourceKind: "upload",
      sourceRoot: selected.realRoot,
      sourceLocator: image.uploadId,
      displayName: cleanDisplayName(upload.name),
      caption: image.caption.trim(),
      repositoryScope: image.repositoryScope,
      mimeType: inspected.mimeType,
      bytes: inspected.bytes,
      sha256: inspected.sha256,
    });
  }
  return input.store.stageWorkflowEvidence(input.noteKey, writes, input.now);
}

export function stageRetainedWorkflowEvidence(input: {
  store: WorkflowStore;
  noteKey: string;
  task: ScoutRepoTask;
  fallbackRoot: string | null;
  locator: WorkflowRetainedEvidenceLocator;
  now?: number;
}): WorkflowStagedEvidenceList {
  const record = input.store.submissionImageRecord(input.locator.imageId);
  if (!record || record.availability !== "retained") {
    throw new WorkflowImageEvidenceError("image_unavailable", "Historical evidence image is not retained", 410);
  }
  const roots = scoutRepoSlots(input.task, input.fallbackRoot).map((repo) => ({
    ...repo,
    realRoot: repo.root ? (() => {
      try { return realpathSync(repo.root); } catch { return null; }
    })() : null,
  }));
  const selected = rootForScope(roots, input.locator.repositoryScope);
  const inspected = inspectOpenFile(resolveEvidenceStoragePath(record.storageRelativePath), record);
  return input.store.stageWorkflowEvidence(input.noteKey, [{
    id: randomUUID(),
    clientItemId: input.locator.clientItemId,
    sourceKind: "retained",
    sourceRoot: selected.realRoot,
    sourceLocator: record.storageRelativePath,
    displayName: record.displayName,
    caption: input.locator.caption.trim(),
    repositoryScope: input.locator.repositoryScope,
    mimeType: inspected.mimeType,
    bytes: inspected.bytes,
    sha256: inspected.sha256,
  }], input.now);
}

async function inspectReservedSource(item: WorkflowReservedEvidence): Promise<InspectedImage> {
  const expected = { bytes: item.bytes, mimeType: item.mimeType, sha256: item.sha256 };
  if (item.sourceKind === "agent") {
    const resolved = await resolveCheckoutFile(item.sourceRoot, item.sourceLocator);
    if (!resolved.ok) {
      throw new WorkflowImageEvidenceError("image_path", `Reserved evidence path ${resolved.reason}`);
    }
    return inspectOpenFile(resolved.path, expected);
  }
  if (item.sourceKind === "upload") {
    const upload = resolveImageUpload(item.sourceLocator);
    if (!upload) {
      throw new WorkflowImageEvidenceError("upload_unavailable", "Reserved workflow upload is missing or expired", 410);
    }
    return inspectOpenFile(upload.path, expected);
  }
  const retained = resolveEvidenceStoragePath(item.sourceLocator);
  return inspectOpenFile(retained, expected);
}

function stableImageId(submissionId: string, stagingId: string): string {
  return `img_${createHash("sha256").update(`${submissionId}\0${stagingId}`).digest("hex").slice(0, 32)}`;
}

function writeImmutableCopy(path: string, data: Buffer, expectedSha: string): void {
  if (existsSync(path)) {
    const present = inspectOpenFile(path);
    if (present.sha256 !== expectedSha) {
      throw new WorkflowImageEvidenceError("image_storage_conflict", "Immutable evidence storage conflicts with this capture");
    }
    return;
  }
  mkdirSync(TEMP_DIR, { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(TEMP_DIR, `${randomUUID()}.part`);
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Freeze every reserved source before context compaction or Persona model spend. */
export async function captureSubmissionImages(
  store: WorkflowStore,
  submissionId: string,
  now = Date.now(),
): Promise<WorkflowEvidenceImage[]> {
  const existing = store.listSubmissionImages(submissionId);
  if (existing.length > 0) return existing;
  const reserved = store.listReservedWorkflowEvidence(submissionId);
  if (reserved.length === 0) return [];
  mkdirSync(RETAINED_DIR, { recursive: true });
  const writes: WorkflowSubmissionImageWrite[] = [];
  const created: string[] = [];
  try {
    for (const item of reserved) {
      const inspected = await inspectReservedSource(item);
      const id = stableImageId(submissionId, item.id);
      const storageRelativePath = join(
        "retained",
        submissionId,
        `${id}.${extensionFor(inspected.mimeType)}`,
      );
      const destination = resolveEvidenceStoragePath(storageRelativePath);
      const existed = existsSync(destination);
      writeImmutableCopy(destination, inspected.data, inspected.sha256);
      if (!existed) created.push(destination);
      writes.push({
        id,
        stagingId: item.id,
        ordinal: item.ordinal,
        displayName: item.displayName,
        caption: item.caption,
        repositoryScope: item.repositoryScope,
        mimeType: inspected.mimeType,
        bytes: inspected.bytes,
        sha256: inspected.sha256,
        storageRelativePath,
        createdAt: now,
      });
    }
    return store.finalizeSubmissionImages(submissionId, writes);
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    throw error;
  }
}

export function resolveSubmissionImageInputs(
  store: WorkflowStore,
  submissionId: string,
): readonly LlmImageInput[] {
  const records = store.submissionImageStorageRecords(submissionId);
  const unavailable = records.find((image) => image.availability !== "retained");
  if (unavailable) {
    throw new WorkflowImageEvidenceError("image_pruned", `Evidence image ${unavailable.id} is no longer retained`, 410);
  }
  const inputs = records.map((image): LlmImageInput => ({
    id: image.id,
    path: resolveEvidenceStoragePath(image.storageRelativePath),
    mimeType: image.mimeType,
    bytes: image.bytes,
    sha256: image.sha256,
  }));
  validateLlmImages(inputs);
  return inputs;
}

export function resolveEvidenceStoragePath(storageRelativePath: string): string {
  if (!storageRelativePath || storageRelativePath.includes("\0")) {
    throw new WorkflowImageEvidenceError("image_storage_path", "Evidence storage path is invalid", 404);
  }
  const path = resolve(WORKFLOW_EVIDENCE_DIR, storageRelativePath);
  if (!isInside(WORKFLOW_EVIDENCE_DIR, path) || path === WORKFLOW_EVIDENCE_DIR) {
    throw new WorkflowImageEvidenceError("image_storage_path", "Evidence storage path leaves its owner", 404);
  }
  return path;
}

export function readSubmissionImageBody(store: WorkflowStore, runId: string, imageId: string): {
  image: WorkflowEvidenceImage;
  data: Buffer;
} {
  const record = store.submissionImageRecord(imageId);
  if (!record) throw new WorkflowImageEvidenceError("image_not_found", "No such workflow evidence image", 404);
  const submission = store.getSubmission(record.submissionId);
  if (!submission || submission.runId !== runId) {
    throw new WorkflowImageEvidenceError("image_not_found", "No such workflow evidence image", 404);
  }
  if (record.availability !== "retained") {
    throw new WorkflowImageEvidenceError("image_pruned", "Workflow evidence image has been pruned", 410);
  }
  const inspected = inspectOpenFile(resolveEvidenceStoragePath(record.storageRelativePath), record);
  return { image: record, data: inspected.data };
}

/** Startup-only temp cleanup. Referenced and orphaned retained bodies are left untouched. */
export function reconcileWorkflowEvidenceFiles(store: WorkflowStore): void {
  try {
    mkdirSync(RETAINED_DIR, { recursive: true });
    mkdirSync(TEMP_DIR, { recursive: true });
    mkdirSync(TRASH_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const name of safeDirectoryNames(TEMP_DIR)) {
    rmSync(join(TEMP_DIR, name), { force: true, recursive: true });
  }
  store.processWorkflowImageCleanup((storageRelativePath, trashRelativePath) => {
    const retained = resolveEvidenceStoragePath(storageRelativePath);
    const trash = resolveEvidenceStoragePath(trashRelativePath);
    mkdirSync(dirname(trash), { recursive: true });
    if (existsSync(retained) && !existsSync(trash)) renameSync(retained, trash);
    rmSync(trash, { force: true });
  });
}

/** Count, but never delete, retained files no durable retained row references. */
export function workflowEvidenceOrphanCount(store: WorkflowStore, limit = 1_000): number {
  const referenced = new Set(store.trackedImageStoragePaths().map((path) => path.split(sep).join("/")));
  let count = 0;
  const walk = (directory: string): void => {
    if (count >= limit) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const storage = relative(WORKFLOW_EVIDENCE_DIR, path).split(sep).join("/");
      if (!referenced.has(storage)) count++;
    }
  };
  walk(RETAINED_DIR);
  return count;
}

function safeDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function workflowEvidenceRelativePath(path: string): string {
  const value = relative(WORKFLOW_EVIDENCE_DIR, path);
  if (!value || value.startsWith(`..${sep}`) || value === ".." || extname(value) === ".part") {
    throw new WorkflowImageEvidenceError("image_storage_path", "Evidence path is not retained storage");
  }
  return value;
}
