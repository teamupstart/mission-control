// This tab's identity and sequence for the daemon's shaping write ordering.
//
// Kept in session storage, so every page the tab loads writes under the same identity, however
// often it reloads: a write sent before a reload and delayed past any number of them is refused
// once a newer one from the tab has applied. A duplicated tab copies that storage and so shares the
// identity, which orders the tab and its duplicates together: a delayed older save from either is
// refused once a newer one from either applied, so the newer edit always stands, and the refusal
// says the newer change may have come from a duplicate. Nothing is pruned or capped, and nothing
// waits on another tab.

const ID_KEY = "mission.shaping.write-identity";
const SEQUENCE_KEY = "mission.shaping.write-sequence";

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

let identity: string | null = null;
let lastSequence = 0;

/** This tab's write identity: the one its session storage holds, or a new one it then holds. */
export function shapingWriteIdentity(): string {
  if (identity) return identity;
  const stored = readStored(ID_KEY);
  identity = stored && IDENTITY.test(stored) ? stored : newShapingWriteIdentity();
  writeStored(ID_KEY, identity);
  return identity;
}

/**
 * Raise this tab's next sequences above `floor`, the sequence below which the daemon refuses every
 * write as expired. Sequences follow the wall clock, so one set back far enough would otherwise
 * have each new write refused until the clock caught up again.
 */
export function raiseShapingWriteSequence(floor: number): void {
  if (!Number.isSafeInteger(floor) || floor <= lastSequence) return;
  lastSequence = floor;
  writeStored(SEQUENCE_KEY, String(floor));
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
