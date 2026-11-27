import type { CallSignCardStyle } from "@shared/protocol.ts";

/**
 * A session's call sign drawn beside its title while Always-on listens (`voiceCardCallSignMode`
 * is `element`), in the style the operator picked under Settings > Display > Board card >
 * Call sign. The card's title stays the session's own; this is the name voice answers to.
 *
 * Every style reads the same to a screen reader, "Call sign Marlin", so the visible shape is
 * the only thing the choice changes. `rail` is the Console rail row's compact form, which the
 * row draws for every style but Off because a rail row has no room for the others.
 */
export type CallSignMarkStyle = Exclude<CallSignCardStyle, "off"> | "rail";

function MicGlyph(): React.JSX.Element {
  return (
    <svg className="cs-mic" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z" />
      <path d="M4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5" />
    </svg>
  );
}

export function CallSignMark({ name, style }: { name: string; style: CallSignMarkStyle }): React.JSX.Element {
  if (style === "subtitle") {
    return (
      <span className="tile-name-sub cs-mark cs-sub">
        <MicGlyph />
        <span className="sr-only">Call sign </span>
        <span aria-hidden>Say </span>
        <b>{name}</b>
      </span>
    );
  }
  return (
    <span className={`cs-mark cs-${style}`}>
      <MicGlyph />
      <span className="sr-only">Call sign </span>
      {name}
    </span>
  );
}
