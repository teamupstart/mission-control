// This tab's identity and sequence for the daemon's shaping write ordering.
//
// Kept in session storage, so a reload keeps them: a write sent before the reload and delayed
// past it is ordered against the writes sent after it. Duplicating a tab copies its session
// storage too, which would leave two live tabs sharing one history, so a tab that loads asks the
// others over a broadcast channel whether its identity is already in use, and takes a new one if
// it is. A reloaded tab hears no answer, since the page that held its identity is gone.

const ID_KEY = "mission.shaping.write-identity";
const SEQUENCE_KEY = "mission.shaping.write-sequence";
const CHANNEL = "mission.shaping.write-identity";

type IdentityMessage = { type: "probe"; id: string } | { type: "taken"; id: string };

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
let channel: BroadcastChannel | null = null;
let lastSequence = 0;

/** This tab's write identity: the stored one, unless another live tab already holds it. */
export function shapingWriteIdentity(): string {
  if (identity) return identity;
  const stored = readStored(ID_KEY);
  identity = stored && /^[A-Za-z0-9-]{1,64}$/.test(stored) ? stored : newShapingWriteIdentity();
  writeStored(ID_KEY, identity);
  claim();
  return identity;
}

/** Ask the other live tabs whether this identity is theirs, and answer their asking about ours. */
function claim(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return;
  }
  // Never what keeps a process alive where one runs outside a browser.
  (channel as unknown as { unref?: () => void }).unref?.();
  channel.onmessage = (event: MessageEvent<IdentityMessage>) => {
    const message = event.data;
    if (!message || message.id !== identity) return;
    if (message.type === "probe") {
      // Another tab loaded with this tab's identity: a duplicate. This tab keeps it.
      channel?.postMessage({ type: "taken", id: message.id } satisfies IdentityMessage);
    } else if (message.type === "taken") {
      // This tab is the duplicate: it takes an identity of its own.
      identity = newShapingWriteIdentity();
      writeStored(ID_KEY, identity);
    }
  };
  if (identity) channel.postMessage({ type: "probe", id: identity } satisfies IdentityMessage);
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
