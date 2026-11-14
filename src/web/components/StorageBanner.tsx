import { useEffect, useState } from "react";
import type { StorageHealth, StorageProblem } from "@shared/storage-health.ts";
import { Tooltip } from "./Tooltip.tsx";

const DISMISSED_KEY = "mission-control.storage-warnings.dismissed";
const NOTIFIED_KEY = "mission-control.storage-warnings.notified";
/** Occurrence ids remembered per key; older ones belong to warnings long since cleared. */
const REMEMBERED = 20;

function remembered(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function remember(key: string, ids: string[]): string[] {
  const next = [...new Set([...remembered(key), ...ids])].slice(-REMEMBERED);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage unavailable: this window still remembers for as long as it is open.
  }
  return next;
}

/** The size and free-space warnings standing now. A failed backup has its own surfaces. */
export function storageWarnings(health: StorageHealth | null): StorageProblem[] {
  return health?.problems.filter((problem) =>
    problem.kind === "low-free-space" || problem.kind === "storage-limit") ?? [];
}

/**
 * The fleet's storage banner, while a size or free-space warning stands and the operator has
 * not switched the banner off. Dismissing hides the occurrences shown; a warning that clears and
 * comes back is a new occurrence, with a new id, and shows again.
 */
export function StorageBanner({ health }: { health: StorageHealth | null }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<string[]>(() => remembered(DISMISSED_KEY));
  const warnings = storageWarnings(health).filter((problem) => !dismissed.includes(problem.id));
  if (!health?.limits.fleetBanner || warnings.length === 0) return null;
  const lowSpace = warnings.some((problem) => problem.kind === "low-free-space");
  return (
    <section
      className={`app-banner app-banner-storage${lowSpace ? "" : " is-warn"}`}
      role="status"
      aria-label="Storage warning"
    >
      <div className="app-banner-copy">
        <strong>{lowSpace ? "Disk space is running low." : "Mission Control is near its storage limit."}</strong>
        {warnings.map((problem) => <p key={problem.id}>{problem.message}</p>)}
      </div>
      <div className="app-banner-actions">
        <Tooltip label="See what is using the space and what can be removed">
          <a className="btn btn-primary" href="#/settings/storage">Open Storage</a>
        </Tooltip>
        <Tooltip label="Hide this warning until it clears and comes back">
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Dismiss storage warning"
            onClick={() => setDismissed(remember(DISMISSED_KEY, warnings.map((problem) => problem.id)))}
          >
            Dismiss
          </button>
        </Tooltip>
      </div>
    </section>
  );
}

/**
 * Which warnings get a desktop notification now: each size or free-space warning occurrence not
 * yet notified, and only while the operator has asked for notifications and this browser has
 * granted them. A failed backup is not one of them; the rail and Problems list carry it.
 */
export function storageNotificationsDue(input: {
  health: StorageHealth | null;
  /** `Notification.permission`, or null where the browser has no notifications at all. */
  permission: string | null;
  /** Occurrence ids already notified from this browser. */
  notified: readonly string[];
}): StorageProblem[] {
  if (!input.health?.limits.desktopNotification || input.permission !== "granted") return [];
  return storageWarnings(input.health).filter((problem) => !input.notified.includes(problem.id));
}

/**
 * One desktop notification per warning occurrence, when the operator asked for them and this
 * browser allows them. The occurrence id is the notification's tag, so two open windows replace
 * each other's toast rather than stacking two.
 */
export function useStorageNotifications(health: StorageHealth | null): void {
  const enabled = health?.limits.desktopNotification ?? false;
  const signature = storageWarnings(health).map((problem) => problem.id).join("|");
  useEffect(() => {
    const fresh = storageNotificationsDue({
      health,
      permission: typeof Notification === "undefined" ? null : Notification.permission,
      notified: remembered(NOTIFIED_KEY),
    });
    if (fresh.length === 0) return;
    remember(NOTIFIED_KEY, fresh.map((problem) => problem.id));
    for (const problem of fresh) {
      try {
        const toast = new Notification(
          problem.kind === "low-free-space" ? "Disk space is running low" : "Near the storage limit",
          { body: problem.message, tag: problem.id },
        );
        toast.onclick = () => {
          window.focus();
          window.location.hash = "#/settings/storage";
          toast.close();
        };
      } catch {
        // Some platforms refuse page notifications even with permission; the banner still shows.
      }
    }
    // `enabled` and `signature` stand for what this reads from `health`, which is a new object
    // on every stream frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature]);
}
