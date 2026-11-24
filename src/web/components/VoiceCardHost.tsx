import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { voiceCardDeadline, voiceCardRetryDelay, voiceCountdownSeconds, type DashboardVoiceCard } from "../lib/voice-card-clock.ts";
import { Tooltip } from "./Tooltip.tsx";
import { VoiceCardView, type VoiceCardActions } from "./VoiceCardView.tsx";
import { useUiConfig } from "../lib/uiConfig.ts";
import { api, type ActionResult } from "../lib/api.ts";
import { playChime } from "../lib/chime.ts";
import { newRequestId } from "../lib/request-id.ts";

function Card({ card, actions, hidden, fading, notify, sound, notifications }: {
  card: DashboardVoiceCard; actions: VoiceCardActions; hidden: boolean; fading: boolean; notify: boolean; sound: boolean; notifications: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ state: DashboardVoiceCard["state"]; message: string } | null>(null);
  const feedback = actionFeedback?.state === card.state ? actionFeedback.message : "";
  const lastAttempt = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    lastAttempt.current++;
    window.clearTimeout(retryTimer.current);
  }, []);
  const run = useCallback(async (perform: () => Promise<ActionResult>, success = "", failure = "", retryAfterMs?: number) => {
    const attempt = ++lastAttempt.current;
    window.clearTimeout(retryTimer.current);
    setBusy(true);
    setActionFeedback(null);
    if (retryAfterMs !== undefined) retryTimer.current = window.setTimeout(() => {
      if (lastAttempt.current !== attempt) return;
      setActionFeedback({ state: card.state, message: failure + "Still waiting for the daemon." });
      setBusy(false);
    }, retryAfterMs);
    try {
      const result = await perform();
      if (lastAttempt.current !== attempt) return;
      const message = result.ok ? success : failure + (result.error ?? "The card changed before that action completed.");
      setActionFeedback({ state: card.state, message });
    } catch {
      if (lastAttempt.current === attempt) setActionFeedback({ state: card.state, message: failure + "Mission Control could not complete that action." });
    } finally {
      if (lastAttempt.current === attempt) {
        window.clearTimeout(retryTimer.current);
        setBusy(false);
      }
    }
  }, [card.state]);
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!notify || !card.deadline || card.state !== "pending" || announced.current === card.deadline) return;
    announced.current = card.deadline;
    if (sound) playChime("info");
  }, [card, notify, sound]);
  const { id: cardId, state } = card;
  const deadline = voiceCardDeadline(card);
  const wireDeadline = card.deadline;
  const pendingNotice = useRef<{ wireDeadline: number; deadline: number } | null>(null);
  useLayoutEffect(() => {
    pendingNotice.current = state === "pending" && wireDeadline !== null && deadline !== null ? { wireDeadline, deadline } : null;
    return () => { pendingNotice.current = null; };
  }, [state, wireDeadline, deadline]);
  const waiting = card.parts.filter(part => !part.immediateStop);
  const stops = card.parts.filter(part => part.immediateStop);
  const scope = waiting.length > 1 ? "both" : stops.length ? "remaining" : "single";
  const recipient = waiting.length > 1 ? "Two messages" : "To " + (waiting[0]?.target?.name ?? "agent");
  const body = [
    ...waiting.map(part => waiting.length > 1 ? part.target?.name + ": " + part.text : part.text),
    ...stops.map(part => "Stop requested for " + (part.target?.name ?? "agent") + " separately."),
  ].join("\n");
  useEffect(() => {
    if (!notify || !deadline || state !== "pending" || !waiting.length) return;
    if (!notifications || typeof Notification === "undefined") return;
    let dismiss: (() => void) | undefined;
    let blurCount = 0;
    const showNotice = () => {
      try {
        const remaining = Math.max(0, deadline - performance.now());
        const seconds = voiceCountdownSeconds(remaining, card.windowMs);
        if (seconds === 0) return;
        const title = recipient + (card.provisionalDeadline ? " · up to " + seconds + "s to cancel" : " · sending in " + seconds + "s");
        const shell = window.missionDesktop;
        if (shell?.showVoiceCardNotice) {
          const id = newRequestId();
          let active = true;
          const attempt = blurCount;
          const allowRetry = () => {
            if (!active) return;
            dismiss = undefined;
            // Another blur may have arrived before Electron replied to the first one.
            if (blurCount !== attempt) notifyWhenAway();
          };
          void shell.showVoiceCardNotice({ id, title, body, deadline: Date.now() + Math.floor(remaining), scope }).then(choice => {
            if (!choice) return;
            if (choice === "window-focused") return allowRetry();
            // Electron can accept a button before a clock correction replaces the notice.
            // A matching daemon deadline identifies the original delivery across that change.
            const pending = pendingNotice.current;
            if (!pending || pending.wireDeadline !== wireDeadline) return;
            const label = choice === "cancel" ? "Cancel" : "Send now";
            void run(() => api.voiceCardAction(cardId, choice, { deadline: pending.deadline }), "",
              `Desktop ${label} was not confirmed. `, voiceCardRetryDelay(pending.deadline));
          }, allowRetry);
          return () => { active = false; shell.dismissVoiceCardNotice?.(id); };
        }
        const note = new Notification(title, { body, tag: "voice-" + cardId, silent: true });
        let timer: number | undefined;
        const close = () => {
          if (timer === undefined) return;
          window.clearTimeout(timer);
          timer = undefined;
          note.onclick = null;
          note.close();
        };
        timer = window.setTimeout(close, Math.max(0, deadline - performance.now()));
        note.onclick = () => { window.focus(); close(); };
        return close;
      } catch { /* A browser may require a service worker for system notifications. */ }
    };
    function notifyWhenAway() {
      if (!dismiss && !document.hasFocus() && Notification.permission === "granted") dismiss = showNotice();
    }
    const onBlur = () => {
      blurCount++;
      notifyWhenAway();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", notifyWhenAway);
    notifyWhenAway();
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", notifyWhenAway);
      dismiss?.();
    };
  }, [cardId, wireDeadline, deadline, card.windowMs, card.provisionalDeadline, state, waiting.length, recipient, body, scope, notify, notifications, run]);
  return <VoiceCardView card={card} actions={actions} hidden={hidden} fading={fading} operation={{ busy, feedback, run }} />;
}

