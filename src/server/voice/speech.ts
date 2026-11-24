import { randomUUID } from "node:crypto";
import {
  VOICE_SPEECH_CONFIRM_LIMIT_MS, VOICE_SPEECH_END_MARGIN_MS, VOICE_SPEECH_START_LIMIT_MS,
  VOICE_SPEECH_SYSTEM_LIMIT_MS, type SpeakDirective, type VoiceSpeechJob, type VoiceSpeechState, type VoiceSpeechVoice,
} from "@shared/voice-speech.ts";
import { verifySupervisorReport, type SupervisorReportState } from "./supervisor-auth.ts";
import { announcementName, SpeechHolds, SUPERVISOR_DIRECTORY, type Hold } from "./speech-holds.ts";

export interface VoiceSynthesizer {
  synthesize(text: string, voice: VoiceSpeechVoice): Promise<{ wav: Uint8Array<ArrayBuffer>; durationMs: number }>;
  warm(): void;
  stop(): void;
}
const unavailable: VoiceSynthesizer = {
  async synthesize() { throw new Error("No speech model is ready."); }, warm() {}, stop() {},
};

interface SpeechDeps {
  directory: string;
  now(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  target(purpose: VoiceSpeechJob["purpose"]): { instance: string; voice: VoiceSpeechVoice } | null;
  changed(): void;
  synthesizer?: VoiceSynthesizer;
}

interface Playback {
  job: VoiceSpeechJob;
  since: number;
  hold?: Hold;
  wav?: Uint8Array<ArrayBuffer>;
  timer?: unknown;
  unanswered?: boolean;
  confirmBy?: number;
  onStop?: "failed" | "stopped" | "timed-out";
}

export class VoiceSpeechManager {
  readonly announced = new Set<string>();
  lastAudition: VoiceSpeechState["lastAudition"] = null;
  private readonly ledger: SpeechHolds;
  private readonly jobs = new Map<string, Playback>();
  private readonly history: { from: number; until: number }[] = [];
  private unknown = false;
  private enabled = true;
  private readonly synth: VoiceSynthesizer;

  constructor(private readonly deps: SpeechDeps) {
    this.synth = deps.synthesizer ?? unavailable;
    this.ledger = new SpeechHolds(deps.directory);
    this.recover();
  }

  private recover() {
    const { holds, unknown } = this.ledger.load();
    this.unknown = unknown && holds.length > 0;
    for (const hold of holds) this.recoverHold(hold);
  }

  private recoverHold(hold: Hold) {
    const named = "instance" in hold;
    const job: VoiceSpeechJob = { id: hold.jobId, purpose: named ? hold.purpose : "ask", state: "stopping",
      text: "", voice: null, cardId: null, durationMs: null, holder: named ? hold.instance : null };
    const item: Playback = { job, since: -Infinity, hold, onStop: "failed" };
    this.jobs.set(job.id, item);
    this.confirm(item);
  }

