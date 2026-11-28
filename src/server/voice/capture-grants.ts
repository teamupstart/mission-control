import { dirname, join } from "node:path";
import { z } from "zod";
import { VoiceListenerIdSchema } from "@shared/voice.ts";
import { listVoiceRecords, readVoiceRecord, removeVoiceRecord, writeVoiceRecord } from "./recovery-files.ts";
import { announcementName, SpeechHolds } from "./speech-holds.ts";
import { voiceProcessGone } from "./process-birth.ts";
import type { watchCaptureProcess } from "./capture-process.ts";

const record = z.object({
  instance: z.string().max(256).optional(),
  process: z.object({ pid: z.number().int().positive(), birth: z.string().min(1).max(128) }).optional(),
}).strict();
type Grant = z.infer<typeof record> & { watch?: ReturnType<typeof watchCaptureProcess>; pauseRevision?: string };

/** Only the daemon writes these receipts. An owner gets capture only after its receipt is durable. */
export class CaptureGrants {
  readonly entries = new Map<string, Grant>();
  private loaded = false;
  private readonly directory: string;
  private readonly home: string;
  constructor(private readonly voice: string) {
    this.directory = join(voice, "capture-grants");
    this.home = dirname(voice);
  }

  load() {
    if (this.loaded) return true;
    try {
      const launches = new SpeechHolds(this.voice);
      for (const name of listVoiceRecords(this.home, this.directory)) {
        if (!name.endsWith(".json")) continue;
        const owner = name.slice(0, -5);
        if (!VoiceListenerIdSchema.safeParse(owner).success) continue;
        let grant: Grant = {}; // Even a damaged receipt still identifies who must pause.
        try { grant = record.parse(JSON.parse(readVoiceRecord(this.home, join(this.directory, name)))); }
        catch { /* Only this owner's own pause can clear an unknown process. */ }
        this.entries.set(owner, grant);
        if (grant.instance && launches.exitRecorded(announcementName(grant.instance)) === true) this.release(owner);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    this.loaded = true;
    return true;
  }

  issue(owner: string, grant: Grant) {
    if (!this.load() || !writeVoiceRecord(this.home, join(this.directory, owner + ".json"),
      { instance: grant.instance, process: grant.process })) return false;
    this.entries.set(owner, grant);
    return true;
  }

  release(owner: string) {
    try { removeVoiceRecord(this.home, join(this.directory, owner + ".json")); }
    catch { return false; }
    this.entries.get(owner)?.watch?.close();
    this.entries.delete(owner);
    return true;
  }

  reap() {
    for (const [owner, grant] of this.entries) {
      if (grant.watch ? grant.watch.exited() : grant.process && voiceProcessGone(grant.process.pid, grant.process.birth)) this.release(owner);
    }
  }

  close() {
    for (const grant of this.entries.values()) grant.watch?.close();
  }
}
