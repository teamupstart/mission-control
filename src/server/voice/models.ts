import { supportsSherpaHelpers } from "@shared/sherpa-platform.ts";
import { release } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { envVar, stateDir } from "../../shared/harness-runtime.mjs";
import {
  resolveVoiceBackend,
  voiceModelBytes,
  voiceModelFileUrl,
  VOICE_MODELS,
  VOICE_SPEECH_MODELS,
  VoiceModelManifestsSchema,
  type VoiceModelFile,
  type VoiceModelManifest,
  type VoiceModelManifests,
} from "@shared/voice-models.ts";
import {
  VOICE_FLAG,
  VOICE_MODEL_STATE_NONE,
  type VoiceBackend,
  type VoiceModelState,
} from "@shared/voice.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { getVoiceConfig } from "./config.ts";

// The daemon's speech-model manager (contract H). It owns `<state home>/voice/models/` and
// `VoiceState.model`: it checks what is on disk, downloads a missing or broken model on request,
// and says which of `missing`, `downloading`, `verifying`, `ready` or `failed` holds.
//
// Nothing is stored about a model except its files. `ready` is earned in this daemon's lifetime,
// by hashing every file against the manifest's SHA-256 while it downloads or, for a model already
// on disk, again at start before it reads ready. A same-size edit to a file is therefore refused
// at the next start, which a stored record or a size check would have let through.

/** How often progress is published at most, so a download is a few frames a second. */
const PROGRESS_EVERY_MS = 250;
/** A download that receives nothing for this long fails rather than hanging. */
const STALL_MS = 60_000;
const RATE_WINDOW_MS = 3_000;

export interface VoiceModelManagerDeps {
  /** `<state home>/voice/models`. Read on each use, so a test's home applies. */
  root(): string;
  /** Recognition uses a backend directory. All synthesis revisions live under speech/. */
  namespace?: "speech";
  /** Whether the `voice` flag is on. While it is off the manager reads nothing and holds nothing. */
  active(): boolean;
  /** The backend the configured choice resolves to on this machine. */
  backend(): VoiceBackend;
  manifests(): VoiceModelManifests;
  /** `MISSION_VOICE_MODEL_BASE_URL`, or null for the manifest's own URLs. */
  baseUrl(): string | null;
  fetch?: typeof fetch;
  now?(): number;
  progressEveryMs?: number;
  stallMs?: number;
  /** Removes a cancelled download's directory. Defaults to a recursive, forced `rm`. */
  removeDir?(path: string): Promise<void>;
}

export type VoiceModelDownloadResult =
  | { ok: true; model: VoiceModelState }
  | { ok: false; reason: string; model: VoiceModelState };

/** Why a job was stopped: the operator's Cancel, or the manager moving on (flag off, new backend). */
type StopReason = "cancel" | "superseded";

interface Job {
  kind: "verify" | "download";
  backend: VoiceBackend;
  revision: string;
  controller: AbortController;
  done: Promise<void>;
}

class StopSignal extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}