  private items() { return [...this.jobs.values()]; }
  get live() {
    // A directory that becomes readable may identify additional players after jobs were queued.
    return this.items().find(item => item.hold)?.job ?? this.jobs.values().next().value?.job ?? null;
  }
  /** Disable new playback and timers while the holder finishes the stop handshake. */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.stopAll();
      for (const item of this.items()) this.clear(item);
      this.synth.stop();
    } else if (this.held) {
      for (const item of this.items()) if (!item.unanswered) this.confirm(item);
    } else {
      this.recover();
    }
  }

  get directiveKey() { return this.items().filter(i => i.hold).map(i => i.job.id + i.job.state).join(","); }
  stopAll(purpose?: VoiceSpeechJob["purpose"]) {
    for (const { job } of this.items().reverse()) if (!purpose || job.purpose === purpose) this.stop(job.id);
  }
  get held() { return this.items().some(i => i.hold); }
  awaitsExit(instance: string) {
    return this.items().some(item => item.hold && (item.job.holder === instance || "supervisor" in item.hold));
  }
  get listenerFailure() {
    if (this.unknown) return "the record of unfinished speech could not be read";
    return this.items().some(i => i.unanswered) ? "the listener did not confirm that speech had stopped" : null;
  }
  during(time: number) {
    return this.items().some(i => i.hold && time >= i.since) || this.history.some(h => time >= h.from && time <= h.until);
  }
  private holds() { return this.items().flatMap(item => item.hold ? [item.hold] : []); }
  private save() { return this.ledger.save(this.holds()); }
  private recoverDiscovered(hold: Hold) {
    const exists = this.holds().some(existing => "instance" in hold
      ? "instance" in existing && existing.instance === hold.instance
      : "supervisor" in existing && existing.supervisor === hold.supervisor);
    if (!exists) this.recoverHold(hold);
  }
  supervised(instance: string, state: SupervisorReportState, proof?: string): "accepted" | "unauthorized" | "unavailable" {
    if (!verifySupervisorReport(this.deps.directory, instance, state, proof)) return "unauthorized";
    if (!this.ledger.recordAnnouncement(instance, state, this.holds())) {
      this.announced.delete(instance);
      this.deps.changed();
      return "unavailable";
    }
    if (state === "started") this.announced.add(instance);
    else this.announced.delete(instance);
    for (const item of this.items()) {
      const hold = item.hold;
      if (hold && "supervisor" in hold) {
        if (hold.supervisor === SUPERVISOR_DIRECTORY) {
          const discovered = this.ledger.discover();
          if (discovered.some(h => "supervisor" in h && h.supervisor === SUPERVISOR_DIRECTORY)) continue;
          for (const possible of discovered) this.recoverDiscovered(possible);
        } else {
          // A signed report matches its exact launch receipt even if the receipt has disappeared.
          const recorded = hold.supervisor === announcementName(instance) ? instance : this.ledger.supervisorRecord(hold.supervisor);
          if (!recorded) continue;
          this.recoverDiscovered({ jobId: randomUUID(), instance: recorded, purpose: "ask" });
        }
        this.finish(item, "failed");
      }
    }
    if (state === "exited") {
      for (const item of this.items()) if (item.job.holder === instance) this.finish(item, "failed");
    }
    this.deps.changed();
    return "accepted";
  }

  speak(instance?: string): SpeakDirective | null {
    if (!instance) return null;
    const job = this.items().find(i => i.job.holder === instance)?.job;
    if (!job) return null;
    if (job.state === "stopping") return { id: job.id, stop: true };
    if (job.voice?.engine === "system") return { id: job.id, kind: "system", voiceId: job.voice.id, text: job.text };
    return { id: job.id, kind: "audio", durationMs: job.durationMs! };
  }

  audio(id: string, instance?: string) {
    const item = this.jobs.get(id);
    return instance && item?.job.holder === instance && item.job.state !== "stopping" ? item.wav : undefined;
  }

  open(purpose: VoiceSpeechJob["purpose"], text: string, cardId: string | null) {
    const job: VoiceSpeechJob = { id: randomUUID(), purpose, text, cardId, state: "preparing",
      holder: null, voice: null, durationMs: null };
    this.jobs.set(job.id, { job, since: Infinity });
    if (job === this.live) void this.prepare(this.jobs.get(job.id)!);
    return job;
  }

  private async prepare(item: Playback) {
    const job = item.job;
    const target = this.deps.target(job.purpose);
    if (!target) return this.finish(item, "failed");
    job.voice = target.voice;
    if (target.voice.engine === "neural") {
      this.deps.changed();
      if (!this.jobs.has(job.id)) return;
      try {
        const audio = await this.synth.synthesize(job.text, target.voice);
        if (!this.jobs.has(job.id)) return;
        item.wav = audio.wav;
        job.durationMs = audio.durationMs;
      } catch {
        if (this.jobs.has(job.id)) this.finish(item, "failed");
        return;
      }
    }
    const current = this.deps.target(job.purpose);
    if (!current || !this.announced.has(current.instance) || current.voice.engine !== job.voice.engine ||
        current.voice.id !== job.voice.id) return this.finish(item, "failed");
    item.hold = { jobId: job.id, instance: current.instance, purpose: job.purpose };
    if (!this.save()) {
      delete item.hold;
      return this.finish(item, "failed");
    }
    job.holder = current.instance;
    item.since = this.deps.now();
    job.state = "ready";
    this.arm(item, VOICE_SPEECH_START_LIMIT_MS, () => this.stop(job.id, "timed-out"));
    this.deps.changed();
  }

  stop(id = this.live?.id, outcome: "stopped" | "timed-out" = "stopped") {
    const item = id && this.jobs.get(id);
    if (!item || item.job.state === "stopping") return;
    if (!item.hold) return this.finish(item, outcome);
    item.job.state = "stopping";
    item.onStop = outcome;
    this.confirm(item);
    this.deps.changed();
  }

  stopCard(id: string) {
    for (const { job } of this.items()) if (job.cardId === id) this.stop(job.id);
  }

  event(id: string, instance: string | undefined, type: "started" | "ended", outcome: "finished" | "stopped" | "failed" = "finished") {
    const item = this.jobs.get(id);
    if (!instance || item?.job.holder !== instance) return false;
    if (type === "ended") this.finish(item, item.onStop ?? outcome);
    else if (item.job.state === "ready") {
      item.job.state = "speaking";
      this.arm(item, item.job.durationMs === null ? VOICE_SPEECH_SYSTEM_LIMIT_MS : item.job.durationMs + VOICE_SPEECH_END_MARGIN_MS,
        () => this.stop(id, "timed-out"));
      this.deps.changed();
    }
    return true;
  }

  private finish(item: Playback, state: "stopped" | "timed-out" | "failed" | "finished") {
    const wasFirst = item.job === this.live;
    this.clear(item);
    item.job.state = state;
    this.jobs.delete(item.job.id);
    if (item.hold) {
      this.history.push({ from: item.since, until: this.deps.now() });
      this.save();
      if (!this.held) this.unknown = false;
    }
    if (item.job.purpose === "audition") this.lastAudition = { id: item.job.id, state };
    this.deps.changed();
    const next = this.jobs.values().next().value;
    if (wasFirst && this.enabled && !this.held && next?.job.state === "preparing") void this.prepare(next);
  }

  private confirm(item: Playback) {
    item.confirmBy ??= this.deps.now() + VOICE_SPEECH_CONFIRM_LIMIT_MS;
    if (!this.enabled) return;
    const remaining = item.confirmBy - this.deps.now();
    if (remaining <= 0) item.unanswered = true;
    else this.arm(item, remaining, () => { item.unanswered = true; this.deps.changed(); });
  }
  private arm(item: Playback, ms: number, fn: () => void) {
    this.clear(item);
    item.timer = this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms).unref();
  }
  private clear(item: Playback) {
    if (item.timer !== undefined) (this.deps.clearTimer ?? clearTimeout)(item.timer as ReturnType<typeof setTimeout>);
    delete item.timer;
  }
  dispose() {
    for (const item of this.items()) this.clear(item);
    this.jobs.clear();
    this.synth.stop();
  }
}
