import { Tooltip, type TooltipContent } from "./Tooltip.tsx";

export interface SegmentMeterItem {
  key: React.Key;
  tone: string;
  fillPercent: number;
  grow: number;
  current?: boolean;
  degraded?: boolean;
  /** Optional because the existing pipeline meter exposes its detail through aria-describedby. */
  accessibleLabel?: string;
  /** False when the meter sits inside a larger link and cannot legally add nested tab stops. */
  focusable?: boolean;
  role?: React.AriaRole;
  tooltip: string | TooltipContent;
}

/**
 * How much of a segment is filled, as a percentage.
 *
 * Rounded to a tenth rather than passed raw: five of nine steps is 55.55555555555556, and a
 * seventeen-digit float in a `style` attribute is noise in every diff and every screenshot of
 * the DOM for a difference no display can render. A segment with no work has nothing to divide
 * by and is empty rather than NaN.
 */
export function segmentFillPercent(finished: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((finished / total) * 1000) / 10;
}

/**
 * The one segmented progress bar used by compact card meters.
 *
 * Callers own the projection and tooltip content. This leaf owns the geometry, tone classes,
 * focus ring, degraded hatch and minimum hit target so two meters on the same card cannot drift.
 */
export function SegmentMeter({ segments }: { segments: readonly SegmentMeterItem[] }): React.JSX.Element {
  return (
    <span className="tpm-bar">
      {segments.map((segment) => (
        <Tooltip key={segment.key} label={segment.tooltip}>
          {/*
            Focusable, so detail is not mouse-only: `Tooltip` opens on focus as well as hover.

            `flexGrow` comes from each caller's own projection rather than a hardcoded split,
            with the `min-width` floor in the stylesheet keeping a small segment hittable.
          */}
          <span
            className={`tpm-seg workflow-${segment.tone}${
              segment.current ? " is-now" : ""
            }${segment.degraded ? " is-degraded" : ""}`}
            style={{ flexGrow: segment.grow }}
            tabIndex={segment.focusable === false ? undefined : 0}
            aria-label={segment.accessibleLabel}
            role={segment.role}
          >
            <i style={{ width: `${segment.fillPercent}%` }} />
          </span>
        </Tooltip>
      ))}
    </span>
  );
}