function duration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`;
}

function stopReasonOf(signal: AbortSignal): StopReason | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof StopSignal ? signal.reason.reason : "superseded";
}

/**
 * One model manager per daemon. Every change reaches `onChange` listeners, which the voice state
 * store turns into a `voice_state` frame; progress is published at most every 250 ms.
 */
export class VoiceModelManager {
  private model: VoiceModelState = { ...VOICE_MODEL_STATE_NONE };
  private job: Job | null = null;
  /** Jobs stopped but still unwinding: closing a write, removing a temporary file. */
  private readonly settling = new Set<Promise<void>>();
  /**
   * Revision directories a cancelled download is still removing, each with the cancelled job's
   * `done`. A download into one waits for it, and a check reads it as `missing`, so a removal never
   * deletes files a later download wrote.
   */
  private readonly removing = new Map<string, Promise<void>>();
  private readonly launchChecks = new Map<string, { controller: AbortController; done: Promise<boolean>; callers: number }>();
  /** The backend and revision the model state describes, or null before the first check. */
  private target: { backend: VoiceBackend; revision: string | null } | null = null;
  private readonly listeners = new Set<(model: VoiceModelState) => void>();
  private lastPublished = "";
  private lastProgressAt = 0;
  /** A throttled progress reading still to be published, so the last one is never held back. */
  private trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: VoiceModelManagerDeps) {}

  state(): VoiceModelState {
    return { ...this.model };
  }

  /** Standalone launchers use the same selection, files and verified directory as Setup. */
  async listenerModel(override: VoiceBackend | undefined, signal: AbortSignal) {
    const selected = this.deps.backend();
    const backend = override ?? selected;
    const manifest = this.manifest(backend);
    if (!manifest) return null;
    if (backend === selected) {
      this.sync();
      const { status, revision, directory } = this.model;
      return status === "ready" && revision === manifest.revision && directory
        ? { backend, manifest, directory } : null;
    }
    // A CLI override can use a previously installed backend without changing the operator's selection.
    const directory = this.revisionDir(backend, manifest.revision);
    signal.throwIfAborted();
    let check = this.launchChecks.get(directory);
    if (!check) {
      const controller = new AbortController();
      check = { controller, done: this.verifyInstall(directory, manifest, controller.signal), callers: 0 };
      this.launchChecks.set(directory, check);
    }
    check.callers++;
    let rejectDisconnected!: (reason: unknown) => void;
    const disconnected = new Promise<never>((_, reject) => { rejectDisconnected = reject; });
    const onAbort = () => rejectDisconnected(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([check.done, disconnected]) ? { backend, manifest, directory } : null;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (--check.callers === 0) {
        this.launchChecks.delete(directory);
        check.controller.abort();
      }
    }
  }

  private async verifyInstall(directory: string, manifest: VoiceModelManifest, signal: AbortSignal): Promise<boolean> {
    for (const file of manifest.files) {
      if (!await this.alreadyVerified(join(directory, file.path), file, signal)) return false;
    }
    return true;
  }

  onChange(listener: (model: VoiceModelState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Bring the manager in line with the flag and the configured backend. With the flag off, stop
   * whatever is running and read nothing. With it on, check the backend's model on disk the first
   * time, and again whenever the backend or its manifest revision changes.
   */
  sync(): void {
    if (!this.deps.active()) {
      this.stopJob("superseded");
      this.target = null;
      this.set({ ...VOICE_MODEL_STATE_NONE });
      return;
    }
    const backend = this.deps.backend();
    const revision = this.manifest(backend)?.revision ?? null;
    if (this.target && this.target.backend === backend && this.target.revision === revision) return;
    this.stopJob("superseded");
    this.check();
  }

  /**
   * Download the model, or confirm one already verified. A download already running is not
   * started twice. Files already on disk at their pinned size are hashed and kept when they match,
   * so a Retry after a failed file fetches only what is missing or wrong.
   */
  download(): VoiceModelDownloadResult {
    if (!this.deps.active()) return { ok: false, reason: "Voice addressing is off.", model: this.state() };
    if (!this.target) this.check();
    const backend = this.deps.backend();
    const manifest = this.manifest(backend);
    if (!manifest) {
      return { ok: false, reason: this.model.error ?? `No speech model for ${backend} is available in this build.`, model: this.state() };
    }
    const running = this.job;
    // A cancelled download still removing its files is replaced at once: the new job waits for
    // the removal before it touches the directory, and a later Cancel stops the new job.
    if (running?.kind === "download" && !running.controller.signal.aborted) return { ok: true, model: this.state() };
    if (this.model.status === "ready" && this.model.revision === manifest.revision) return { ok: true, model: this.state() };
    this.stopJob("superseded");
    this.startDownload(backend, manifest);
    return { ok: true, model: this.state() };
  }

  /**
   * Stop a running download and remove what it wrote of the revision, which never verified.
   * Resolves once the files are gone, with the state the disk now gives.
   */
  async cancel(): Promise<VoiceModelState> {
    const job = this.job;
    if (job?.kind !== "download") return this.state();
    if (job.controller.signal.aborted) {
      // A second Cancel while the first is still removing the files.
      await job.done;
      return this.state();
    }
    job.controller.abort(new StopSignal("cancel"));
    // Registered now, before the job unwinds, so nothing started in the meantime can write into
    // the directory this Cancel is about to remove.
    const dir = this.revisionDir(job.backend, job.revision);
    const settled = job.done;
    this.removing.set(dir, settled);
    void settled.finally(() => { if (this.removing.get(dir) === settled) this.removing.delete(dir); });
    await settled;
    return this.state();
  }

  /** Waits out stopped jobs too, which may still be removing a temporary file. */
  async idle(): Promise<void> {
    while (this.job || this.settling.size > 0) {
      await Promise.all([this.job?.done, ...this.settling]);
    }
  }

  async stop(): Promise<void> {
    this.stopJob("superseded");
    await this.idle();
    this.clearTrailing();
    this.target = null;
    this.model = { ...VOICE_MODEL_STATE_NONE };
    this.lastPublished = "";
  }

  // ---- checking what is on disk ----

  private manifest(backend: VoiceBackend): VoiceModelManifest | null {
    return this.deps.manifests()[backend] ?? null;
  }

  private revisionDir(backend: VoiceBackend, revision: string): string {
    return join(this.deps.root(), this.deps.namespace ?? backend, revision);
  }

  private base(backend: VoiceBackend, manifest: VoiceModelManifest | null): VoiceModelState {
    return {
      ...VOICE_MODEL_STATE_NONE,
      backend,
      revision: manifest?.revision ?? null,
      totalBytes: manifest ? voiceModelBytes(manifest) : 0,
    };
  }

  /**
   * Read the backend's model from disk. Sizes are read at once, so a missing file or a wrong size
   * is known before anything is published; a model whose every file is the right size reads
   * `verifying` while each is hashed again, and `ready` only when every digest matches.
   */
  private check(): void {
    const backend = this.deps.backend();
    const manifest = this.manifest(backend);
    this.target = { backend, revision: manifest?.revision ?? null };
    if (!manifest) {
      this.set({ ...this.base(backend, null), error: `No speech model for ${backend} is available in this build yet.` });
      return;
    }
    const dir = this.revisionDir(backend, manifest.revision);
    const base = this.base(backend, manifest);
    if (this.removing.has(dir)) {
      this.set({ ...base, status: "missing" });
      return;
    }
    for (const file of manifest.files) {
      let size: number;
      try {
        const stat = statSync(join(dir, file.path));
        if (!stat.isFile()) throw new Error("not a file");
        size = stat.size;
      } catch {
        this.set({ ...base, status: "missing" });
        return;
      }
      if (size !== file.bytes) {
        this.set({
          ...base,
          status: "failed",
          error: `${file.path} is ${size} bytes on disk, and its pinned size is ${file.bytes}. Download it again.`,
        });
        return;
      }
    }
    this.set({ ...base, status: "verifying" });
    this.run("verify", backend, manifest.revision, async (signal) => {
      let done = 0;
      for (const file of manifest.files) {
        const digest = await this.hashFile(join(dir, file.path), signal, (bytes) => {
          done += bytes;
          if (!signal.aborted) this.progress({ ...base, status: "verifying", doneBytes: done });
        });
        signal.throwIfAborted();
        if (digest !== file.sha256) {
          this.set({
            ...base,
            status: "failed",
            error: `${file.path} does not match its pinned SHA-256 checksum. Download it again.`,
          });
          return;
        }
      }
      await this.markReady(backend, manifest, dir, signal);
    }, (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.set(missing ? { ...base, status: "missing" } : { ...base, status: "failed", error: `The speech model could not be read: ${errorText(error)}` });
    });
  }

  private async markReady(backend: VoiceBackend, manifest: VoiceModelManifest, dir: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.removeOtherRevisions(backend, manifest.revision);
    signal.throwIfAborted();
    this.set({ ...this.base(backend, manifest), status: "ready", doneBytes: voiceModelBytes(manifest), directory: dir });
  }

  private async removeOtherRevisions(backend: VoiceBackend, keep: string): Promise<void> {
    const parent = join(this.deps.root(), this.deps.namespace ?? backend);
    let entries: string[];
    try { entries = await readdir(parent); }
    catch { return; }
    await Promise.all(entries.filter((name) => name !== keep).map((name) =>
      rm(join(parent, name), { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(`[voice] could not remove the old speech model ${name}:`, errorText(error));
      })));
  }

  // ---- downloading ----

  private startDownload(backend: VoiceBackend, manifest: VoiceModelManifest): void {
    const dir = this.revisionDir(backend, manifest.revision);
    const base = this.base(backend, manifest);
    const now = this.deps.now ?? Date.now;
    let done = 0;
    // Bytes that came over the network, sampled for the rate. A file already on disk advances
    // `done` but not this, so a resumed download does not report a burst of speed.
    let fetched = 0;
    const samples: { at: number; bytes: number }[] = [];
    const rate = (): number | null => {
      const at = now();
      samples.push({ at, bytes: fetched });
      while (samples.length > 2 && at - samples[0]!.at > RATE_WINDOW_MS) samples.shift();
      const first = samples[0]!;
      const elapsed = at - first.at;
      return elapsed >= 500 ? Math.round(((fetched - first.bytes) * 1000) / elapsed) : null;
    };
    this.set({ ...base, status: "downloading" });
    this.run("download", backend, manifest.revision, async (signal) => {
      await this.removing.get(dir);
      signal.throwIfAborted();
      await mkdir(dir, { recursive: true });
      await this.removeLeftoverParts(dir);
      for (const file of manifest.files) {
        signal.throwIfAborted();
        const target = join(dir, file.path);
        // A file already on disk counts once its checksum matches, so one that fails the check
        // never moves the bar forward and then back.
        if (await this.alreadyVerified(target, file, signal)) {
          done += file.bytes;
          if (!signal.aborted) this.progress({ ...base, status: "downloading", doneBytes: done, bytesPerSecond: rate() });
          continue;
        }
        await this.fetchFile(file, target, signal, (bytes) => {
          done += bytes;
          fetched += bytes;
          if (!signal.aborted) this.progress({ ...base, status: "downloading", doneBytes: done, bytesPerSecond: rate() });
        });
      }
      await this.markReady(backend, manifest, dir, signal);
    }, (error) => {
      this.set({ ...base, status: "failed", error: errorText(error) });
    }, async (reason, current) => {
      // The operator's Cancel removes the revision: none of it verified as a whole, and a
      // download stopped on purpose leaves nothing behind. Superseded work keeps the files it
      // completed, each already checked, so the next Download resumes rather than starts over.
      if (reason !== "cancel") return;
      // The files go either way, but the state changes only while this is still the manager's
      // job and voice is on. A flag switched off, a backend changed or a new Download during the
      // removal has already set the state, and a re-read here would overwrite it.
      const owns = () => current() && this.deps.active();
      try {
        await (this.deps.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true })))(dir);
      } catch (error) {
        // Left as `downloading` with no job, the row would offer a Cancel that does nothing.
        if (owns()) this.set({ ...base, status: "failed", error: `The cancelled download could not be removed: ${errorText(error)}` });
        return;
      }
      if (!owns()) return;
      this.target = null;
      this.check();
    });
  }

  private async alreadyVerified(target: string, file: VoiceModelFile, signal: AbortSignal): Promise<boolean> {
    try {
      if (statSync(target).size !== file.bytes) return false;
    } catch {
      return false;
    }
    try {
      return (await this.hashFile(target, signal, () => undefined)) === file.sha256;
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  }

  /**
   * Fetch one file to a temporary name beside its destination, hashing as it writes, and rename it
   * into place only when its size and digest match. Anything else deletes the temporary file.
   */
  private async fetchFile(
    file: VoiceModelFile,
    target: string,
    signal: AbortSignal,
    onBytes: (bytes: number) => void,
  ): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(4).toString("hex")}.part`;
    const stallMs = this.deps.stallMs ?? STALL_MS;
    const stall = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), stallMs);
      stallTimer.unref?.();
    };
    const combined = AbortSignal.any([signal, stall.signal]);
    const fetchImpl = this.deps.fetch ?? fetch;
    const url = voiceModelFileUrl(file, this.deps.baseUrl());
    armStall();
    try {
      let response: Response;
      try {
        // The pinned size and digest are of the file's own bytes, so ask for them uncompressed.
        response = await fetchImpl(url, { signal: combined, redirect: "follow", headers: { "accept-encoding": "identity" } });
      } catch (error) {
        if (signal.aborted) throw error;
        if (stall.signal.aborted) throw new Error(`The download of ${file.path} stalled: nothing arrived for ${duration(stallMs)}.`);
        throw new Error(`The download of ${file.path} could not start: ${errorText(error)}`);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`The download of ${file.path} failed: the server answered ${response.status}.`);
      }
      // A server that compresses anyway reports the compressed length, while `fetch` hands over the
      // decoded body; the length is compared only when the body is sent as is. The running byte
      // count and the digest check the decoded body either way.
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      const length = encoding && encoding !== "identity" ? null : response.headers.get("content-length");
      if (length !== null && Number(length) !== file.bytes) {
        await response.body.cancel().catch(() => undefined);
        throw new Error(`The server offered ${file.path} as ${length} bytes, and its pinned size is ${file.bytes}. Nothing was kept.`);
      }
      const hash = createHash("sha256");
      let received = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > file.bytes) {
            callback(new Error(`The download of ${file.path} is larger than its pinned ${file.bytes} bytes and was deleted.`));
            return;
          }
          hash.update(chunk);
          armStall();
          onBytes(chunk.length);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
          meter,
          createWriteStream(temp, { flags: "wx", mode: 0o644 }),
          { signal: combined },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (stall.signal.aborted) throw new Error(`The download of ${file.path} stalled: nothing arrived for ${duration(stallMs)}.`);
        if (error instanceof Error && error.message.startsWith(`The download of ${file.path}`)) throw error;
        throw new Error(`The download of ${file.path} failed: ${errorText(error)}`);
      }
      if (received !== file.bytes) {
        throw new Error(`The download of ${file.path} ended after ${received} of ${file.bytes} bytes and was deleted.`);
      }
      if (hash.digest("hex") !== file.sha256) {
        throw new Error(`The download of ${file.path} did not match its checksum and was deleted.`);
      }
      await rename(temp, target);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      await rm(temp, { force: true });
    }
  }

  /** A daemon that died mid-download left its temporary file; nothing else writes here. */
  private async removeLeftoverParts(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir, { recursive: true }); }
    catch { return; }
    await Promise.all(entries.filter((name) => name.endsWith(".part")).map((name) => rm(join(dir, name), { force: true })));
  }

  private async hashFile(path: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024, signal })) {
      hash.update(chunk as Buffer);
      onBytes((chunk as Buffer).length);
    }
    return hash.digest("hex");
  }

  // ---- jobs and publishing ----

  /**
   * Run one job at a time. A job that was stopped publishes nothing of its own; `onStopped` runs
   * after its work has unwound, so a Cancel can remove files no write is still holding, and its
   * `current()` says whether the manager has since moved on to another job or none.
   */
  private run(
    kind: Job["kind"],
    backend: VoiceBackend,
    revision: string,
    work: (signal: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void,
    onStopped?: (reason: StopReason, current: () => boolean) => Promise<void>,
  ): void {
    const controller = new AbortController();
    const job: Job = { kind, backend, revision, controller, done: Promise.resolve() };
    this.job = job;
    job.done = (async () => {
      try {
        await work(controller.signal);
      } catch (error) {
        const stopped = stopReasonOf(controller.signal);
        if (stopped) {
          try { await onStopped?.(stopped, () => this.job === job); }
          catch (cleanup) { console.warn("[voice] could not clean up a stopped model download:", errorText(cleanup)); }
        } else if (this.job === job) {
          onError(error);
        }
      } finally {
        if (this.job === job) this.job = null;
      }
    })();
  }

  private stopJob(reason: StopReason): void {
    const job = this.job;
    if (!job) return;
    this.job = null;
    this.settling.add(job.done);
    void job.done.finally(() => this.settling.delete(job.done));
    job.controller.abort(new StopSignal(reason));
  }

  /**
   * Publish a progress reading, at most every `progressEveryMs`. The state itself is always
   * current, and a reading held back by the limit is published when the interval ends, so a
   * download that pauses mid-file still shows how far it got.
   */
  private progress(model: VoiceModelState): void {
    this.model = model;
    const every = this.deps.progressEveryMs ?? PROGRESS_EVERY_MS;
    const now = (this.deps.now ?? Date.now)();
    const wait = this.lastProgressAt + every - now;
    if (wait <= 0) {
      this.clearTrailing();
      this.lastProgressAt = now;
      this.publish();
      return;
    }
    if (this.trailing) return;
    this.trailing = setTimeout(() => {
      this.trailing = null;
      this.lastProgressAt = (this.deps.now ?? Date.now)();
      this.publish();
    }, wait);
    this.trailing.unref?.();
  }

  private set(model: VoiceModelState): void {
    this.clearTrailing();
    this.model = model;
    this.lastProgressAt = (this.deps.now ?? Date.now)();
    this.publish();
  }

  private clearTrailing(): void {
    if (!this.trailing) return;
    clearTimeout(this.trailing);
    this.trailing = null;
  }

  private publish(): void {
    const key = JSON.stringify(this.model);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    const model = this.state();
    for (const listener of Array.from(this.listeners)) {
      try { listener(model); }
      catch (error) { console.warn("[voice] model listener failed:", error); }
    }
  }
}

