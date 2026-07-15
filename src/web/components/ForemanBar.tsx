import { useEffect, useRef, useState } from "react";
import type { ForemanState } from "../useForeman.ts";

// Topbar control for Foreman, the auto-responder. Shows whether it's off /
// drafting (dry-run) / acting (live), how deep its queue is, and whether the
// worker is running; the popover flips the mode, the repo allowlist for live
// sends, the access-approval switch, and the cheap-tier posture (off / shadow /
// on - see docs/plans/foreman-watcher/plan.md). Mirrors AlertBar's popover pattern.

const MODE_LABEL: Record<string, string> = {
  "dry-run": "dry-run",
  "semi-auto": "semi-auto",
  live: "live",
};

export function ForemanBar({ state }: { state: ForemanState }): React.JSX.Element {
  const { config, status, update } = state;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const enabled = config?.enabled ?? false;
  const mode = config?.mode ?? "dry-run";
  const chip = !enabled ? "off" : MODE_LABEL[mode] ?? mode;
  const running = status?.running ?? false;
  const queue = status?.queueDepth ?? 0;

  return (
    <div className="foremanbar" ref={ref}>
      <button
        className={`ghost-btn foreman-btn${enabled ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Foreman - the auto-responder"
      >
        <span
          className={`foreman-dot${enabled && running ? " live" : ""}`}
          aria-hidden
          title={running ? "worker running" : "worker not running"}
        />
        Foreman
        <span className="foreman-chip">{chip}</span>
        {enabled && queue > 0 && <span className="ghost-badge">{queue}</span>}
      </button>

      {open && config && (
        <div className="alert-pop foreman-pop" role="dialog" aria-label="Foreman settings">
          <label className="alert-row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => void update({ enabled: e.target.checked })}
            />
            Enable Foreman
          </label>

          <fieldset className="foreman-modes" disabled={!enabled}>
            <legend>Mode</legend>
            {(["dry-run", "semi-auto", "live"] as const).map((m) => (
              <label className="alert-row" key={m}>
                <input
                  type="radio"
                  name="foreman-mode"
                  checked={mode === m}
                  onChange={() => void update({ mode: m })}
                />
                {m === "dry-run" && "Dry-run - draft only, never send"}
                {m === "semi-auto" && "Semi-auto - draft + one-click send"}
                {m === "live" && "Live - send on my behalf"}
              </label>
            ))}
          </fieldset>

          <label className="alert-row">
            <input
              type="checkbox"
              checked={config.autoApproveAccess}
              disabled={!enabled}
              onChange={(e) => void update({ autoApproveAccess: e.target.checked })}
            />
            Auto-approve non-destructive access
          </label>

          <fieldset className="foreman-modes" disabled={!enabled}>
            <legend>Cheap tier</legend>
            {(["off", "shadow", "on"] as const).map((t) => (
              <label className="alert-row" key={t}>
                <input
                  type="radio"
                  name="foreman-triage"
                  checked={(config.triage ?? "shadow") === t}
                  onChange={() => void update({ triage: t })}
                />
                {t === "off" && "Off - full review for every prompt"}
                {t === "shadow" && "Shadow - run the cheap tier alongside, measure it"}
                {t === "on" && "On - cheap tier answers the easy ones"}
              </label>
            ))}
          </fieldset>

          {mode === "live" && (
            <label className="foreman-allowlist">
              Live only in these repos (one path per line):
              <textarea
                rows={3}
                defaultValue={config.repoAllowlist.join("\n")}
                placeholder="/Users/you/work/some-repo"
                onBlur={(e) =>
                  void update({
                    repoAllowlist: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          )}

          <p className="alert-hint">
            {running ? "Worker running." : "Worker not running - start it with "}
            {!running && <code>npm run foreman</code>}
            {status &&
              ` ${status.counts.answered} answered · ${status.counts.escalated} escalated · ${status.counts.pending} drafts`}
          </p>
        </div>
      )}
    </div>
  );
}
