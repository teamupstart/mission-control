import { useEffect, useRef, useState } from "react";
import type { AlertSettings } from "../lib/alerts.ts";
import { playChime, unlockAudio } from "../lib/chime.ts";

const notifyApi = typeof Notification !== "undefined";

/**
 * Topbar control for the alert layer: enable desktop notifications, toggle sound,
 * and flip AFK mode (alert on everything + periodic digests). The "Enable" click
 * doubles as the user gesture that unlocks audio for the chime.
 */
export function AlertBar({
  settings,
  update,
}: {
  settings: AlertSettings;
  update: (patch: Partial<AlertSettings>) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission>(notifyApi ? Notification.permission : "denied");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function enable(): Promise<void> {
    unlockAudio(); // this click satisfies the browser autoplay gesture
    if (!notifyApi) return;
    const p = await Notification.requestPermission();
    setPerm(p);
    update({ notifications: p === "granted" });
  }

  const on = settings.notifications && perm === "granted";
  const icon = settings.afk ? "🌙" : on ? "🔔" : "🔕";
  // The glyph already distinguishes the three states, so the button carries no
  // text; the state it used to spell out rides along in the label instead.
  const label = `Alerts & AFK mode - ${settings.afk ? "AFK" : on ? "on" : "muted"}`;

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
              checked={settings.afk}
              onChange={(e) => {
                update({ afk: e.target.checked });
                unlockAudio();
                if (settings.sound) playChime(e.target.checked ? "attention" : "info");
              }}
            />
            AFK mode
          </label>
          <p className="alert-hint">
            AFK also alerts on idle sessions + finished tasks, and sends a digest.
          </p>
          {settings.afk && (
            <label className="alert-row">
              Digest every
              <select
                value={settings.digestMinutes}
                onChange={(e) => update({ digestMinutes: Number(e.target.value) })}
              >
                <option value={5}>5 min</option>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
