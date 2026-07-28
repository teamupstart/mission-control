import { useEffect, useRef, useState } from "react";
import type { AwayConfig } from "@shared/protocol.ts";
import type { AwayBufferSummary } from "@shared/away-buffer.ts";
import type { AlertSettings } from "../lib/alertSettings.ts";
import { playChime, unlockAudio } from "../lib/chime.ts";
import { elapsed, reachability } from "../lib/reachability.ts";
import { Tooltip } from "./Tooltip.tsx";

const notifyApi = typeof Notification !== "undefined";

/**
 * One delivery channel: the whole row is the button, the pill only reflects it.
 *
 * The same bargain `.pal-switch` makes everywhere else in the app - a nested control
 * would steal the row's click and its tooltip - with `role="switch"` moved onto the
 * button so the thing that is actually focusable is the thing that announces its state.
 *
 * Note the class is `.alert-channel`, not `.alert-row`: the latter is the app's generic
 * settings checkbox row, shared with six other panels.
 */
function ChannelRow({
  glyph,
  label,
  on,
  disabled,
  tip,
  onFlip,
}: {
  glyph: string;
  label: string;
  on: boolean;
  disabled?: boolean;
  tip: string;
  onFlip: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <Tooltip label={tip}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className="alert-channel"
        data-disabled={disabled ? "true" : undefined}
        disabled={disabled}
        onClick={() => onFlip(!on)}
      >
        <span className="alert-channel-ico" aria-hidden>
          {glyph}
        </span>
        <span className="alert-channel-text">
          <span className="alert-channel-label">{label}</span>
        </span>
        <span className="pal-switch" data-on={on ? "true" : "false"} />
      </button>
    </Tooltip>
  );
}

/**
 * The popover's contents, split by what OWNS each piece of state.
 *
 * The two channels at the top are per-machine browser preferences; away mode below is a
 * server fact that survives this tab closing and keeps the daemon detecting while you
 * are gone. They used to be three identical checkboxes, which said the opposite - so
 * away mode gets its own card, and the card grows when it is on to show the thing that
 * is actually the point of the mode and was never mentioned in this panel at all: the
 * digest building up while you are out.
 *
 * Presentational and fully driven by props, including `now`, so all three of its states
 * can be rendered and asserted without a DOM, a clock or a Notification API. The one
 * sentence it prints comes from `reachability`, which settles "nothing can reach you"
 * before it settles "away" - so this card cannot claim blockers are getting through on a
 * machine with both channels off.
 */
