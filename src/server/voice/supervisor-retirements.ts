import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SpeechInstanceSchema } from "@shared/voice-speech.ts";
import { announcementName, removeVoiceRecord, retirementDirectory, writeVoiceRecord } from "./recovery-files.ts";
import type { SupervisorReporter, SupervisorReportState } from "./supervisor-auth.ts";

const signedExit = z.object({ instance: SpeechInstanceSchema, proof: z.string().length(128) }).strict();
type PendingExit = z.infer<typeof signedExit>;
const watchedLaunch = signedExit.extend({ pid: z.number().int().positive() });
type WatchedLaunch = z.infer<typeof watchedLaunch>;
const queuedRecord = z.union([signedExit, watchedLaunch]);
const REPORT_TIMEOUT_MS = 5000;

export async function reportBeforeDeadline(report: SupervisorReporter, instance: string, state: SupervisorReportState, proof: string, stop?: AbortSignal) {
  const deadline = new AbortController();
  const signal = stop ? AbortSignal.any([stop, deadline.signal]) : deadline.signal;
  signal.throwIfAborted();
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => deadline.abort(new Error("Voice supervisor " + state + " report timed out.")), REPORT_TIMEOUT_MS);
  if (state === "exited") timer.unref();
  try {
    // An adapter may ignore cancellation. Its late response cannot acknowledge this attempt.
    const result = await Promise.race([aborted, report(instance, state, proof, signal)]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort!);
  }
}

function processGone(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Only the originating supervisor can convert a watched launch into a signed exit. */
export class SupervisorRetirements {
  private readonly pending = new Map<string, PendingExit>();
  private timer?: NodeJS.Timeout;
  private active?: AbortController;
  private enqueued = false;
  private retryMs = 250;

  constructor(private readonly home: string, private readonly name: string,
    private readonly verifies: (exit: PendingExit) => boolean,
    private readonly recoveredExit: (launch: WatchedLaunch) => PendingExit | null) {}

  private file(instance: string) { return this.name + "-" + announcementName(instance) + ".json"; }

  private directory() {
    const dir = retirementDirectory(this.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error("Invalid supervisor retirement directory.");
    return dir;
  }

  private persist(file: string, exit: PendingExit | WatchedLaunch) {
    try { return writeVoiceRecord(this.home, join(this.directory(), file), exit); }
    catch { return false; }
  }

  watch(launch: WatchedLaunch) {
    if (!this.persist(this.file(launch.instance), launch)) throw new Error("Could not persist the supervised voice launch.");
  }

  discardRefused(instance: string) {
    try { removeVoiceRecord(this.home, join(this.directory(), this.file(instance))); }
    catch { /* Recovery can still establish that the launcher is gone. */ }
  }

  enqueue(exit: PendingExit, report: SupervisorReporter) {
    const file = this.file(exit.instance);
    if (!this.persist(file, exit)) this.pending.set(file, exit);
    this.enqueued = true;
    this.start(report);
  }

  /** Stop the timer and detach an in-flight report. A later reconnect replays the durable entries. */
  pause() {
    clearTimeout(this.timer);
    this.active?.abort();
    this.active = undefined;
    this.retryMs = 250;
  }

  resume(report: SupervisorReporter) {
    this.pause();
    this.start(report);
  }

  start(report: SupervisorReporter) {
    if (this.active) return;
    this.enqueued = false;
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.active = controller;
    void this.deliver(report, controller.signal).then(retry => {
      if (this.active !== controller) return;
      this.active = undefined;
      if (this.enqueued) this.start(report);
      else if (retry) {
        this.timer = setTimeout(() => this.start(report), this.retryMs).unref();
        this.retryMs = Math.min(5000, this.retryMs * 2);
      } else this.retryMs = 250;
    });
  }

  private async deliver(report: SupervisorReporter, signal: AbortSignal): Promise<boolean> {
    const records = new Map(this.pending);
    let retry = false;
    try {
      const dir = this.directory();
      for (const file of readdirSync(dir)) {
        if (!file.startsWith(this.name + "-announced-") || !file.endsWith(".json")) continue;
        try {
          if (records.has(file)) continue;
          const path = join(dir, file);
          const raw = readFileSync(path, "utf8");
          const entry = queuedRecord.parse(JSON.parse(raw));
          if (this.file(entry.instance) !== file) continue;
          if ("pid" in entry) {
            // A live launcher can replace its PID with the child's before dying.
            // Re-read after observing death so stale evidence cannot retire that child.
            if (!processGone(entry.pid) || readFileSync(path, "utf8") !== raw) { retry = true; continue; }
            const exit = this.recoveredExit(entry);
            if (exit) records.set(file, exit);
          } else if (this.verifies(entry)) records.set(file, entry);
        } catch { retry = true; }
      }
    } catch { retry = true; }
    for (const [file, exit] of records) {
      if (signal.aborted) return false;
      if (this.pending.has(file)) this.persist(file, exit);
      try {
        await reportBeforeDeadline(report, exit.instance, "exited", exit.proof, signal);
        if (signal.aborted) return false;
        removeVoiceRecord(this.home, join(this.directory(), file));
        this.pending.delete(file);
      } catch { retry = true; }
    }
    return retry || this.pending.size > 0;
  }
}
