import { useEffect, useRef } from "react";
import type { VoiceCard } from "@shared/voice-routing.ts";
import { VoiceCardView, type VoiceCardActions } from "./VoiceCardView.tsx";
import { useUiConfig } from "../lib/uiConfig.ts";
import { api } from "../lib/api.ts";
import { playChime } from "../lib/chime.ts";
import { newRequestId } from "../lib/request-id.ts";

function Card({ card, actions, notify, sound, notifications }: {
  card: VoiceCard; actions: VoiceCardActions; notify: boolean; sound: boolean; notifications: boolean;
}) {
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!notify || !card.deadline || card.state !== "pending" || announced.current === card.deadline) return;
    announced.current = card.deadline;
    if (sound) playChime("info");
  }, [card, notify, sound]);
  useEffect(() => {
    if (!notify || !card.deadline || card.state !== "pending") return;
    if (!notifications || document.hasFocus() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const recipient = card.parts.length === 1 ? "To " + card.parts[0]?.target?.name : "Two messages";
      const seconds = Math.ceil(Math.max(0, card.deadline - Date.now()) / 1000);
      if (seconds === 0) return;
      const title = recipient + " · sending in " + seconds + "s";
      const body = card.parts.map(p => card.parts.length === 1 ? p.text : p.target?.name + ": " + p.text).join("\n");
      const shell = window.missionDesktop;
      if (shell?.showVoiceCardNotice) {
        const id = newRequestId();
        let active = true;
        void shell.showVoiceCardNotice({ id, title, body, deadline: card.deadline }).then(choice => {
          if (active && choice) void api.voiceCardAction(card.id, choice);
        }).catch(() => {});
        return () => { active = false; shell.dismissVoiceCardNotice?.(id); };
      }
      const note = new Notification(title, { body, tag: "voice-" + card.id, silent: true });
      note.onclick = () => { window.focus(); note.close(); };
      return () => note.close();
    } catch { /* A browser may require a service worker for system notifications. */ }
  }, [card, notify, notifications]);
  return <VoiceCardView card={card} actions={actions} />;
}

export function VoiceCardHost({ cards, actions, surface, sound, notifications }: {
  cards: ReadonlyMap<string, VoiceCard>; actions: VoiceCardActions;
  surface?: "pill" | "popover"; sound: boolean; notifications: boolean;
}) {
  const { voice } = useUiConfig();
  // The dashboard owns the toast until the desktop opens the selected card window in Phase 12.
  if (surface && surface !== voice.confirmation) return null;
  const newestFirst = [...cards.values()].reverse();
  return <div className={surface ? "voice-card-surface" : "voice-card-stack"}>
    {(surface ? newestFirst.slice(0, 1) : newestFirst).map(card => <Card key={card.id} card={card} actions={actions}
      notify={!surface} sound={sound} notifications={notifications} />)}
  </div>;
}
