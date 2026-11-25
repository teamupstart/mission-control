import { Fragment, useEffect, useRef, useState } from "react";
import { INBOX_ACTIONS, type InboxActionId } from "@shared/inbox.ts";
import { cardActions } from "../lib/voice-inbox.ts";
import { CardVoiceFoot } from "./VoiceAnswerFooter.tsx";

/** Read the offered controls, including changes to their availability while the card is open. */
export function InboxVoiceFoot({ name }: { name?: string }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [actions, setActions] = useState<InboxActionId[]>([]);
  useEffect(() => {
    const card = anchor.current?.closest<HTMLElement>("[data-voice-kind]");
    if (!card) return;
    const sync = () => {
      const next = cardActions(card);
      setActions(prev => prev.join() === next.join() ? prev : next);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(card, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-voice-action"] });
    return () => observer.disconnect();
  }, []);
  const phrases = INBOX_ACTIONS.flatMap(({ id, spoken }) => {
    if (!actions.includes(id)) return [];
    const phrase = name ? spoken?.named.replace("{name}", name) : spoken?.whileOpen;
    return phrase ? [{ id, phrase: phrase.replace("...", "…") }] : [];
  });
  const commands = phrases.filter(p => !p.phrase.includes("…"));
  const text = phrases.find(p => p.phrase.includes("…"));
  return <div ref={anchor}>{phrases.length > 0 && <CardVoiceFoot>
    {commands.length > 0 && <>Say {commands.map(({ id, phrase }, i) => <Fragment key={id}>{i > 0 && (i === commands.length - 1 ? " or " : ", ")}<q>{phrase}</q></Fragment>)}. </>}
    {text && <><q>{text.phrase}</q> {text.id === "message" ? "sends a message." : text.id === "follow-up" ? "starts a follow-up." : "sends a reply."}</>}
  </CardVoiceFoot>}</div>;
}
