import { Tooltip } from "./Tooltip.tsx";

/**
 * A small "i" beside a control's name whose tooltip says what the control does, for a choice
 * whose explanation would crowd the row it sits in. A button so a keyboard reaches it; never
 * inside the control's `<label>`, where a click would toggle the control instead.
 */
export function InfoTip({ about, text }: { about: string; text: string }): React.JSX.Element {
  return (
    <Tooltip label={text}>
      <button type="button" className="info-tip" aria-label={`About ${about}`} onClick={(e) => e.preventDefault()}>
        i
      </button>
    </Tooltip>
  );
}