export function VoiceCardHost({ cards, fadingCards, actions, surface, sound, notifications }: {
  cards: ReadonlyMap<string, DashboardVoiceCard>; fadingCards: ReadonlySet<string>; actions: VoiceCardActions;
  surface?: "pill" | "popover"; sound: boolean; notifications: boolean;
}) {
  const { voice } = useUiConfig();
  const [, reselect] = useReducer((revision: number) => revision + 1, 0);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const newestFirst = [...cards.values()].reverse();
  const now = performance.now();
  const pending = surface ? newestFirst.filter(card => card.state === "pending" && (voiceCardDeadline(card) ?? 0) > now) : [];
  const choices = pending.length ? pending : newestFirst;
  const selected = surface && (choices.find(card => card.id === chosenId) ?? choices.find(card => card.state === "unsure") ?? choices[0]);
  const nextDeadline = pending.length ? Math.min(...pending.map(card => voiceCardDeadline(card)!)) : null;
  useEffect(() => {
    if (nextDeadline === null) return;
    const timer = window.setTimeout(reselect, Math.max(0, Math.ceil(nextDeadline - performance.now())));
    return () => window.clearTimeout(timer);
  }, [nextDeadline]);
  // The dashboard owns the toast until the desktop opens the selected card window in Phase 12.
  if (surface && surface !== voice.confirmation) return null;
  return <div className={surface ? "voice-card-surface" : "voice-card-stack"}>
    {newestFirst.map(card => <Card key={card.id} card={card} actions={actions} hidden={!!selected && card !== selected}
      fading={fadingCards.has(card.id)} notify={!surface} sound={sound} notifications={notifications} />)}
    {choices.length > 1 && selected && <label className="vc-switch">Voice message
      <Tooltip label="Choose which message to view and act on"><select value={selected.id} onChange={event => setChosenId(event.target.value)}>
        {choices.map(card => <option key={card.id} value={card.id}>
          {card.parts.map(part => [part.target?.name, part.text].filter(Boolean).join(": ")).join(" · ")}
        </option>)}
      </select></Tooltip>
    </label>}
  </div>;
}
