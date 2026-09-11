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
  WorkflowAgentCommandEvidenceLocator,
  WorkflowAgentTextEvidenceLocator,
  WorkflowEvidenceImage,
  WorkflowEvidenceCoverageClaim,
  WorkflowEvidenceTextArtifact,
  WorkflowEvidenceRepositoryScope,
  WorkflowRetainedEvidenceLocator,
  WorkflowStagedEvidenceList,
  WorkflowSubmission,
  WorkflowUploadEvidenceLocator,
} from "@shared/workflow.ts";
import {
  WORKFLOW_IMAGE_LIMITS,
  WORKFLOW_TEXT_EVIDENCE_LIMITS,
  workflowCommandEvidenceContent,
} from "@shared/workflow.ts";
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
import { WorkflowImageEvidenceError, withEvidenceItem } from "./evidence-error.ts";
import { workflowLog } from "./log.ts";
import { frozenEvidenceId } from "./store.ts";
import type {
  WorkflowInheritableEvidence,
  WorkflowReservedEvidence,
  WorkflowStagedEvidenceWrite,
  WorkflowStagedEvidenceCoverageWrite,
  WorkflowStore,
  WorkflowSubmissionImageWrite,
  WorkflowSubmissionTextArtifactWrite,
} from "./store.ts";

/** Re-exported so every caller that already knew this name keeps its import path. */
export { WorkflowImageEvidenceError };

export const WORKFLOW_EVIDENCE_DIR = join(STATE_DIR, "workflow-evidence");
const RETAINED_DIR = join(WORKFLOW_EVIDENCE_DIR, "retained");
const TEMP_DIR = join(WORKFLOW_EVIDENCE_DIR, ".tmp");
const TRASH_DIR = join(WORKFLOW_EVIDENCE_DIR, ".trash");

interface InspectedImage {
  path: string;
  bytes: number;
  mimeType: WorkflowEvidenceImage["mimeType"];
  sha256: string;
  data: Buffer;
}

interface InspectedTextArtifact {
  path: string;
  bytes: number;
  mimeType: "text/plain";
  sha256: string;
  content: string;
}

// TextDecoder strips a leading BOM unless ignoreBOM is true. Evidence content must retain it
// so its encoded bytes still match the immutable source byte count and digest.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Darwin exposes this open(2) flag but Node does not currently publish it in fs.constants.
// Unlike O_NOFOLLOW, it rejects a symlink in any path component atomically with the open.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

function checkoutOpenFlags(checkoutRoot: string | undefined): number {
  const noFollow = checkoutRoot && process.platform === "darwin"
    ? DARWIN_O_NOFOLLOW_ANY
    : (constants.O_NOFOLLOW ?? 0);
  return constants.O_RDONLY | noFollow;
}

function assertOpenedInsideCheckout(
  fd: number,
  path: string,
  checkoutRoot: string,
  kind: "image" | "artifact",
): void {
  const label = kind === "image" ? "Evidence image" : "Text evidence";
  if (!isInside(checkoutRoot, path)) {
    throw new WorkflowImageEvidenceError(`${kind}_path`, `${label} left its issued checkout`);
  }
  if (process.platform === "darwin") {
    // O_NOFOLLOW_ANY already made path resolution and the open one atomic operation.
    return;
  }
  if (process.platform === "linux") {
    let openedPath: string;
    try {
      openedPath = realpathSync(`/proc/self/fd/${fd}`);
    } catch {
      throw new WorkflowImageEvidenceError(
        `${kind}_path`,
        `${label} opened without a verifiable checkout target`,
      );
    }
    if (!isInside(checkoutRoot, openedPath)) {
      throw new WorkflowImageEvidenceError(
        `${kind}_path`,
        `${label} escaped its issued checkout while it was opened`,
      );
    }
    return;
  }
  throw new WorkflowImageEvidenceError(
    `${kind}_path`,
    `${label} cannot be opened safely on this platform`,
  );
}

function cleanDisplayName(value: string): string {
  const printable = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("").trim();
  return (printable || "image").slice(0, WORKFLOW_IMAGE_LIMITS.displayNameChars);
}

