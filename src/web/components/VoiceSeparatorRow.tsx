import { useEffect, useRef, useState } from "react";
import { VOICE_CONFIG_DEFAULTS } from "@shared/voice.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import { normalizeSeparatorWord, separatorWordProblem, VOICE_SEPARATOR_DEFAULT } from "@shared/voice-separator.ts";
import type { VoiceConfigState } from "../useVoiceConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Settings > Voice > Input: the word that ends one Always-on message and starts the next.
 * One self-contained row, so the Voice settings layout can place it beside End-of-speech delay.
 */
export function SeparatorWordRow({ state, dedicated, roster = [] }: {
  state: VoiceConfigState;
  dedicated: boolean;
  roster?: readonly SpokenName[];
}) {
  const saved = state.config?.separatorWord ?? VOICE_CONFIG_DEFAULTS.separatorWord;
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const discard = useRef(false);
  useEffect(() => { if (!editing) setDraft(saved); }, [saved, editing]);

  const commit = async () => {
    setEditing(false);
    if (discard.current) {
      discard.current = false;
      setDraft(saved);
      return;
    }
    // An empty field restores the default rather than turning the separator off.
    const word = draft.trim() || VOICE_SEPARATOR_DEFAULT;
    const issue = separatorWordProblem(word);
    if (issue) {
      setProblem(issue);
      setDraft(saved);
      return;
    }
    setProblem(null);
    setDraft(word);
    if (word === saved) return;
    if (!await state.update({ separatorWord: word })) setProblem("The separator word was not saved. Try again.");
  };

  const callSign = roster.find(name => normalizeSeparatorWord(name.name) === normalizeSeparatorWord(saved));
  return (
    <div className="kb-row" data-anchor="voice/separator">
      <div className="kb-row-text">
        <label className="kb-row-label" htmlFor="voice-separator">Separator word</label>
        <span className="kb-row-desc">{dedicated
          ? "Push-to-talk ends on key release."
          : <>Say it between two messages to send both without pausing. Example: “Steve, check the build, {saved}, Carol, report status.”</>}
        {!dedicated && callSign && <> “{callSign.name}” is also a call sign, so a capture that starts with it addresses that agent.</>}</span>
        {problem && <span className="settings-error voice-separator-error" role="alert">{problem}</span>}
      </div>
      <div className="kb-row-controls">
        <Tooltip label="One word. Clear the field to restore “bagel”.">
          <input id="voice-separator" className="field-input voice-separator-input" type="text"
            autoComplete="off" spellCheck={false} maxLength={64} disabled={!state.config || dedicated}
            value={draft} aria-invalid={problem ? true : undefined}
            onFocus={() => setEditing(true)}
            onChange={event => { setEditing(true); setDraft(event.target.value); setProblem(null); }}
            onBlur={() => void commit()}
            onKeyDown={event => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") { discard.current = true; setProblem(null); event.currentTarget.blur(); }
            }} />
        </Tooltip>
      </div>
    </div>
  );
}
