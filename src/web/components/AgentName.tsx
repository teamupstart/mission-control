import { useContext } from "react";
import { inboxAction, spokenHintExample, spokenHintText, type HintName, type InboxActionId } from "@shared/inbox.ts";
import { voiceButtonActions } from "../lib/voice-inbox.ts";
import { residentAccentStyle } from "../residents/marker.ts";
import { VoiceHintsContext, type AgentNameView } from "../lib/agent-names.ts";
import { Tooltip } from "./Tooltip.tsx";

/** Keep the command's quotation marks around the phrase only when its name is ordinary. */
export function hintExample(name: HintName, template: string) {
  const { phrase, quoteCommand } = spokenHintExample(name, template);
  return quoteCommand ? <q>{phrase}</q> : phrase;
}

/** An agent's name, in its resident's board colour when a resident name won. */
export function AgentName({
  view,
  className,
}: {
  view: AgentNameView;
  className?: string;
}): React.JSX.Element {
  const classes = [className, view.colorId ? "agent-name-resident" : null].filter(Boolean).join(" ");
  return (
    <strong
      className={classes || undefined}
      style={view.colorId ? residentAccentStyle(view.colorId) : undefined}
    >
      {view.name}
    </strong>
  );
}

/**
 * The spoken form of one card action, in lighter text beside its control. Renders nothing until
 * `VoiceHintsContext` turns hints on, which only the voice plan does.
 */
export function SpokenHint({
  command,
  instruction,
  action,
  name,
  cardOpen = false,
}: {
  action: InboxActionId;
  name: HintName;
  command?: string;
  instruction?: string;
  /** Whether the card is open on screen, which adds the action's short form when it has one. */
  cardOpen?: boolean;
}): React.JSX.Element | null {
  const on = useContext(VoiceHintsContext);
  if (!on) return null;
  const text = spokenHintText(inboxAction(action), name, cardOpen);
  return text ? <span className="spoken-hint" data-spoken-action={action}>{command ? <>Say {hintExample(name, command)} {instruction}</> : text}</span> : null;
}

/**
 * A card control drawn from its `INBOX_ACTIONS` entry, with its spoken hint beside it. `label`
 * draws the same action under another word (Retry for a failed follow-up) without making it a
 * second action: its id and spoken form stay the entry's.
 */
export function InboxActionButton({
  action,
  name,
  tooltip,
  onClick, onDictate, dictateDisabled,
  label,
  className = "btn btn-ghost",
  disabled = false,
  cardOpen = false,
  ariaLabel,
  ariaExpanded,
  ariaControls,
}: {
  action: InboxActionId;
  /** The agent's display name, for the hint. */
  name: HintName;
  tooltip: string;
  onClick: () => void;
  onDictate?: (text: string) => void;
  dictateDisabled?: boolean;
  label?: string;
  className?: string;
  disabled?: boolean;
  cardOpen?: boolean;
  ariaLabel?: string;
  /** For a control that shows and hides something: whether it is shown now. */
  ariaExpanded?: boolean;
  ariaControls?: string;
}): React.JSX.Element {
  const spec = inboxAction(action);
  return (
    <>
      <Tooltip label={tooltip}>
        <button
          type="button"
          className={className}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={ariaExpanded}
          aria-controls={ariaControls}
          data-inbox-action={spec.id}
          data-voice-action={spec.spoken && !(onDictate ? dictateDisabled : disabled) ? spec.id : undefined}
          ref={button => {
            if (!button || !spec.spoken) return;
            voiceButtonActions.set(button, onDictate ?? onClick);
            return () => { voiceButtonActions.delete(button); };
          }}
          onClick={onClick}
        >
          {label ?? spec.label}
        </button>
      </Tooltip>
      <SpokenHint action={action} name={name} cardOpen={cardOpen} />
    </>
  );
}
