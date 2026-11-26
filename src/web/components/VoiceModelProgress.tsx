import { formatBytes } from "@shared/format-bytes.ts";
import type { VoiceModelState } from "@shared/voice.ts";
import { Tooltip } from "./Tooltip.tsx";

/** "45 s left", "3 min left". */
function timeLeft(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s left`;
  return `${Math.round(seconds / 60)} min left`;
}

export function voiceModelProgressText(model: Pick<VoiceModelState, "status" | "doneBytes" | "totalBytes" | "bytesPerSecond">): string {
  const amount = `${formatBytes(model.doneBytes)} of ${formatBytes(model.totalBytes)}`;
  if (model.status === "verifying") return `Checked ${amount}`;
  if (model.bytesPerSecond === null || model.bytesPerSecond <= 0) return amount;
  const left = Math.max(0, model.totalBytes - model.doneBytes) / model.bytesPerSecond;
  return `${amount} · ${formatBytes(model.bytesPerSecond)}/s · ${timeLeft(left)}`;
}

export function VoiceModelProgress({ model, busy, onCancel }: {
  model: VoiceModelState; busy: boolean; onCancel(): void;
}): React.JSX.Element {
  const downloading = model.status === "downloading";
  const percent = model.totalBytes > 0 ? Math.min(100, Math.floor((model.doneBytes / model.totalBytes) * 100)) : 0;
  const figures = voiceModelProgressText(model);
  return (
    <div className="setup-remedy-actions voice-model-progress">
      <div
        className="app-banner-progress"
        role="progressbar"
        aria-label={downloading ? "Downloading the speech model" : "Checking the speech model"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={figures}
      >
        <span className="app-banner-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="voice-model-progress-line">
        <span className="voice-model-figures">{figures}</span>
        {downloading && (
          <Tooltip label="Stop the download and delete what it has written">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
