import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SpeechInstanceSchema } from "../../shared/voice-speech.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { loadNativeStateLockBinding } from "../state-ownership-native.ts";
import { announcementName, readVoiceRecord, removeVoiceRecord, retirementDirectory, writeVoiceRecord } from "./recovery-files.ts";
import { voiceProcessBirth, voiceProcessGone } from "./process-birth.ts";
import { createVoiceSupervisor, supervisorIssuer, type SupervisorReporter } from "./supervisor-auth.ts";

export type VoiceSigner = ReturnType<typeof createVoiceSupervisor>;
type Slot = "shell" | "dev";
const entry = z.object({ instance: SpeechInstanceSchema, pid: z.number().int().positive().optional(), startedAt: z.string().min(1).optional() });
const recordPath = (home: string, slot: Slot) => join(home, "voice", "supervised", slot + ".json");

function helperProcesses(executable: string) {
  // comm contains executable names only. Never inspect process arguments or environments.
  const command = FIXED_OS_EXECUTABLES.macProcessStatus;
  return execFileSync(command, ["-axo", "pid=,comm="], {encoding: "utf8", timeout: 2000}).split("\n")
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      return match && basename(match[2]!) === basename(executable) ? [Number(match[1])] : [];
    });
}

export class MacListenerSupervisor {
  private lock?: { release(): void };
  private recovery?: Promise<void>;
  private starting = false;
  private launch?: Awaited<ReturnType<VoiceSigner["launch"]>>;
  constructor(private readonly home: string, private readonly slot: Slot, private readonly signer: VoiceSigner,
    private readonly executable: string, private readonly send: SupervisorReporter) {}

  private acquire(slot: Slot) {
    const binding = loadNativeStateLockBinding();
    const handle = binding.acquire(join(this.home, "voice-" + slot + ".lock"), String(process.pid));
    return { release: () => binding.release(handle) };
  }

  private readonly report: SupervisorReporter = async (instance, state, proof, signal) => {
    const record = this.lock && this.readSlot(this.slot);
    if (state === "exited" && record?.instance === instance && (!record.pid || !record.startedAt) &&
        helperProcesses(this.executable).length) throw new Error("Waiting for proof that the previous listener is gone.");
    const result = await this.send(instance, state, proof, signal);
    if ((state === "exited" && result !== false) || (state === "started" && result === false && !record?.pid)) {
      const path = recordPath(this.home, this.slot);
      if (this.lock && this.readSlot(this.slot)?.instance === instance) removeVoiceRecord(this.home, path);
    }
    return result;
  };

  private readSlot(slot: Slot) {
    const path = recordPath(this.home, slot);
    try { return entry.parse(JSON.parse(readVoiceRecord(this.home, path))); }
    catch {
      return lstatSync(path, {throwIfNoEntry: false}) ? null : undefined;
    }
  }

  private async recover(slot: Slot) {
    const record = this.readSlot(slot);
    if (record === undefined) return;
    const path = recordPath(this.home, slot);
    if (!record?.pid || !record.startedAt) {
      if (helperProcesses(this.executable).length) {
        if (slot !== this.slot) return;
        throw new Error("Waiting for the previous listener to exit.");
      }
      if (!record) { removeVoiceRecord(this.home, path); return; }
    } else if (!voiceProcessGone(record.pid, record.startedAt)) {
      if (slot !== this.slot) return;
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (voiceProcessGone(record.pid, record.startedAt)) break;
        if (!this.signer.watched(this.home, record.instance, record.pid, record.startedAt) ||
            !helperProcesses(this.executable).includes(record.pid) || voiceProcessBirth(record.pid) !== record.startedAt) {
          throw new Error("Cannot verify the previous listener process.");
        }
        try { process.kill(record.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        for (let poll = 0; poll < 20 && !voiceProcessGone(record.pid, record.startedAt); poll++) await delay(100);
      }
      if (!voiceProcessGone(record.pid, record.startedAt)) throw new Error("Previous listener is still running.");
    }
    const {instance} = record;
    // Across issuer rotation, or for the other slot, only an existing signed exit can be relayed.
    let proof: string | undefined;
    const name = announcementName(instance) + ".json";
    for (const file of [join(retirementDirectory(this.home), slot + "-" + name), join(this.home, "voice", "supervised-exits", name)]) {
      try {
        const exit = JSON.parse(readVoiceRecord(this.home, file));
        if (exit.instance === instance && supervisorIssuer(instance, "exited", exit.proof)?.name === slot) proof = exit.proof;
      } catch { /* The originating supervisor may still need to sign its exit. */ }
    }
    if (!proof) {
      if (slot === this.slot && this.readSlot(slot)) throw new Error("Awaiting the signed listener exit.");
      return;
    }
    if (await this.send(instance, "exited", proof, AbortSignal.timeout(5000)) === false) throw new Error("Listener exit refused.");
    removeVoiceRecord(this.home, path);
  }

  recoverPrevious() {
    return this.recovery ??= this.recoverSlots().finally(() => { this.recovery = undefined; });
  }

  private async recoverSlots() {
    this.lock ??= this.acquire(this.slot);
    this.signer.retryPendingExits(this.home, this.report);
    const other = this.slot === "dev" ? "shell" : "dev";
    let otherLock;
    try { otherLock = this.acquire(other); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error; }
    if (otherLock) {
      try { await this.recover(other); } finally { otherLock.release(); }
    }
    await this.recover(this.slot);
  }

  async start(env: NodeJS.ProcessEnv) {
    this.starting = true;
    try {
      await this.recoverPrevious();
      this.launch = await this.signer.launch(this.home, this.executable, [], env, this.report, (instance, pid, startedAt) => {
        if (!writeVoiceRecord(this.home, recordPath(this.home, this.slot), { instance, pid, startedAt })) {
          throw new Error("Could not record the listener process.");
        }
      });
    } finally { this.starting = false; }
    const launched = this.launch;
    launched.child.once("exit", () => { if (this.launch === launched) this.launch = undefined; });
    this.launch.child.stdout.resume();
    this.launch.child.stderr.resume();
    return this.launch.child;
  }

  reconnect() {
    if (!this.launch && !this.starting) {
      void this.recoverPrevious().catch(() => {});
    } else {
      this.signer.retryPendingExits(this.home, this.report);
      void this.launch?.reannounce().catch(() => {});
    }
  }

  async close() {
    await this.recovery?.catch(() => {});
    if (this.lock) {
      try { await this.recover(this.slot); } catch { /* Keep the slot for the next connection. */ }
    }
    this.signer.pauseExitRetries();
    this.lock?.release();
    this.lock = undefined;
  }
}