/**
 * The manifests this daemon downloads: the pinned ones, or, with `MISSION_VOICE_MODEL_MANIFEST`
 * naming a JSON file of the same shape, that file's entries in their place. The override exists
 * for the end-to-end suite, which serves small fixture files whose digests the real manifest
 * cannot name; it is held to the same schema, so its URLs are pinned to commits too.
 */
export function voiceModelManifestsFromEnv(
  path: string | undefined = envVar("VOICE_MODEL_MANIFEST"),
  defaults: VoiceModelManifests = VOICE_MODELS,
): VoiceModelManifests {
  if (!path) return defaults;
  try {
    const override = VoiceModelManifestsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return Object.freeze({ ...defaults, ...override }) as VoiceModelManifests;
  } catch (error) {
    console.warn(`[voice] model manifest (${path}) could not be read; using the pinned models:`, errorText(error));
    return defaults;
  }
}

export function voiceModelBaseUrlFromEnv(value: string | undefined = envVar("VOICE_MODEL_BASE_URL")): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return trimmed;
  } catch { /* refused below */ }
  console.warn(`[voice] MISSION_VOICE_MODEL_BASE_URL is not an http(s) URL; using the pinned URLs.`);
  return null;
}

let manifests: VoiceModelManifests | null = null;
let baseUrl: string | null | undefined;