function inspectOpenTextFile(path: string, expected?: {
  bytes: number;
  sha256: string;
}, checkoutRoot?: string): InspectedTextArtifact {
  let fd: number | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new WorkflowImageEvidenceError("artifact_symlink", "Text evidence cannot be a symbolic link");
    }
    fd = openSync(path, checkoutOpenFlags(checkoutRoot));
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new WorkflowImageEvidenceError("artifact_not_file", "Text evidence is not an ordinary file");
    }
    if (checkoutRoot) assertOpenedInsideCheckout(fd, path, checkoutRoot, "artifact");
    if (before.size <= 0 || before.size > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact) {
      throw new WorkflowImageEvidenceError(
        "artifact_size",
        `Text evidence must be between 1 and ${WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact} bytes`,
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
      throw new WorkflowImageEvidenceError("artifact_changed", "Text evidence changed while it was read");
    }
    let content: string;
    try {
      content = strictUtf8.decode(data);
    } catch {
      throw new WorkflowImageEvidenceError("artifact_encoding", "Text evidence must be valid UTF-8");
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (expected && (expected.bytes !== data.byteLength || expected.sha256 !== sha256)) {
      throw new WorkflowImageEvidenceError(
        "artifact_changed",
        "Text evidence changed after it was staged; register it again",
      );
    }
    return { path, bytes: data.byteLength, mimeType: "text/plain", sha256, content };
  } catch (error) {
    if (error instanceof WorkflowImageEvidenceError) throw error;
    throw new WorkflowImageEvidenceError("artifact_unreadable", "Text evidence could not be opened safely");
  } finally {
    if (fd !== null) closeSync(fd);
  }
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
}, checkoutRoot?: string): InspectedImage {
  let fd: number | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new WorkflowImageEvidenceError("image_symlink", "Evidence images cannot be symbolic links");
    }
    fd = openSync(path, checkoutOpenFlags(checkoutRoot));
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new WorkflowImageEvidenceError("image_not_file", "Evidence image is not an ordinary file");
    }
    if (checkoutRoot) assertOpenedInsideCheckout(fd, path, checkoutRoot, "image");
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
  const inspected = inspectOpenFile(resolved.path, undefined, root);
  if (inspected.bytes !== resolved.bytes) {
    throw new WorkflowImageEvidenceError("image_changed", "Evidence image changed while it was resolved");
  }
  return inspected;
}

