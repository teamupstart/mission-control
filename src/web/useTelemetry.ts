import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TelemetryConfigPatch,
  TelemetryHealth,
  TelemetryOperation,
  TelemetryOperationResult,
  TelemetryProbeResult,
  TelemetryProfileId,
  TelemetrySettingsSummary,
  TelemetryStatus,
} from "@shared/telemetry.ts";
import { TELEMETRY_SETTINGS_OPENED_EVENT } from "@shared/telemetry-catalog.ts";
import {
  drainTelemetry,
  fetchTelemetryConfig,
  fetchTelemetryHealth,
  probeTelemetryEndpoint,
  runTelemetryOperation,
  setTelemetryConfig,
  submitBrowserTelemetry,
} from "./lib/api.ts";
import { beginOperation } from "./lib/operation-context.ts";

// The telemetry Settings panel's state.
//
// Deliberately NOT a poller, which is the one thing that would have been easy and wrong here.
// Queue state moves on its own - a cycle drains, a destination pauses itself, a backlog ages -
// and the daemon already pushes a bounded summary of exactly that on the settings-status
// channel every dashboard is holding open. A poll beside it would be a second store of the
// same facts, drifting by up to one interval, and the two would disagree visibly the moment an
// export landed between two ticks.
//
// So `summary` is the live input, owned by App and passed in, and the two reads this hook does
// make are BOUNDED BY IT: the config and the detailed health are re-read when the summary says
// something changed, never on a timer. A daemon that goes quiet leaves the panel showing what
// it last knew, which is the honest reading.

export interface TelemetryState {
  /** The live bounded summary, or null before the first snapshot ("unknown", not "off"). */
  summary: TelemetrySettingsSummary | null;
  /** The stored configuration. Null in the pre-read instant. */
  status: TelemetryStatus | null;
  /** The detailed view: gap records, error text, the installation pseudonym. */
  health: TelemetryHealth | null;
  /** Why the last write did not stick, or null. Cleared by the next one that does. */
  error: string | null;
  /** True when the last refusal was a concurrent edit rather than a bad value. */
  conflict: boolean;
  /** The last operation's own sentence, for the panel to echo. */
  notice: string | null;
  /** The last connection probe, per profile. */
  probe: TelemetryProbeResult | null;
  /** Which control is mid-flight, so the panel can disable exactly that one. */
  busy: string | null;
  update: (patch: Omit<TelemetryConfigPatch, "ifRevision">) => Promise<boolean>;
  operate: (action: TelemetryOperation, profile?: TelemetryProfileId) => Promise<void>;
  probeEndpoint: (profile: "user" | "product") => Promise<void>;
  drain: () => Promise<void>;
}

