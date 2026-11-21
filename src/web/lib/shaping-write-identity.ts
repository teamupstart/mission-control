// This page's identity and sequence for the daemon's shaping write ordering.
//
// Every page load takes an identity of its own, so no two live pages ever share one, a duplicated
// tab included, and nothing has to ask the other tabs or wait for their answer. The identities the
// tab held before, its lineage, are kept in session storage and sent with each write: the daemon
// records an applied write against them as well as against its own identity, so a write sent
// before a reload and delayed past it is refused once a newer write from the reloaded page has
// applied. A duplicated tab copies that storage, so it inherits the lineage but never the identity
// the original tab still writes under.

import { SHAPING_WRITE_WINDOW_MS } from "@shared/shaping.ts";

const ID_KEY = "mission.shaping.write-identity";
const LINEAGE_KEY = "mission.shaping.write-lineage";
const SEQUENCE_KEY = "mission.shaping.write-sequence";

/**
 * The most earlier identities a write names. An earlier identity matters only while a write sent
 * under it could still apply, `SHAPING_WRITE_WINDOW_MS` after it was replaced, so this bounds only a
 * tab reloaded more often than this in that time.
 */
export const SHAPING_LINEAGE_KEPT = 8;

const IDENTITY = /^[A-Za-z0-9-]{1,64}$/;

/** A random id, as the write-order header accepts it. */
export function newShapingWriteIdentity(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readStored(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function writeStored(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch { /* Session storage unavailable: this load keeps its own. */ }
}

/** An identity the tab held before, and when it was replaced, in milliseconds. */
interface Earlier {
  id: string;
  until: number;
}

function readLineage(): Earlier[] {
  try {
    const parsed: unknown = JSON.parse(readStored(LINEAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is Earlier => typeof entry === "object" && entry !== null
      && typeof (entry as Earlier).id === "string" && IDENTITY.test((entry as Earlier).id)
      && typeof (entry as Earlier).until === "number");
  } catch {
    return [];
  }
}

/** The identity this page writes under, and the identities its tab held before it. */
export interface ShapingWriteIdentity {
  window: string;
  lineage: readonly string[];
}

let current: ShapingWriteIdentity | null = null;
let lastSequence = 0;

/**
 * This page's write identity, taken on first use: a new one, whose lineage is the identity the tab
 * held before this load and that one's lineage, less any replaced longer ago than a write can wait.
 */
export function shapingWriteIdentity(now = Date.now()): ShapingWriteIdentity {
  if (current) return current;
  const earlier = readLineage().filter((entry) => now - entry.until <= SHAPING_WRITE_WINDOW_MS);
  const previous = readStored(ID_KEY);
  if (previous && IDENTITY.test(previous)) earlier.push({ id: previous, until: now });
  const kept = earlier.slice(-SHAPING_LINEAGE_KEPT);
  current = { window: newShapingWriteIdentity(), lineage: kept.map((entry) => entry.id) };
  writeStored(ID_KEY, current.window);
  writeStored(LINEAGE_KEY, JSON.stringify(kept));
  return current;
}

/**
 * The next write sequence for this tab: never lower than one handed out before, across reloads
 * too, and grounded in the clock, so a write sent later always outranks one sent earlier.
 */
export function nextShapingWriteSequence(): number {
  let previous = lastSequence;
  const stored = Number(readStored(SEQUENCE_KEY));
  if (Number.isSafeInteger(stored) && stored > previous) previous = stored;
  const next = Math.max(Date.now() * 1000, previous + 1);
  lastSequence = next;
  writeStored(SEQUENCE_KEY, String(next));
  return next;
}
