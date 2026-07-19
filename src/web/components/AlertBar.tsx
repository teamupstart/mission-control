import { useEffect, useRef, useState } from "react";
import type { AwayConfig } from "@shared/protocol.ts";
import type { AlertSettings } from "../lib/alertSettings.ts";
import { playChime, unlockAudio } from "../lib/chime.ts";

const notifyApi = typeof Notification !== "undefined";

/** "for 25m" / "for 1h 05m" - how long you've been away, for the popover. */
function since(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/**
 * Topbar control for the alert layer: enable desktop notifications, toggle sound,
 * and flip away mode. The "Enable" click doubles as the user gesture that unlocks
 * audio for the chime.
 *
 * Away mode is server state, not a local preference - it survives this tab closing
 * and the daemon keeps detecting while you're gone - so it is passed in rather than
 * read from localStorage, and its control is disabled until the first read lands.
 */
export function AlertBar({
  settings,
  update,
  away,
  setAway,
}: {
  settings: AlertSettings;
  update: (patch: Partial<AlertSettings>) => void;
  away: AwayConfig | null;
  setAway: (patch: Partial<AwayConfig>) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission>(notifyApi ? Notification.permission : "denied");
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Only ticks while the popover is open and you're away - the one place the
  // elapsed time is actually rendered.
  useEffect(() => {
    if (!open || !away?.away) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [open, away?.away]);

  async function enable(): Promise<void> {
    unlockAudio(); // this click satisfies the browser autoplay gesture
    if (!notifyApi) return;
    const p = await Notification.requestPermission();
    setPerm(p);
    update({ notifications: p === "granted" });
  }

  const on = settings.notifications && perm === "granted";
  const isAway = Boolean(away?.away);
  const icon = isAway ? "🌙" : on ? "🔔" : "🔕";
  // The glyph already distinguishes the three states, so the button carries no
  // text; the state it used to spell out rides along in the label instead.
  const label = `Alerts & away mode - ${isAway ? "away" : on ? "on" : "muted"}`;

  return (
    <div className="alertbar" ref={ref}>
      <button
        className="ghost-btn glyph-btn"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
      >
        <span aria-hidden>{icon}</span>
      </button>
      {open && (
        <div className="alert-pop" role="dialog" aria-label="Alert settings">
          {perm !== "granted" && (
            <button className="btn btn-primary alert-enable" onClick={() => void enable()}>
              Enable desktop alerts
            </button>
          )}
          {perm === "denied" && (
            <p className="alert-hint">Notifications are blocked in the browser - the sound still plays.</p>
          )}
          <label className="alert-row">
            <input
              type="checkbox"
              checked={on}
              disabled={perm !== "granted"}
              onChange={(e) => update({ notifications: e.target.checked })}
            />
            Desktop notifications
          </label>
          <label className="alert-row">
            <input
              type="checkbox"
              checked={settings.sound}
              onChange={(e) => {
                unlockAudio();
                update({ sound: e.target.checked });
                if (e.target.checked) playChime("info");
              }}
            />
            Sound
          </label>
          <label className="alert-row">
            <input
              type="checkbox"
              checked={isAway}
              disabled={away === null}
              onChange={(e) => {
                void setAway({ away: e.target.checked });
                unlockAudio();
                if (settings.sound) playChime(e.target.checked ? "attention" : "info");
              }}
            />
            Away mode
          </label>
          <p className="alert-hint">
            {isAway
              ? "Only things blocked on you get through. Everything else is waiting in your digest."
              : "Buffers the noise and only interrupts you for things that are blocked on you."}
          </p>
          {isAway && away?.awaySince != null && (
            <p className="alert-hint">Away for {since(now - away.awaySince)}.</p>
          )}
        </div>
      )}
    </div>
  );
}