export function useTelemetry(
  summary: TelemetrySettingsSummary | null,
  /**
   * Whether the Telemetry panel is the one on screen.
   *
   * Gated for the same reason `useConductor` and `useRepoIndex` are: opening Settings on
   * Display must not read this subsystem. It matters more here than for those two, because
   * this hook also EMITS - `mission.telemetry.settings.opened` claims an operator opened the
   * telemetry controls, and a hook that ran on every Settings category would have recorded
   * that claim when somebody opened Keyboard.
   */
  visible: boolean,
): TelemetryState {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [health, setHealth] = useState<TelemetryHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [probe, setProbe] = useState<TelemetryProbeResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * What the live summary says has changed.
   *
   * A small signature rather than the object identity: the summary arrives as a fresh object on
   * every frame, so depending on it directly would re-read the config on every recompose - a
   * poll by another name. `configRevision` moves on any stored change from anywhere, including
   * another tab, and the queue figures move when a cycle does work.
   */
  const signature = summary
    ? `${summary.configRevision}:${summary.enabled}:${summary.gaps}:${summary.profiles
        .map((p) => `${p.pending}/${p.failing}/${p.pausedReason ?? ""}/${p.lastAcceptedAt ?? ""}`)
        .join(",")}`
    : "";

  const reload = useCallback(async (): Promise<void> => {
    const [next, nextHealth] = await Promise.all([fetchTelemetryConfig(), fetchTelemetryHealth()]);
    // `null` means the read failed. Keeping the last good answer beats blanking the panel: a
    // daemon that briefly went away has not told us that telemetry is off.
    if (next) setStatus(next);
    if (nextHealth) setHealth(nextHealth);
  }, []);

  useEffect(() => {
    if (!visible) return;
    void reload();
    // `signature` is the dependency on purpose - see its comment. The lint rule wants the
    // object it was derived from, which is exactly the dependency that would make this a poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, signature, visible]);

  /**
   * The revision every write is composed against, held in a ref so `update` does not have to
   * depend on `status` - which would rebuild the callback on every read and make each control's
   * handler a new function on every frame.
   */
  const revision = useRef(0);
  revision.current = status?.config.revision ?? 0;

  /**
   * The status as last known, readable without making `update` depend on it. This is what an
   * optimistic echo is taken back to when the daemon refuses.
   */
  const last = useRef<TelemetryStatus | null>(null);
  last.current = status;

  const update = useCallback(
    async (patch: Omit<TelemetryConfigPatch, "ifRevision">): Promise<boolean> => {
      setBusy("config");
      // Echo the change immediately, and TAKE IT BACK if the daemon refuses.
      //
      // Optimism is usually a nicety; here it is what makes a switch behave like a switch. A
      // checkbox that stays where it was until a round trip completes reads as one that did not
      // register the click, and the operator clicks again - which on a consent control means
      // sending the opposite decision. The revert is what keeps it honest: a refused write must
      // never leave a switch claiming a consent the daemon does not hold.
      const before = last.current;
      if (before) {
        setStatus({
          ...before,
          config: {
            ...before.config,
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.user ? { user: { ...before.config.user, ...patch.user } } : {}),
            ...(patch.product ? { product: { ...before.config.product, ...patch.product } } : {}),
          },
        });
      }
      const res = await setTelemetryConfig(
        { ...patch, ifRevision: revision.current },
        beginOperation("settings"),
      );
      setBusy(null);
      if (!res.ok) {
        if (before) setStatus(before);
        setError(res.error);
        setConflict(res.conflict);
        // A conflict means our copy is stale, so re-read rather than leaving the form arguing
        // with a daemon that has moved on.
        if (res.conflict) void reload();
        return false;
      }
      setError(null);
      setConflict(false);
      setStatus(res.data);
      // The health figures move with a consent change - a withdrawal purges a queue - and the
      // summary frame that would tell us is in flight. Re-reading here is not a poll; it is the
      // response to a write this panel just made.
      const nextHealth = await fetchTelemetryHealth();
      if (nextHealth) setHealth(nextHealth);
      return true;
    },
    [reload],
  );

  const operate = useCallback(
    async (action: TelemetryOperation, profile?: TelemetryProfileId): Promise<void> => {
      setBusy(`${action}:${profile ?? "all"}`);
      const res = await runTelemetryOperation({ action, profile }, beginOperation("settings"));
      setBusy(null);
      if (!res.ok) {
        setError(res.error);
        setConflict(false);
        return;
      }
      setError(null);
      setNotice(describe(res.data));
      await reload();
    },
    [reload],
  );

  const probeEndpoint = useCallback(
    async (profile: "user" | "product"): Promise<void> => {
      setBusy(`probe:${profile}`);
      setProbe(null);
      const res = await probeTelemetryEndpoint(profile, beginOperation("settings"));
      setBusy(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setProbe(res.data);
      await reload();
    },
    [reload],
  );

  const drain = useCallback(async (): Promise<void> => {
    setBusy("drain");
    const res = await drainTelemetry(beginOperation("settings"));
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setNotice(
      res.data.accepted > 0
        ? `Delivered ${res.data.accepted} batch${res.data.accepted === 1 ? "" : "es"}.`
        : "Nothing was waiting to be delivered.",
    );
    await reload();
  }, [reload]);

  // The one browser-originated fact Phase 2 owns: that somebody opened these controls, and what
  // state they were shown. Once per mount, fire and forget, and inert unless collection is on -
  // the daemon refuses it otherwise, which is the point of it going through the ordinary
  // ingress rather than a side channel.
  const announced = useRef(false);
  useEffect(() => {
    // Leaving the panel resets the latch, so the grain is ONCE PER VISIT rather than once per
    // page. `SettingsPage` stays mounted while the category changes, so a ref that only ever
    // latched would count an operator who opened Telemetry, left for Display and came back as
    // having opened it once - and, worse, a first visit made while collection was off would
    // consume the latch on a submission the daemon refused, silently suppressing every genuine
    // open for the life of the page. Both of those were true before this line.
    if (!visible) {
      announced.current = false;
      return;
    }
    if (announced.current || !summary) return;
    announced.current = true;
    void submitBrowserTelemetry(
      [
        {
          event: TELEMETRY_SETTINGS_OPENED_EVENT.name,
          facts: {
            collection_enabled: summary.enabled,
            destinations_enabled: summary.profiles.filter(
              (p) => p.profile !== "local" && p.capturing,
            ).length,
          },
        },
      ],
      beginOperation("settings"),
    );
  }, [summary, visible]);

  return {
    summary,
    status,
    health,
    error,
    conflict,
    notice,
    probe,
    busy,
    update,
    operate,
    probeEndpoint,
    drain,
  };
}

function describe(result: TelemetryOperationResult): string {
  return result.detail;
}
