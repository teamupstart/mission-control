import { useEffect, useState } from "react";
import type { OpenTargetView } from "@shared/open-targets.ts";
import { fetchOpenTargets } from "./api.ts";

/**
 * The "Open in" menu's contents, fetched once for the whole dashboard.
 *
 * Availability is a fact about the DAEMON's host - which application handles the web
 * there, which launcher is installed - so the browser cannot derive it from
 * `OPEN_TARGET_INFO` and has to ask. Cached at module level, the way `lib/drafts.ts`
 * holds drafts, because every files view asks the same question and the answer costs a
 * subprocess on the other end: three console panes opening at once must not be three
 * `plutil` spawns.
 *
 * The TTL exists so an operator who installs a browser, or changes their default one,
 * gets an accurate menu within the minute instead of at the next reload. A FAILED fetch
 * is deliberately not cached: it is a transient the next open should retry, not an
 * answer.
 */
const TTL_MS = 60_000;

let cached: { at: number; targets: OpenTargetView[] } | null = null;
let inFlight: Promise<OpenTargetView[] | null> | null = null;

/** Drop the memo, so a test - or a manual refresh - starts from nothing. */
export function forgetOpenTargets(): void {
  cached = null;
  inFlight = null;
}

async function loadOpenTargets(): Promise<OpenTargetView[] | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.targets;
  inFlight ??= fetchOpenTargets().then((result) => {
    inFlight = null;
    if (!result) return null;
    cached = { at: Date.now(), targets: result.targets };
    return result.targets;
  });
  return inFlight;
}

export interface OpenTargetsState {
  /** Null until the first answer arrives. */
  targets: OpenTargetView[] | null;
  /**
   * The daemon could not be asked. Distinct from an empty list, which is a real answer
   * ("this build registers no targets"), and must not render as one: a menu that draws
   * empty for a dropped connection reads as "there is nowhere to open this".
   */
  failed: boolean;
}

export function useOpenTargets(): OpenTargetsState {
  const [state, setState] = useState<OpenTargetsState>(() => ({
    targets: cached?.targets ?? null,
    failed: false,
  }));
  useEffect(() => {
    let live = true;
    void loadOpenTargets().then((targets) => {
      if (live) setState({ targets, failed: targets === null });
    });
    return () => { live = false; };
  }, []);
  return state;
}