const productionDeps = {
  root: () => join(stateDir(), "voice", "models"),
  active: () => featureEnabled(VOICE_FLAG),
  baseUrl: () => (baseUrl === undefined ? (baseUrl = voiceModelBaseUrlFromEnv()) : baseUrl),
};

export const voiceModelManager = new VoiceModelManager({
  ...productionDeps,
  backend: () => resolveVoiceBackend(getVoiceConfig().backend, process.platform, process.arch, release()),
  manifests: () => (manifests ??= voiceModelManifestsFromEnv()),
});

export function speechModelManifests(platform: string, arch: string): VoiceModelManifests {
  return { fluidaudio: null, "sherpa-onnx": supportsSherpaHelpers(platform, arch) ? VOICE_SPEECH_MODELS["supertonic-3"] : null };
}

const speechDefaults = speechModelManifests(process.platform, process.arch);
let speechManifests: VoiceModelManifests | undefined;
function selectedSpeechManifests(): VoiceModelManifests {
  if (speechManifests) return speechManifests;
  // The loopback fixture supplies pinned test files independently of the recognition model.
  const path = envVar("VOICE_SPEECH_MODEL_MANIFEST");
  speechManifests = path && speechDefaults["sherpa-onnx"] ? voiceModelManifestsFromEnv(path, speechDefaults) : speechDefaults;
  return speechManifests;
}

export const speechModelManager = new VoiceModelManager({
  ...productionDeps,
  namespace: "speech",
  backend: () => "sherpa-onnx",
  manifests: selectedSpeechManifests,
});
