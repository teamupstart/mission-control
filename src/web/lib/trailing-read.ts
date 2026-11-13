/**
 * Serialise a read so at most one runs at a time, with at most one more queued behind it.
 *
 * Every call settles after a read that began after the call was made, so a caller that just
 * wrote something still sees it. Calls made while a read is in flight share the one trailing
 * read instead of each starting their own: a read slower than the invalidations asking for it
 * then still lands, where "keep only the newest" discarded every answer and piled up requests.
 */
export function trailingRead(read: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let trailing: Promise<void> | null = null;
  const start = (): Promise<void> => {
    const run = read().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };
  return () => {
    if (trailing) return trailing;
    if (!inFlight) return start();
    const next = inFlight.catch(() => {}).then(() => {
      trailing = null;
      return start();
    });
    trailing = next;
    return next;
  };
}