export function AlertPanel({
  perm,
  desktopOn,
  soundOn,
  away,
  buffered,
  now,
  preview,
  onEnable,
  onFlipDesktop,
  onFlipSound,
  onFlipAway,
  onTogglePreview,
}: {
  perm: NotificationPermission;
  /** Desktop notifications wanted AND permitted - the effective state. */
  desktopOn: boolean;
  soundOn: boolean;
  /** Server away state; null until the first read lands, which disables the control. */
  away: AwayConfig | null;
  /** What is piling up in the open window; null when not away or not yet read. */
  buffered: AwayBufferSummary | null;
  now: number;
  preview: boolean;
  onEnable: () => void;
  onFlipDesktop: (next: boolean) => void;
  onFlipSound: (next: boolean) => void;
  onFlipAway: (next: boolean) => void;
  onTogglePreview: () => void;
}): React.JSX.Element {
  const isAway = Boolean(away?.away);
  const awayMs = isAway && away?.awaySince != null ? Math.max(0, now - away.awaySince) : null;
  const count = buffered?.count ?? 0;
  const reach = reachability({
    desktop: desktopOn,
    sound: soundOn,
    away: isAway,
    awayMs,
    buffered: count,
  });

  return (
    <div className="alert-pop" role="dialog" aria-label="Alert settings">
      {perm !== "granted" && (
        <Tooltip label="Ask the browser for permission to raise desktop notifications">
          <button className="btn btn-primary alert-enable" onClick={onEnable}>
            Enable desktop alerts
          </button>
        </Tooltip>
      )}
      {perm === "denied" && (
        <p className="alert-hint">Notifications are blocked in the browser - the sound still plays.</p>
      )}

      <span className="alert-sec">How you're reached</span>
      <ChannelRow
        glyph="▣"
        label="Desktop notifications"
        on={desktopOn}
        disabled={perm !== "granted"}
        tip={
          perm === "granted"
            ? "Raise a desktop notification when a session needs you"
            : "Grant the browser's notification permission above to enable this"
        }
        onFlip={onFlipDesktop}
      />
      <ChannelRow
        glyph="♪"
        label="Sound"
        on={soundOn}
        tip="Play a chime when a session needs you"
        onFlip={onFlipSound}
      />

      {/* Away mode is not a third channel, so it is not a third row. Server state, its
          own card, and the card carries the consequences of being in it. */}
      <div className="alert-card" data-on={isAway ? "true" : "false"} data-tone={reach.tone}>
        <Tooltip
          label={
            away === null
              ? "Waiting for the daemon to report away mode"
              : "Buffer the noise while you're gone - only things blocked on you interrupt, the rest waits in a digest"
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={isAway}
            aria-label="Away mode"
            className="alert-card-head"
            disabled={away === null}
            data-disabled={away === null ? "true" : undefined}
            onClick={() => onFlipAway(!isAway)}
          >
            <span className="alert-channel-ico" aria-hidden>
              ☾
            </span>
            <span className="alert-card-title">Away mode</span>
            <span className="pal-switch" data-on={isAway ? "true" : "false"} />
          </button>
        </Tooltip>

        <p className="alert-hint">
          {reach.title}. {reach.sentence}
        </p>

        {isAway && (
          <div className="alert-meta">
            {awayMs !== null && <span className="alert-fig">away {elapsed(awayMs)}</span>}
            <span className="alert-fig">
              {count > 0 ? `· ${count} buffered` : "· nothing buffered yet"}
            </span>
            <Tooltip
              label={
                count > 0
                  ? "Look at what is waiting. The full digest is written when you come back."
                  : "Nothing has happened since you left"
              }
            >
              <button
                type="button"
                className="btn alert-digest-btn"
                disabled={count === 0}
                aria-expanded={preview}
                onClick={onTogglePreview}
              >
                Digest
              </button>
            </Tooltip>
          </div>
        )}

        {/* A LOOK at the window still open, never a claim to BE the digest: the real one
            is written on return, and reading it is what consumes it. */}
        {isAway && preview && count > 0 && (
          <div className="alert-preview">
            <p className="alert-preview-rollup">{buffered?.rollup}</p>
            <ul className="alert-preview-list">
              {(buffered?.lines ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {(buffered?.dropped ?? 0) > 0 && (
              <p className="alert-preview-note">+{buffered?.dropped} beyond the buffer's cap</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Topbar control for the alert layer: the button, the popover mechanics, and the wiring
 * that turns a flip into a preference write or a daemon call.
 *
 * Away mode is server state, not a local preference - it survives this tab closing and
 * the daemon keeps detecting while you're gone - so it is passed in rather than read
 * from localStorage, and its control is disabled until the first read lands.
 *
 * The "Enable" click doubles as the user gesture that unlocks audio for the chime.
 */
export function AlertBar({
  settings,
  update,
  away,
  setAway,
  buffered,
}: {
  settings: AlertSettings;
  update: (patch: Partial<AlertSettings>) => void;
  away: AwayConfig | null;
  setAway: (patch: Partial<AwayConfig>) => Promise<void>;
  /** What is piling up in the open away window; null when not away or not yet read. */
  buffered: AwayBufferSummary | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission>(notifyApi ? Notification.permission : "denied");
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Whether the buffered preview is unfolded. Collapses with the popover. */
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    // Escape closes the popover like a click outside, and stops there rather than bubbling
    // to App's global Escape (which would collapse the expanded card or drop the fleet
    // selection behind it) - this popover is not a registered overlay, so nothing else
    // knows to swallow the key for it.
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Only ticks while the popover is open and you're away - the one place the
  // elapsed time is actually rendered.
  useEffect(() => {
    if (!open || !away?.away) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [open, away?.away]);

  // A closed popover forgets the preview, so reopening lands on the card rather than on
  // a list you unfolded an hour ago.
  useEffect(() => {
    if (!open) setPreview(false);
  }, [open]);

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
      <Tooltip label={label}>
        <button className="ghost-btn glyph-btn" onClick={() => setOpen((o) => !o)} aria-label={label}>
          <span aria-hidden>{icon}</span>
        </button>
      </Tooltip>
      {open && (
        <AlertPanel
          perm={perm}
          desktopOn={on}
          soundOn={settings.sound}
          away={away}
          buffered={buffered}
          now={now}
          preview={preview}
          onEnable={() => void enable()}
          onFlipDesktop={(next) => update({ notifications: next })}
          onFlipSound={(next) => {
            unlockAudio();
            update({ sound: next });
            if (next) playChime("info");
          }}
          onFlipAway={(next) => {
            void setAway({ away: next });
            unlockAudio();
            if (settings.sound) playChime(next ? "attention" : "info");
          }}
          onTogglePreview={() => setPreview((p) => !p)}
        />
      )}
    </div>
  );
}
