import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { VoiceCard } from "@shared/voice-routing.ts";
import { VoiceCardView, type VoiceCardActions } from "./VoiceCardView.tsx";
import { useUiConfig } from "../lib/uiConfig.ts";
import { api, type ActionResult } from "../lib/api.ts";
import { playChime } from "../lib/chime.ts";
import { newRequestId } from "../lib/request-id.ts";

function Card({ card, actions, notify, sound, notifications, onDeadline }: {
  card: VoiceCard; actions: VoiceCardActions; notify: boolean; sound: boolean; notifications: boolean;
  onDeadline?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const run = useCallback(async (perform: () => Promise<ActionResult>, success = "", failure = "") => {
    setBusy(true);
    setFeedback("");
    try {
      const result = await perform();
      setFeedback(result.ok ? success : failure + (result.error ?? "The card changed before that action completed."));
    } catch {
      setFeedback(failure + "Mission Control could not complete that action.");
    } finally {
      setBusy(false);
    }
  }, []);
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!notify || !card.deadline || card.state !== "pending" || announced.current === card.deadline) return;
    announced.current = card.deadline;
    if (sound) playChime("info");
  }, [card, notify, sound]);
  const { id: cardId, deadline, state } = card;
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
    if (!notifications || document.hasFocus() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const seconds = Math.ceil(Math.max(0, deadline - Date.now()) / 1000);
      if (seconds === 0) return;
      const title = recipient + " · sending in " + seconds + "s";
      const shell = window.missionDesktop;
      if (shell?.showVoiceCardNotice) {
        const id = newRequestId();
        let active = true;
        void shell.showVoiceCardNotice({ id, title, body, deadline, scope }).then(choice => {
          if (!active || !choice) return;
          const label = choice === "cancel" ? "Cancel" : "Send now";
          void run(() => api.voiceCardAction(cardId, choice), "", `Desktop ${label} was not confirmed. `);
        }).catch(() => {});
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
      timer = window.setTimeout(close, Math.max(0, deadline - Date.now()));
      note.onclick = () => { window.focus(); close(); };
      return close;
    } catch { /* A browser may require a service worker for system notifications. */ }
  }, [cardId, deadline, state, waiting.length, recipient, body, scope, notify, notifications, run]);
  return <VoiceCardView card={card} actions={actions} operation={{ busy, feedback, run }} onDeadline={onDeadline} />;
}

export function VoiceCardHost({ cards, actions, surface, sound, notifications }: {
  cards: ReadonlyMap<string, VoiceCard>; actions: VoiceCardActions;
  surface?: "pill" | "popover"; sound: boolean; notifications: boolean;
}) {
  const { voice } = useUiConfig();
  const [, reselect] = useReducer((revision: number) => revision + 1, 0);
  // The dashboard owns the toast until the desktop opens the selected card window in Phase 12.
  if (surface && surface !== voice.confirmation) return null;
  const newestFirst = [...cards.values()].reverse();
  let visible = newestFirst;
  if (surface) {
    const now = Date.now();
    const pending = newestFirst.find(card => card.state === "pending" && card.deadline !== null && card.deadline > now);
    visible = pending ? [pending] : newestFirst.slice(0, 1);
  }
  return <div className={surface ? "voice-card-surface" : "voice-card-stack"}>
    {visible.map(card => <Card key={card.id} card={card} actions={actions}
      notify={!surface} sound={sound} notifications={notifications} onDeadline={surface ? reselect : undefined} />)}
  </div>;
}
