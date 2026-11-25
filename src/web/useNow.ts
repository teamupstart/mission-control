import { useEffect, useState } from "react";

/**
 * The wall clock, advancing every `everyMs` (a second by default) while `ticking` - and not at
 * all otherwise.
 *
 * A caller that renders several clocks holds ONE of these and passes the instant down, so a
 * stage of three running members re-renders once a second rather than three times, and every
 * clock on screen reads the same second. A clock that only reads minutes or hours asks for a
 * slower tick rather than stopping, so it never freezes at the last value it showed.
 */
export function useNow(ticking: boolean, everyMs = 1000, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    if (!ticking) return;
    setNow(clock());
    const id = setInterval(() => setNow(clock()), everyMs);
    return () => clearInterval(id);
  }, [ticking, everyMs, clock]);
  return now;
}
