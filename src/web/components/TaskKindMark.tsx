import type { CSSProperties, ReactNode } from "react";

import { TASK_KIND_INFO } from "@shared/task.ts";
import type { TaskKindIconShape } from "@shared/task.ts";
import type { TaskKind } from "@shared/types.ts";
import { Tooltip } from "./Tooltip.tsx";

/** One shape of a kind's icon (`TASK_KIND_INFO[kind].icon`) as its SVG element. */
function IconShape({ shape }: { shape: TaskKindIconShape }): React.JSX.Element {
  switch (shape.shape) {
    case "path":
      return <path d={shape.d} />;
    case "circle":
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case "rect":
      return <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />;
  }
}

export function TaskKindIcon({ kind, size = 12 }: { kind: TaskKind; size?: number }): React.JSX.Element {
  // Width and height on the element, not only in CSS: an inline `<svg>` with a viewBox and
  // no size resolves to the width of its line.
  return (
    <svg className="tk-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      {TASK_KIND_INFO[kind].icon.map((shape, i) => (
        <IconShape key={i} shape={shape} />
      ))}
    </svg>
  );
}

/**
 * Where a kind is being marked. The header's four and the card's four are the styles the
 * operator picks between in Settings > Display (`TASK_KIND_HEADER_STYLES`,
 * `TASK_KIND_CARD_STYLES`); `tabs` is the header's tab-strip anchor and `tab` the card's
 * folder tab, which are different shapes in different places.
 */
export type TaskKindMarkVariant =
  | "badge"
  | "eyebrow"
  | "tile"
  | "tabs"
  | "tab"
  | "chip"
  | "band"
  | "medallion";

/**
 * A kind's colour as the inline `--kind` custom property, the way `agentAccentStyle` hands
 * a harness its colour. Exported for the one surface that tints something other than the
 * mark itself: the console header's left edge under the `tile` style.
 */
export function kindAccentStyle(kind: TaskKind): CSSProperties {
  return { "--kind": TASK_KIND_INFO[kind].accent } as CSSProperties;
}

/** The sentence a reader gets on hover, and the name an icon-only mark announces. */
export function taskKindName(kind: TaskKind): string {
  return `${TASK_KIND_INFO[kind].label} task`;
}

/**
 * A task's kind, marked in one of the styles the operator chose.
 *
 * Every style prints the kind's word except `medallion`, which is icon-only on purpose and
 * so carries `role="img"` with the word as its name. Colour arrives inline as `--kind` from
 * `TASK_KIND_INFO`, so `styles.css` holds one rule per style and none per kind.
 *
 * `children` is the agent dot for the two styles that take its place (`tile`, `medallion`):
 * the mark grows out of the dot rather than deleting which harness this is.
 */
export function TaskKindMark({
  kind,
  variant,
  children,
}: {
  kind: TaskKind;
  variant: TaskKindMarkVariant;
  children?: ReactNode;
}): React.JSX.Element {
  const info = TASK_KIND_INFO[kind];
  const style = kindAccentStyle(kind);
  const name = taskKindName(kind);
  const className = `tk-mark tk-${variant}`;
  let mark: React.JSX.Element;
  switch (variant) {
    case "eyebrow":
      mark = (
        <span className={className} style={style}>
          <TaskKindIcon kind={kind} size={11} />
          <b>{name}</b>
          <span className="tk-why">· {info.purpose}</span>
        </span>
      );
      break;
    case "band":
      mark = (
        <span className={className} style={style}>
          <TaskKindIcon kind={kind} size={11} />
          <b>{info.label}</b>
          <span className="tk-why">{info.purpose}</span>
        </span>
      );
      break;
    case "tile":
      mark = (
        <span className={className} style={style} role="img" aria-label={name}>
          <TaskKindIcon kind={kind} size={17} />
          <span className="tk-word" aria-hidden>
            {info.label}
          </span>
          {children}
        </span>
      );
      break;
    case "medallion":
      mark = (
        <span className={className} style={style} role="img" aria-label={name}>
          <TaskKindIcon kind={kind} size={12} />
          {children}
        </span>
      );
      break;
    case "tabs":
      mark = (
        <span className={className} style={style}>
          <TaskKindIcon kind={kind} />
          <span>{name}</span>
        </span>
      );
      break;
    case "badge":
      // The word in its own span so the header's last rung can shed it to a mark the way the
      // ladder sheds every other word: visually hidden, still the badge's accessible text.
      mark = (
        <span className={className} style={style}>
          <TaskKindIcon kind={kind} size={11} />
          <span className="tk-label">{info.label}</span>
        </span>
      );
      break;
    case "tab":
    case "chip":
      mark = (
        <span className={className} style={style}>
          <TaskKindIcon kind={kind} size={10} />
          {info.label}
        </span>
      );
      break;
  }
  return <Tooltip label={`${name} - ${info.purpose}`}>{mark}</Tooltip>;
}