async function inspectCheckoutTextArtifact(root: string, locator: string): Promise<InspectedTextArtifact> {
  const resolved = await resolveCheckoutFile(root, locator);
  if (!resolved.ok) {
    throw new WorkflowImageEvidenceError("artifact_path", `Text evidence path ${resolved.reason}`);
  }
  const inspected = inspectOpenTextFile(resolved.path, undefined, root);
  if (inspected.bytes !== resolved.bytes) {
    throw new WorkflowImageEvidenceError("artifact_changed", "Text evidence changed while it was resolved");
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
  artifacts?: readonly WorkflowAgentTextEvidenceLocator[];
  commandOutputs?: readonly WorkflowAgentCommandEvidenceLocator[];
  coverage?: readonly WorkflowEvidenceCoverageClaim[];
  now?: number;
  episodeKey?: string | null;
}): Promise<WorkflowStagedEvidenceList> {
  const roots = await resolveRoots(scoutRepoSlots(input.task, input.fallbackRoot));
  const writes: WorkflowStagedEvidenceWrite[] = [];
  const coverageWrites: WorkflowStagedEvidenceCoverageWrite[] = [];
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
  let artifactAggregate = 0;
  for (const artifact of input.artifacts ?? []) {
    const selected = rootForScope(roots, artifact.repositoryScope);
    if (
      artifact.repositoryScope !== "all"
      && !findScoutRepoSlot(
        scoutRepoSlots(input.task, input.fallbackRoot),
        artifact.repositoryScope,
      )
    ) {
      throw new WorkflowImageEvidenceError("repository_scope", "Evidence repository slot was not issued", 403);
    }
    const inspected = await inspectCheckoutTextArtifact(selected.realRoot, artifact.path);
    if (!(await isIgnored(selected.realRoot, artifact.path))) {
      throw new WorkflowImageEvidenceError(
        "artifact_not_ignored",
        "Workflow text evidence must be gitignored and must not be committed",
      );
    }
    artifactAggregate += inspected.bytes;
    if (artifactAggregate > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes) {
      throw new WorkflowImageEvidenceError(
        "artifact_aggregate",
        "Workflow text evidence exceeds the aggregate byte limit",
      );
    }
    writes.push({
      id: randomUUID(),
      clientItemId: artifact.clientItemId,
      sourceKind: "agent",
      evidenceKind: "text",
      sourceRoot: selected.realRoot,
      sourceLocator: artifact.path,
      displayName: cleanDisplayName(basename(artifact.path)),
      caption: artifact.caption.trim(),
      repositoryScope: artifact.repositoryScope,
      mimeType: "text/plain",
      bytes: inspected.bytes,
      sha256: inspected.sha256,
    });
  }
  for (const commandOutput of input.commandOutputs ?? []) {
    const selected = rootForScope(roots, commandOutput.repositoryScope);
    if (
      commandOutput.repositoryScope !== "all"
      && !findScoutRepoSlot(
        scoutRepoSlots(input.task, input.fallbackRoot),
        commandOutput.repositoryScope,
      )
    ) {
      throw new WorkflowImageEvidenceError("repository_scope", "Evidence repository slot was not issued", 403);
    }
    const content = workflowCommandEvidenceContent(commandOutput);
    const data = Buffer.from(content, "utf8");
    artifactAggregate += data.byteLength;
    if (
      data.byteLength > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact
      || artifactAggregate > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes
    ) {
      throw new WorkflowImageEvidenceError(
        "artifact_aggregate",
        "Workflow text evidence exceeds its byte limit",
      );
    }
    writes.push({
      id: randomUUID(),
      clientItemId: commandOutput.clientItemId,
      sourceKind: "command",
      evidenceKind: "text",
      sourceRoot: selected.realRoot,
      // The staged-evidence API and Foreman prompt expose this locator. Keep it opaque:
      // a command line may carry inline credentials or secret-bearing arguments. The exact
      // command remains only in the bounded captured artifact the agent explicitly registered.
      sourceLocator: `command:${commandOutput.clientItemId}`,
      inlineContent: content,
      commandExitCode: commandOutput.exitCode,
      displayName: cleanDisplayName(`${commandOutput.clientItemId}-command-output.txt`),
      caption: commandOutput.caption.trim(),
      repositoryScope: commandOutput.repositoryScope,
      mimeType: "text/plain",
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  for (const claim of input.coverage ?? []) {
    const selected = rootForScope(roots, claim.repositoryScope);
    coverageWrites.push({
      ...claim,
      id: randomUUID(),
      sourceRoot: selected.realRoot,
    });
  }
  return input.store.stageWorkflowEvidence(
    input.noteKey,
    writes,
    input.now,
    input.episodeKey ?? null,
    coverageWrites,
  );
}

export async function stageUploadedWorkflowEvidence(input: {
  store: WorkflowStore;
  noteKey: string;
  task: ScoutRepoTask;
  fallbackRoot: string | null;
  images: readonly WorkflowUploadEvidenceLocator[];
  now?: number;
  episodeKey?: string | null;
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
  return input.store.stageWorkflowEvidence(input.noteKey, writes, input.now, input.episodeKey ?? null);
}

/** Browser submit is synchronous today; resolve the same issued roots without changing it. */
export function stageUploadedWorkflowEvidenceSync(input: {
  store: WorkflowStore;
  noteKey: string;
  task: ScoutRepoTask;
  fallbackRoot: string | null;
  images: readonly WorkflowUploadEvidenceLocator[];
  now?: number;
  episodeKey?: string | null;
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
  return input.store.stageWorkflowEvidence(input.noteKey, writes, input.now, input.episodeKey ?? null);
}

export function stageRetainedWorkflowEvidence(input: {
  store: WorkflowStore;
  noteKey: string;
  task: ScoutRepoTask;
  fallbackRoot: string | null;
  locator: WorkflowRetainedEvidenceLocator;
  now?: number;
  episodeKey?: string | null;
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
  }], input.now, input.episodeKey ?? null);
}

/**
 * Re-read one reserved row's source, naming the row when it refuses.
 *
 * The identity is attached here because this is the only frame holding both the row and the
 * refusal - `inspectOpenFile` sees a path, `resolveCheckoutFile` sees a locator. No error code
 * changes; route handlers and the manager's capture branch switch on those.
 */
async function inspectReservedSource(item: WorkflowReservedEvidence): Promise<InspectedImage> {
  try {
    return await inspectReservedSourceBytes(item);
  } catch (error) {
    if (!(error instanceof WorkflowImageEvidenceError)) throw error;
    throw withEvidenceItem(error, {
      displayName: item.displayName,
      clientItemId: item.clientItemId,
    });
  }
}

async function inspectReservedSourceBytes(item: WorkflowReservedEvidence): Promise<InspectedImage> {
  if (item.evidenceKind === "text" || item.mimeType === "text/plain") {
    throw new WorkflowImageEvidenceError("image_mime", "Reserved evidence is not an image");
  }
  const expected = {
    bytes: item.bytes,
    mimeType: item.mimeType as WorkflowEvidenceImage["mimeType"],
    sha256: item.sha256,
  };
  if (item.sourceKind === "agent") {
    const resolved = await resolveCheckoutFile(item.sourceRoot, item.sourceLocator);
    if (!resolved.ok) {
      throw new WorkflowImageEvidenceError("image_path", `Reserved evidence path ${resolved.reason}`);
    }
    return inspectOpenFile(resolved.path, expected, item.sourceRoot);
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

/** The retained body for a digest, or null when nothing on disk can be trusted for it. */
function shareableStoragePath(store: WorkflowStore, sha256: string): string | null {
  const candidate = store.retainedImageStoragePathForDigest(sha256);
  if (!candidate) return null;
  try {
    const path = resolveEvidenceStoragePath(candidate);
    return existsSync(path) && inspectOpenFile(path).sha256 === sha256 ? candidate : null;
  } catch {
    return null;
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
  const reserved = store.listReservedWorkflowEvidence(submissionId)
    .filter((item) => (item.evidenceKind ?? "image") === "image");
  if (reserved.length === 0) return [];
  mkdirSync(RETAINED_DIR, { recursive: true });
  const writes: WorkflowSubmissionImageWrite[] = [];
  const created: string[] = [];
  // Digests frozen by THIS call, which no query can see yet: the rows are inserted together
  // once every source has been read. Without it a submission that proves the same bytes under
  // two captions writes the file twice and only later captures get to share it.
  const writtenHere = new Map<string, string>();
  // Digests whose body this call did NOT write, keyed to the bytes and to the path this
  // submission would own. Only these can be taken away underneath the capture, and only these
  // are re-checked below.
  const borrowed = new Map<string, { data: Buffer; ownPath: string }>();
  try {
    for (const item of reserved) {
      const inspected = await inspectReservedSource(item);
      const id = frozenEvidenceId("img", submissionId, item.id);
      /*
       * These exact bytes, wherever they already live.
       *
       * A digest that is already retained has a body on disk that is byte-identical by
       * definition, so the only thing a second copy would add is a second file to delete.
       * The row is a claim about the filesystem rather than the filesystem itself, so the
       * shared path is re-inspected before it is trusted: a body that has gone missing or
       * disagrees with its digest sends this capture back to writing its own copy instead of
       * freezing a reference to nothing.
       */
      const shared = writtenHere.get(inspected.sha256)
        ?? shareableStoragePath(store, inspected.sha256);
      const ownPath = join("retained", submissionId, `${id}.${extensionFor(inspected.mimeType)}`);
      const storageRelativePath = shared ?? ownPath;
      if (!shared) {
        const destination = resolveEvidenceStoragePath(storageRelativePath);
        const existed = existsSync(destination);
        writeImmutableCopy(destination, inspected.data, inspected.sha256);
        if (!existed) created.push(destination);
      }
      writtenHere.set(inspected.sha256, storageRelativePath);
      if (shared) borrowed.set(inspected.sha256, { data: inspected.data, ownPath });
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
    /*
     * A borrowed body can be deleted between choosing it and recording the row that reads it.
     *
     * `shareableStoragePath` checks the body it selects, but the loop above then awaits the
     * next source. Retention sweeps on a timer, and one sweep prunes a run and then calls
     * `reconcileWorkflowEvidenceFiles`, which deletes the queued bodies - so a body this
     * capture chose can be gone before the row that would have protected it exists. The
     * enqueue guard cannot see a row that has not been inserted yet.
     *
     * This pass runs with no `await` between it and `finalizeSubmissionImages`, which is
     * synchronous, so nothing can interleave: on one thread, that is the whole race closed.
     * A body that vanished or no longer matches is REWRITTEN to a path this submission owns
     * rather than refused, because the bytes are still in hand and refusing would fail a
     * capture over a file another run happened to reclaim.
     */
    for (const [sha256, body] of borrowed) {
      const current = writtenHere.get(sha256);
      if (!current) continue;
      const path = resolveEvidenceStoragePath(current);
      let intact = false;
      try {
        intact = existsSync(path) && inspectOpenFile(path).sha256 === sha256;
      } catch {
        intact = false;
      }
      if (intact) continue;
      const destination = resolveEvidenceStoragePath(body.ownPath);
      const existed = existsSync(destination);
      writeImmutableCopy(destination, body.data, sha256);
      if (!existed) created.push(destination);
      writtenHere.set(sha256, body.ownPath);
      for (const write of writes) {
        if (write.sha256 === sha256) write.storageRelativePath = body.ownPath;
      }
    }
    return store.finalizeSubmissionImages(submissionId, writes);
  } catch (error) {
    // Only bodies this call brought into existence, and only while nothing has claimed them.
    // `created` already excludes a path that was present beforehand; the reference test covers
    // the remaining case, where a concurrent capture of the same digest finalized its own row
    // against a body this one had just written.
    for (const path of created) {
      if (store.imageStoragePathIsReferenced(workflowEvidenceRelativePath(path))) continue;
      rmSync(path, { force: true });
    }
    throw error;
  }
}

/** The text twin of `inspectReservedSource`, wrapped at the same frame for the same reason. */
async function inspectReservedTextSource(
  item: WorkflowReservedEvidence,
): Promise<InspectedTextArtifact> {
  try {
    return await inspectReservedTextSourceBytes(item);
  } catch (error) {
    if (!(error instanceof WorkflowImageEvidenceError)) throw error;
    throw withEvidenceItem(error, {
      displayName: item.displayName,
      clientItemId: item.clientItemId,
    });
  }
}

async function inspectReservedTextSourceBytes(
  item: WorkflowReservedEvidence,
): Promise<InspectedTextArtifact> {
  if (item.sourceKind === "agent") {
    const resolved = await resolveCheckoutFile(item.sourceRoot, item.sourceLocator);
    if (!resolved.ok) {
      throw new WorkflowImageEvidenceError("artifact_path", `Reserved text evidence path ${resolved.reason}`);
    }
    return inspectOpenTextFile(
      resolved.path,
      { bytes: item.bytes, sha256: item.sha256 },
      item.sourceRoot,
    );
  }
  if (item.sourceKind === "command" && item.inlineContent !== null && item.inlineContent !== undefined) {
    const data = Buffer.from(item.inlineContent, "utf8");
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (data.byteLength !== item.bytes || sha256 !== item.sha256) {
      throw new WorkflowImageEvidenceError(
        "artifact_changed",
        "Reserved command evidence no longer matches its registered bytes",
      );
    }
    return {
      path: item.sourceLocator,
      bytes: data.byteLength,
      mimeType: "text/plain",
      sha256,
      content: item.inlineContent,
    };
  }
  throw new WorkflowImageEvidenceError("artifact_source", "Reserved text evidence has an invalid source");
}

/** Freeze every reserved UTF-8 text/log source before context compaction or Persona spend. */
export async function captureSubmissionTextArtifacts(
  store: WorkflowStore,
  submissionId: string,
  now = Date.now(),
): Promise<WorkflowEvidenceTextArtifact[]> {
  const existing = store.listSubmissionTextArtifacts(submissionId);
  if (existing.length > 0) return existing;
  const reserved = store.listReservedWorkflowEvidence(submissionId)
    .filter((item) => item.evidenceKind === "text");
  if (reserved.length === 0) return [];
  const writes: WorkflowSubmissionTextArtifactWrite[] = [];
  let aggregate = 0;
  for (const item of reserved) {
    const inspected = await inspectReservedTextSource(item);
    aggregate += inspected.bytes;
    if (aggregate > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes) {
      throw new WorkflowImageEvidenceError(
        "artifact_aggregate",
        "Workflow text evidence exceeds the aggregate byte limit",
      );
    }
    writes.push({
      id: frozenEvidenceId("txt", submissionId, item.id),
      stagingId: item.id,
      ordinal: item.ordinal,
      displayName: item.displayName,
      caption: item.caption,
      repositoryScope: item.repositoryScope,
      mimeType: "text/plain",
      bytes: inspected.bytes,
      sha256: inspected.sha256,
      content: inspected.content,
      createdAt: now,
    });
  }
  return store.finalizeSubmissionTextArtifacts(submissionId, writes);
}

/**
 * Does this carried item still describe the source it was captured from?
 *
 * Only a repository path can answer. A completed command's bytes are frozen in the staging
 * row itself and have no live source to drift from; an upload and a retained reattachment
 * name daemon-owned storage, not the tree under review. Those carry unconditionally, and the
 * mark is what tells a Persona how old they are.
 *
 * A path that no longer resolves is NOT a change. A gitignored screenshot that the agent has
 * since deleted is exactly the artifact this phase exists to keep in front of a reviewer, and
 * refusing to carry it would reproduce the failure by a different route. Only a path that
 * still reads and reads DIFFERENTLY is dropped, because that is the one case where the bytes
 * demonstrably no longer describe what they name.
 */
async function carriedEvidenceStillMatches(item: WorkflowInheritableEvidence): Promise<boolean> {
  if (item.sourceKind !== "agent" || !item.sourceRoot || !item.sourceLocator) return true;
  try {
    const resolved = await resolveCheckoutFile(item.sourceRoot, item.sourceLocator);
    // The expected case, and the only one that is not a surprise: the path no longer names a
    // readable file in the checkout. That is the gitignored capture the agent has since
    // deleted, and it is reported as a result rather than thrown, so it returns quietly.
    if (!resolved.ok) return true;
    const inspected = item.kind === "image"
      ? inspectOpenFile(resolved.path, undefined, item.sourceRoot)
      : inspectOpenTextFile(resolved.path, undefined, item.sourceRoot);
    return inspected.sha256 === item.sha256;
  } catch (error) {
    /*
     * An unexpected failure still carries, and says so.
     *
     * The expected outcome returned above rather than throwing, so anything reaching here is a
     * surprise: a permission error, a transient read fault, a bug in the inspectors. Carrying
     * is still the right fallback, because none of those is evidence that the source CHANGED
     * and dropping a Persona's proof over one would be the worse answer. What they do mean is
     * that this item's staleness went unverified, and a systematic failure would otherwise
     * degrade verification across every carry with nothing to show for it.
     *
     * Deliberately spanning the resolve as well as the inspect. Letting a throw escape this
     * function would abort the whole capture, turning a single unreadable carried item into a
     * failed submission - a far worse outcome than carrying it with its mark and a log line.
     */
    workflowLog("warn", {
      event: "evidence_carry_unverified",
      error: error instanceof Error ? error.message : "unknown_read_failure",
    });
    return true;
  }
}

/**
 * Carry the previous submission's evidence into this one, so sufficiency survives a round.
 *
 * Runs after this submission has frozen whatever it staged itself, and adds only what is
 * missing. Two policies, chosen by `evidenceInheritanceSource`:
 *
 * - An `evidence_preflight` refinement child repairs a coverage MAPPING inside one round. Its
 *   tree is its parent's tree, so its parent's evidence is carried wholesale and is not
 *   re-read. Re-reading would be worse than useless here: the observed run's round-1
 *   screenshot was a gitignored file the agent had already removed, so verification would
 *   drop the very artifact the carry exists to preserve.
 * - A new repair round's first submission carries across a tree that HAS moved. Each carried
 *   item is checked against its source where that source still reads, and dropped when the
 *   source now says something different.
 *
 * Returns how many items were carried, so the caller knows whether to re-read the submission's
 * frozen sets.
 */
export async function inheritSubmissionEvidence(
  store: WorkflowStore,
  submission: WorkflowSubmission,
  now = Date.now(),
): Promise<number> {
  const resolved = store.evidenceInheritanceSource(submission);
  if (!resolved) return 0;
  const candidates = store.listInheritableSubmissionEvidence(resolved.source.id);
  const carried: string[] = [];
  for (const item of candidates) {
    if (resolved.mode === "round" && !(await carriedEvidenceStillMatches(item))) continue;
    carried.push(item.stagingId);
  }
  return store.inheritSubmissionEvidence({
    submissionId: submission.id,
    sourceSubmissionId: resolved.source.id,
    stagingIds: carried,
    now,
  });
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
