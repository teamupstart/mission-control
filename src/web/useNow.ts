import { useEffect, useState } from "react";

/**
 * The wall clock, advancing once a second while `ticking` - and not at all otherwise.
 *
 * A caller that renders several clocks holds ONE of these and passes the instant down, so a
 * stage of three running members re-renders once a second rather than three times, and every
 * clock on screen reads the same second.
 */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}
