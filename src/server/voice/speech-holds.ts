import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { SpeechInstanceSchema } from "@shared/voice-speech.ts";
import { supervisorIssuer } from "./supervisor-auth.ts";
import { announcementName, listVoiceRecords, readVoiceRecord, removeVoiceRecord, writeVoiceRecord } from "./recovery-files.ts";
export { announcementName } from "./recovery-files.ts";

// A period represents the supervised directory itself if even its listing is unreadable.
export const SUPERVISOR_DIRECTORY = ".";
const supervisor = z.string().min(1).refine(name => !name.includes("/") && !name.includes("\\") && !name.includes("\0"));
const launchSchema = z.union([SpeechInstanceSchema, z.object({ supervisor }).strict()]);
type Launch = z.infer<typeof launchSchema>;
const exitRecord = z.object({ instance: SpeechInstanceSchema, proof: z.string().length(128) }).strict();
const receiptName = z.string().regex(/^announced-[a-f0-9]{64}$/u);
const entry = z.union([
  z.object({ jobId: z.string().uuid(), instance: SpeechInstanceSchema, purpose: z.enum(["ask", "audition"]) }).strict(),
  z.object({ jobId: z.string().uuid(), supervisor, lastCandidate: receiptName.optional(), confirmed: z.array(receiptName).optional() }).strict(),
]);
export type Hold = z.infer<typeof entry>;
function missing(error: unknown, path: string) {
  // Reading through a dangling symlink also gives ENOENT. Its contents are unknown.
  return (error as NodeJS.ErrnoException).code === "ENOENT" && !mayExist(path);
}
function mayExist(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** Only the daemon writes the ledger. An unreadable supervisor file represents a possible player. */
export class SpeechHolds {
  private readonly path: string;
  private readonly inventoryPath: string;
  private readonly usedPath: string;
  private lastInventory?: Launch[];
  constructor(private readonly directory: string) {
    this.path = join(directory, "speech-holds.json");
    this.inventoryPath = join(directory, "supervised-instances.json");
    this.usedPath = join(dirname(directory), "voice-speech-used");
  }

  hasRecoveryEvidence(): boolean {
    return [this.usedPath, this.path, this.inventoryPath, join(this.directory, "supervised")].some(mayExist);
  }

  hasPriorSpeech(): boolean { return mayExist(this.usedPath); }

  supervisorRecord(name: string): string | undefined {
    const path = join(this.directory, "supervised", name + ".json");
    try {
      const raw = readVoiceRecord(dirname(this.directory), path);
      const instance = SpeechInstanceSchema.parse(JSON.parse(raw).instance);
      return name.startsWith("announced-") && announcementName(instance) !== name ? undefined : instance;
    } catch {
      return undefined;
    }
  }

  /** An exit is final for this per-launch nonce. Unreadable proof cannot establish silence. */
  exitRecorded(name: string): boolean | undefined {
    const path = join(this.directory, "supervised-exits", name + ".json");
    try {
      const { instance, proof } = exitRecord.parse(JSON.parse(readVoiceRecord(dirname(this.directory), path)));
      // The receipt identifies the original issuer even after the configured verifier rotates.
      return announcementName(instance) === name && supervisorIssuer(instance, "exited", proof)
        ? true : undefined;
    }
    catch (error) { return missing(error, path) ? false : undefined; }
  }

  knowsLaunch(instance: string): boolean {
    const name = announcementName(instance);
    if (this.supervisorRecord(name) === instance || this.exitRecorded(name)) return true;
    try {
      return (this.readInventory() ?? this.lastInventory ?? []).some(launch => typeof launch === "string"
        ? launch === instance : launch.supervisor === name || this.supervisorRecord(launch.supervisor) === instance);
    } catch {
      return false;
    }
  }

  load(): { holds: Hold[]; unknown: boolean } {
    try {
      const holds = z.array(entry).parse(JSON.parse(readVoiceRecord(dirname(this.directory), this.path)));
      if (new Set(holds.map(h => h.jobId)).size !== holds.length) throw new Error("Duplicate job");
      // Older daemons could already have handed out one of these jobs before the marker existed.
      if (holds.length && !mayExist(this.usedPath)) this.write(this.usedPath, true);
      // A crash can land between recording a signed exit and saving the remaining holds.
      // Mutable slot names, including their last observed occupants, never prove that exit.
      const outstanding = holds.filter(hold => {
        const receipt = "instance" in hold ? announcementName(hold.instance) : hold.supervisor;
        return !receipt.startsWith("announced-") || this.exitRecorded(receipt) !== true;
      });
      const recovered = outstanding.length < holds.length && this.save(outstanding) ? outstanding : holds;
      return { holds: recovered, unknown: recovered.some(h => "supervisor" in h) };
    } catch (error) {
      const ledgerMissing = missing(error, this.path);
      const holds = this.discover({ ledgerMissing });
      if ((holds.length || !ledgerMissing) && !this.save(holds) && !holds.length) {
        holds.push({ jobId: randomUUID(), supervisor: SUPERVISOR_DIRECTORY });
      }
      return { holds, unknown: holds.length > 0 };
    }
  }

  discover({ ledgerMissing = false } = {}): Hold[] {
    let inventory: Launch[] | undefined;
    let incomplete = false;
    try {
      inventory = this.readInventory();
    } catch {
      // Its contents may include launches whose per-instance receipt was also lost.
      incomplete = true;
    }
    let records: Launch[] = [];
    try { records = this.processRecords(); }
    catch { if (!inventory) incomplete = true; }
    const launches = this.resolveLaunches([...(inventory ?? []), ...records]);
    if (!inventory) {
      if (incomplete || mayExist(this.usedPath) || (!ledgerMissing && !records.length)) {
        // Individual receipts identify possible players but do not prove that every receipt survived.
        launches.set(SUPERVISOR_DIRECTORY, { supervisor: SUPERVISOR_DIRECTORY });
      } else if (records.length) {
        // Import pre-inventory supervisor records before recovery creates the usage marker.
        this.lastInventory = [...launches.values()];
      }
    }
    return [...launches.values()].map(launch => typeof launch === "string"
      ? { jobId: randomUUID(), purpose: "ask", instance: launch }
      : { jobId: randomUUID(), supervisor: launch.supervisor });
  }

  private readInventory(): Launch[] | undefined {
    try { return z.array(launchSchema).parse(JSON.parse(readVoiceRecord(dirname(this.directory), this.inventoryPath))); }
    catch (error) {
      if (missing(error, this.inventoryPath)) return undefined;
      throw error;
    }
  }

  private processRecords(): Launch[] {
    const directory = join(this.directory, "supervised");
    try {
      return listVoiceRecords(dirname(this.directory), directory).filter(file => file.endsWith(".json")).map(file => {
        const name = file.slice(0, -5);
        return this.supervisorRecord(name) ?? { supervisor: name };
      });
    } catch (error) {
      if (missing(error, directory)) return [];
      throw error;
    }
  }

  private resolveLaunches(launches: Launch[]): Map<string, Launch> {
    const active = new Map<string, Launch>();
    for (const launch of launches) {
      if (typeof launch === "string") {
        active.set(announcementName(launch), launch);
      } else {
        const instance = this.supervisorRecord(launch.supervisor);
        if (instance) active.set(announcementName(instance), instance);
        // An unresolved slot in the inventory may already have been reused. Its current
        // occupant is a possible player, but only an immutable receipt identifies the original.
        if ((!instance || launch.supervisor !== announcementName(instance)) && !active.has(launch.supervisor)) {
          active.set(launch.supervisor, launch);
        }
      }
    }
    for (const name of active.keys()) {
      if (name.startsWith("announced-") && this.exitRecorded(name)) active.delete(name);
    }
    return active;
  }

  /** Keep the supervisor's process record separate from the daemon's receipt for each launch. */
  recordAnnouncement(instance: string, state: "started" | "exited", holds: Hold[], proof: string): "accepted" | "already_exited" | "unavailable" {
    const name = announcementName(instance);
    const path = join(this.directory, "supervised", name + ".json");
    try {
      if (state === "started") {
        const exited = this.exitRecorded(name);
        if (exited !== false) return exited ? "already_exited" : "unavailable";
      } else {
        if (!this.write(join(this.directory, "supervised-exits", name + ".json"), { instance, proof })) return "unavailable";
        removeVoiceRecord(dirname(this.directory), path);
      }
      let inventory: Launch[] | undefined;
      try { inventory = this.readInventory() ?? this.lastInventory; }
      catch {
        if (state === "started") return "unavailable";
      }
      // The signed exit is durable for this nonce. Leave an incomplete inventory untouched:
      // it cannot account for other players, and discovery will honor the exit if it returns.
      if (!inventory && state === "exited") return "accepted";
      const known: Launch[] = holds.flatMap((hold): Launch[] => {
        if ("instance" in hold) return [hold.instance];
        return hold.supervisor === SUPERVISOR_DIRECTORY ? [] : [{ supervisor: hold.supervisor }];
      });
      if (!inventory) {
        // A fresh directory or a new launch cannot reconstruct the missing launch history.
        if (mayExist(this.usedPath) || holds.some(hold => "supervisor" in hold && hold.supervisor === SUPERVISOR_DIRECTORY)) return "unavailable";
        inventory = [...this.resolveLaunches([...known, ...this.processRecords()]).values()];
        if (!this.write(this.inventoryPath, inventory)) return "unavailable";
      }
      const active = this.resolveLaunches([...known, ...inventory]);
      if (state === "started") {
        if (!this.write(path, { instance })) return "unavailable";
        active.set(name, instance);
      }
      const next = [...active.values()];
      if (!this.write(this.inventoryPath, next)) return "unavailable";
      this.lastInventory = next;
      return "accepted";
    } catch {
      return "unavailable";
    }
  }

  save(holds: Hold[]): boolean {
    // Keep proof of prior speech independent of all three sources of holder identities.
    if (holds.length && !this.write(this.usedPath, true)) return false;
    return this.write(this.path, holds);
  }

  private write(path: string, value: Hold[] | Launch[] | { instance: string; proof?: string } | true): boolean {
    return writeVoiceRecord(dirname(this.directory), path, value);
  }
}
