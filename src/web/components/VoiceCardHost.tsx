import { spokenNameLabel } from "@shared/voice-names.ts";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { voiceCardDeadline, voiceCardRetryDelay, type DashboardVoiceCard } from "../lib/voice-card-clock.ts";
import { Tooltip } from "./Tooltip.tsx";
import { CountdownAnnouncement, VoiceCardView, type VoiceCardActions } from "./VoiceCardView.tsx";
import { api, type ActionResult } from "../lib/api.ts";
import { playChime } from "../lib/chime.ts";
import { newRequestId } from "../lib/request-id.ts";

function Card({ card, actions, surface, hidden, fading, notify, sound, notifications }: {
  card: DashboardVoiceCard; actions: VoiceCardActions; surface?: "pill" | "popover"; hidden: boolean; fading: boolean; notify: boolean; sound: boolean; notifications: boolean;
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
  const { id: cardId, state, reason } = card;
  const deadline = voiceCardDeadline(card);
  const wireDeadline = card.deadline;
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!notify || state !== "pending" || deadline === null || deadline <= performance.now() || announced.current === wireDeadline) return;
    announced.current = wireDeadline;
    if (sound) playChime("info");
  }, [deadline, notify, sound, state, wireDeadline]);
  const pendingNotice = useRef<{ wireDeadline: number; deadline: number } | null>(null);
  useLayoutEffect(() => {
    pendingNotice.current = state === "pending" && wireDeadline !== null && deadline !== null ? { wireDeadline, deadline } : null;
    return () => { pendingNotice.current = null; };
  }, [state, wireDeadline, deadline]);
  const waiting = card.parts.filter(part => !part.immediateStop);
  const stops = card.parts.filter(part => part.immediateStop);
  const scope = waiting.length > 1 ? "both" : stops.length ? "remaining" : "single";
  const recipient = waiting.length > 1 ? "Two messages" : "To " + (waiting[0]?.target ? spokenNameLabel(waiting[0].target) : "agent");
  const body = [
    ...waiting.map(part => waiting.length > 1 ? (part.target ? spokenNameLabel(part.target) : "agent") + ": " + part.text : part.text),
    ...stops.map(part => "Stop requested for " + (part.target ? spokenNameLabel(part.target) : "agent") + " separately."),
  ].join("\n");
  useEffect(() => {
    if (!notify || !deadline || state !== "pending" || !waiting.length) return;
    if (!notifications || typeof Notification === "undefined") return;
    let dismiss: (() => void) | undefined;
    let blurCount = 0;
    const showNotice = () => {
      try {
        const remaining = Math.max(0, deadline - performance.now());
        if (!remaining) return;
        const title = recipient + (reason === "voice-answer" ? " · voice answer pending" : " · voice message pending");
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
          void shell.showVoiceCardNotice({ id, title, body, remainingMs: Math.floor(remaining), scope }).then(choice => {
            if (!choice) return;
            if (choice === "window-focused") return allowRetry();
            // Electron can accept a button before a clock correction replaces the notice.
            // A matching daemon deadline identifies the original delivery across that change.
            const pending = pendingNotice.current;
            if (!pending || pending.wireDeadline !== wireDeadline) return;
            const label = choice === "cancel" ? "Cancel" : "Send now";
            void run(() => api.voiceCardAction(cardId, choice, { deadline: pending.deadline, answerCompanion: reason === "voice-answer" }), "",
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
  }, [cardId, wireDeadline, deadline, card.windowMs, card.provisionalDeadline, state, reason, waiting.length, recipient, body, scope, notify, notifications, run]);
  return <VoiceCardView surface={surface} card={card} actions={actions} hidden={hidden} fading={fading} operation={{ busy, feedback, run }} />;
}

export function VoiceCardHost({ cards, fadingCards, actions, surface, sound, notifications }: {
  cards: ReadonlyMap<string, DashboardVoiceCard>; fadingCards: ReadonlySet<string>; actions: VoiceCardActions;
  surface?: "pill" | "popover"; sound: boolean; notifications: boolean;
}) {
  const [, reselect] = useReducer((revision: number) => revision + 1, 0);
  const [selection, setSelection] = useState<{ id: string; openWindows: Map<string, number | null> } | null>(null);
  const now = performance.now();
  const pending: DashboardVoiceCard[] = [];
  const others: DashboardVoiceCard[] = [];
  for (const card of [...cards.values()].reverse()) {
    if (card.state === "pending" && (voiceCardDeadline(card) ?? 0) > now) pending.push(card);
    else others.push(card);
  }
  pending.sort((a, b) => {
    // A stop receipt refreshes a split in the stream without opening a new cancel window.
    const openedA = a.deadline! - (a.windowMs ?? 0);
    const openedB = b.deadline! - (b.windowMs ?? 0);
    return openedB - openedA || (b.firstReceivedAt ?? 0) - (a.firstReceivedAt ?? 0) || a.id.localeCompare(b.id);
  });
  const choices = pending.length ? pending : others;
  // A manual choice applies to the windows the operator has seen. Each later window
  // takes priority until it closes or the operator makes another explicit selection.
  const newWindow = pending.find(card => selection?.openWindows.get(card.id) !== card.deadline);
  const selected = surface && (newWindow ?? choices.find(card => card.id === selection?.id)
    ?? choices.find(card => card.state === "unsure") ?? choices[0]);
  const nextDeadline = pending.length ? Math.min(...pending.map(card => voiceCardDeadline(card)!)) : null;
  useEffect(() => {
    if (nextDeadline === null) return;
    const timer = window.setTimeout(reselect, Math.max(0, Math.ceil(nextDeadline - performance.now())));
    return () => window.clearTimeout(timer);
  }, [nextDeadline]);
  return <div className={surface ? "voice-card-surface" : "voice-card-stack"}>
    <div className="sr-only" role="region" aria-live="polite" aria-relevant="additions" aria-label="Voice countdown">
      {pending.filter(card => !selected || card === selected).map(card => <CountdownAnnouncement key={JSON.stringify([card.id, card.deadline])} card={card} deadline={voiceCardDeadline(card)!} />)}
    </div>
    {pending.concat(others).map(card => <Card surface={surface} key={JSON.stringify([card.id, card.deadline])} card={card} actions={actions} hidden={!!selected && card !== selected}
      fading={fadingCards.has(card.id)} notify={!surface} sound={sound} notifications={notifications} />)}
    {choices.length > 1 && selected && <label className="vc-switch">Voice message
      <Tooltip label="Choose which message to view and act on"><select value={selected.id} onChange={event =>
        setSelection({ id: event.target.value, openWindows: new Map(pending.map(card => [card.id, card.deadline])) })}>
        {choices.map(card => <option key={card.id} value={card.id}>
          {card.parts.map(part => [part.target ? spokenNameLabel(part.target) : part.restoredSession?.name, card.questionTitle, part.text].filter(Boolean).join(": ")).join(" · ")}
        </option>)}
      </select></Tooltip>
    </label>}
  </div>;
}
