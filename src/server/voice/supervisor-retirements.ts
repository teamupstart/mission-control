import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SpeechInstanceSchema } from "@shared/voice-speech.ts";
import { announcementName, removeVoiceRecord, retirementDirectory, writeVoiceRecord } from "./recovery-files.ts";
import type { SupervisorReporter } from "./supervisor-auth.ts";

const signedExit = z.object({ instance: SpeechInstanceSchema, proof: z.string().length(128) }).strict();
type PendingExit = z.infer<typeof signedExit>;

/** The launcher owns this queue. No entry is created for a child that might have spawned. */
export class SupervisorRetirements {
  private readonly pending = new Map<string, PendingExit>();
  private timer?: NodeJS.Timeout;
  private active?: AbortController;
  private enqueued = false;
  private retryMs = 250;

  constructor(private readonly home: string, private readonly name: string,
    private readonly verifies: (exit: PendingExit) => boolean) {}

  private file(exit: PendingExit) { return this.name + "-" + announcementName(exit.instance) + ".json"; }

  private directory() {
    const dir = retirementDirectory(this.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error("Invalid supervisor retirement directory.");
    return dir;
  }

  private persist(file: string, exit: PendingExit) {
    try { return writeVoiceRecord(this.home, join(this.directory(), file), exit); }
    catch { return false; }
  }

  enqueue(exit: PendingExit, report: SupervisorReporter) {
    const file = this.file(exit);
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
          const exit = signedExit.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
          if (this.file(exit) === file && this.verifies(exit)) records.set(file, exit);
        } catch { retry = true; }
      }
    } catch { retry = true; }
    for (const [file, exit] of records) {
      if (signal.aborted) return false;
      if (this.pending.has(file)) this.persist(file, exit);
      try {
        await report(exit.instance, "exited", exit.proof, signal);
        if (signal.aborted) return false;
        removeVoiceRecord(this.home, join(this.directory(), file));
        this.pending.delete(file);
      } catch { retry = true; }
    }
    return retry || this.pending.size > 0;
  }
}
