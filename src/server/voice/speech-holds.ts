import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { SpeechInstanceSchema } from "@shared/voice-speech.ts";

// A period represents the supervised directory itself if even its listing is unreadable.
export const SUPERVISOR_DIRECTORY = ".";
const supervisor = z.string().min(1).refine(name => !name.includes("/") && !name.includes("\\") && !name.includes("\0"));
const launchSchema = z.union([SpeechInstanceSchema, z.object({ supervisor }).strict()]);
type Launch = z.infer<typeof launchSchema>;
const entry = z.union([
  z.object({ jobId: z.string().uuid(), instance: SpeechInstanceSchema, purpose: z.enum(["ask", "audition"]) }).strict(),
  z.object({ jobId: z.string().uuid(), supervisor }).strict(),
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

export function announcementName(instance: string) {
  return "announced-" + createHash("sha256").update(instance).digest("hex");
}

/** Only the daemon writes the ledger. An unreadable supervisor file represents a possible player. */
export class SpeechHolds {
  private readonly path: string;
  private readonly inventoryPath: string;
  private readonly usedPath: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, "speech-holds.json");
    this.inventoryPath = join(directory, "supervised-instances.json");
    this.usedPath = join(dirname(directory), "voice-speech-used");
  }

  hasRecoveryEvidence(): boolean {
    return [this.usedPath, this.path, this.inventoryPath, join(this.directory, "supervised")].some(mayExist);
  }

  supervisorRecord(name: string): string | undefined {
    const path = join(this.directory, "supervised", name + ".json");
    try {
      const raw = readFileSync(path, "utf8");
      const instance = SpeechInstanceSchema.parse(JSON.parse(raw).instance);
      return name.startsWith("announced-") && announcementName(instance) !== name ? undefined : instance;
    } catch {
      return undefined;
    }
  }

  load(): { holds: Hold[]; unknown: boolean } {
    try {
      const holds = z.array(entry).parse(JSON.parse(readFileSync(this.path, "utf8")));
      if (new Set(holds.map(h => h.jobId)).size !== holds.length) throw new Error("Duplicate job");
      // Older daemons could already have handed out one of these jobs before the marker existed.
      if (holds.length && !mayExist(this.usedPath)) this.write(this.usedPath, true);
      return { holds, unknown: holds.some(h => "supervisor" in h) };
    } catch (error) {
      const ledgerMissing = missing(error, this.path);
      const holds = this.discover({ ledgerMissing });
      if (holds.length || !ledgerMissing) this.save(holds);
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
    if (incomplete || ((!ledgerMissing || mayExist(this.usedPath)) && !inventory && !records.length)) {
      launches.set(SUPERVISOR_DIRECTORY, { supervisor: SUPERVISOR_DIRECTORY });
    }
    return [...launches.values()].map(launch => typeof launch === "string"
      ? { jobId: randomUUID(), purpose: "ask", instance: launch }
      : { jobId: randomUUID(), supervisor: launch.supervisor });
  }

  private readInventory(): Launch[] | undefined {
    try { return z.array(launchSchema).parse(JSON.parse(readFileSync(this.inventoryPath, "utf8"))); }
    catch (error) {
      if (missing(error, this.inventoryPath)) return undefined;
      throw error;
    }
  }

  private processRecords(): Launch[] {
    const directory = join(this.directory, "supervised");
    try {
      return readdirSync(directory).filter(file => file.endsWith(".json")).map(file => ({ supervisor: file.slice(0, -5) }));
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
        else if (!active.has(launch.supervisor)) active.set(launch.supervisor, launch);
      }
    }
    return active;
  }

  /** Keep the supervisor's process record separate from the daemon's receipt for each launch. */
  recordAnnouncement(instance: string, state: "started" | "exited", holds: Hold[]): boolean {
    const name = announcementName(instance);
    const path = join(this.directory, "supervised", name + ".json");
    try {
      let inventory = this.readInventory();
      const known: Launch[] = holds.flatMap((hold): Launch[] => {
        if ("instance" in hold) return [hold.instance];
        return hold.supervisor === SUPERVISOR_DIRECTORY ? [] : [{ supervisor: hold.supervisor }];
      });
      if (!inventory) {
        // A fresh directory or a new launch cannot reconstruct the missing launch history.
        if (holds.some(hold => "supervisor" in hold && hold.supervisor === SUPERVISOR_DIRECTORY)) return false;
        inventory = [...this.resolveLaunches([...known, ...this.processRecords()]).values()];
        if (!this.write(this.inventoryPath, inventory)) return false;
      }
      const active = this.resolveLaunches([...known, ...inventory]);
      if (state === "started") {
        if (!this.write(path, { instance })) return false;
        active.set(name, instance);
      } else {
        try { unlinkSync(path); }
        catch (error) { if (!missing(error, path)) return false; }
        active.delete(name);
      }
      return this.write(this.inventoryPath, [...active.values()]);
    } catch {
      return false;
    }
  }

  save(holds: Hold[]): boolean {
    // Keep proof of prior speech independent of all three sources of holder identities.
    if (holds.length && !this.write(this.usedPath, true)) return false;
    return this.write(this.path, holds);
  }

  private write(path: string, value: Hold[] | Launch[] | { instance: string } | true): boolean {
    const temp = path + "." + randomUUID();
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
      return true;
    } catch {
      try { unlinkSync(temp); } catch { /* No staged file. */ }
      return false;
    }
  }
}
