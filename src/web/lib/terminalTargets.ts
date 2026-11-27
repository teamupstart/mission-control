import { MACOS_TERMINAL_ID } from "@shared/terminal.ts";
import { useEffect, useState } from "react";
import type { TerminalTargetView } from "@shared/terminal.ts";
import { MACOS_TERMINAL_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import { fetchTerminalTargets } from "./api.ts";

/**
 * Which terminals can be opened, fetched once for the whole dashboard.
 *
 * The `useOpenTargets` shape, for the same reasons and one extra. Availability is a fact
 * about the DAEMON's host - which terminals are installed there - so the browser cannot
 * derive it from `TERMINAL_BACKEND_IDS` and has to ask. And it is asked from EVERY
 * conversation pane: the console detail, the board drill-in and every session detail mount
 * the same launcher, so without the memo a board with eight open sessions is eight
 * identical sweeps of the filesystem on the other end.
 *
 * The TTL is what makes installing a terminal show up within the minute rather than at the
 * next reload. A FAILED fetch is deliberately not cached - it is a transient the next open
 * should retry, not an answer.
 */
const TTL_MS = 60_000;

let cached: { at: number; targets: TerminalTargetView[] } | null = null;
let inFlight: Promise<TerminalTargetView[] | null> | null = null;
/**
 * Bumped by every invalidation, and captured by every request.
 *
 * Dropping the memo cannot cancel a request already in the air, so without this the loser of
 * that race still wins: an older read settles after a refresh started, writes its stale
 * answer into `cached`, and clears the `inFlight` belonging to the newer one.
 */
let generation = 0;
let cachedMacosTerminalPreview: boolean | undefined;

/** Drop the memo, so a test - or a manual refresh - starts from nothing. */
export function forgetTerminalTargets(): void {
  generation += 1;
  cached = null;
  inFlight = null;
}

/**
 * The memo in front of one route read, exported for the generation test - the race it guards
 * needs two reads in the air at once, which no caller can arrange from outside.
 */
export async function loadTerminalTargets(
  read: typeof fetchTerminalTargets = fetchTerminalTargets,
): Promise<TerminalTargetView[] | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.targets;
  const mine = generation;
  inFlight ??= read().then((result) => {
    const targets = result ? result.targets : null;
    // Superseded while in the air: still the honest answer for whoever awaited THIS promise,
    // but it may not touch the memo a newer request owns.
    if (mine !== generation) return targets;
    inFlight = null;
    if (targets) cached = { at: Date.now(), targets };
    return targets;
  });
  return inFlight;
}

export interface TerminalTargetsState {
  /** Null until the first answer arrives. */
  targets: TerminalTargetView[] | null;
  /**
   * The daemon could not be asked. Distinct from an empty list, which would be a real
   * answer, and must not render as one: a menu that draws empty for a dropped connection
   * reads as "you have no terminals".
   */
  failed: boolean;
}

/**
 * @param revision Bumped by a caller that has just asked the machine to be inspected again.
 * A change drops the memo and re-reads, so a Re-check retries an answer that failed rather
 * than leaving the caller with a dead reading until it happens to remount. Zero - the
 * default - reads once and keeps the TTL, which is what every other consumer wants.
 */
export function useTerminalTargets(revision = 0): TerminalTargetsState {
  const macosTerminalPreview = useFeatureFlag(MACOS_TERMINAL_FLAG_ID);
  const [state, setState] = useState<TerminalTargetsState>(() => ({
    targets: cached?.targets ?? null,
    failed: false,
  }));
  useEffect(() => {
    let live = true;
    if (revision > 0 || cachedMacosTerminalPreview !== macosTerminalPreview) {
      forgetTerminalTargets();
      cachedMacosTerminalPreview = macosTerminalPreview;
    }
    void loadTerminalTargets().then((targets) => {
      if (live) setState({ targets, failed: targets === null });
    });
    return () => {
      live = false;
    };
  }, [revision, macosTerminalPreview]);
  return macosTerminalPreview || !state.targets?.some(({ id }) => id === MACOS_TERMINAL_ID)
    ? state
    : { ...state, targets: state.targets.filter(({ id }) => id !== MACOS_TERMINAL_ID) };
}

/**
 * The target a terminal picker starts on before the operator chooses one.
 *
 * The operator's macOS default terminal when it can open a window right now, and only then
 * the first usable row. Registry order is a fact about Mission Control's adapters, not a
 * preference anyone expressed, so starting on it opened installers in a terminal the
 * operator had already chosen against for their whole machine.
 */
export function initialTerminalTarget(
  targets: readonly TerminalTargetView[] | null,
): TerminalTargetView | null {
  const available = targets?.filter((target) => target.unavailable === null) ?? [];
  return available.find((target) => target.systemDefault) ?? available[0] ?? null;
}
