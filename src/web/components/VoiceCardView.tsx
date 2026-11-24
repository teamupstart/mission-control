import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { voiceCardDeadline, voiceCardRetryDelay, voiceCountdownSeconds, type DashboardVoiceCard } from "../lib/voice-card-clock.ts";
import { agentKeepsWorking } from "@shared/async-input.ts";
import type { Session, ReviewItem } from "@shared/types.ts";
import { voiceCardCanExpire, type VoiceCard } from "@shared/voice-routing.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import { residentAccentStyle } from "../residents/marker.ts";
import { AgentName, SpokenHint } from "./AgentName.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { api, type ActionResult } from "../lib/api.ts";
import { newRequestId } from "../lib/request-id.ts";

export interface VoiceCardActions {
  sessions: readonly Session[];
  reviews: readonly ReviewItem[];
  roster: readonly SpokenName[];
  setVoiceCardInUse(id: string, inUse: boolean): void;
  openQuestion(sessionId: string): void;
  followUp(taskId: string): Promise<ActionResult> | ActionResult;
  relaunch(target: SpokenName, requestId: string): Promise<ActionResult>;
}

function RosterRow({ target, title, detail, state, pick, disabled }: {
  target?: SpokenName | null; title: string; detail: ReactNode; state?: string; pick?: () => void; disabled?: boolean;
}) {
  const Tag = pick ? "button" : "div";
  const row = <Tag className="vc-roster" style={target?.colorId ? residentAccentStyle(target.colorId) : undefined}
    {...(pick && { type: "button" as const, onClick: pick, disabled })}>
    <span className="agent-dot" /><span className="vc-grow"><span className="vc-name">{title}</span>{" "}
      {target?.kind === "resident" && <span className="resident-chip">RESIDENT</span>}
      <span className="vc-role">{detail}</span></span><span className="vc-state">{state}</span>
  </Tag>;
  return pick ? <Tooltip label={`Choose ${title} for this message`}>{row}</Tooltip> : row;
}

const icons = {
  mic: "M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z M4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5",
  unsure: "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M8 11.5v.1",
  check: "M3 8.5l3.2 3.2L13 4.8",
  clock: "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M8 4.5V8l2.3 1.5",
};
function Icon({ name }: { name: keyof typeof icons }) {
  return <svg className="vc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d={icons[name]} /></svg>;
}

function messageWithMentions(text: string, mentions: readonly SpokenName[]) {
  const byName = new Map(mentions.map(target => [target.name.toLowerCase(), target]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(name =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${names.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return text.split(pattern).map((piece, index) => {
    const target = index % 2 ? byName.get(piece.toLowerCase()) : null;
    return target ? <mark className="vc-mention" key={index}
      style={target.colorId ? residentAccentStyle(target.colorId) : undefined}>{piece}</mark> : piece;
  });
}

export function VoiceCardView({ card, actions, operation, hidden = false, fading = false }: {
  card: DashboardVoiceCard; actions: VoiceCardActions; hidden?: boolean; fading?: boolean;
  operation: { busy: boolean; feedback: string; run(perform: () => Promise<ActionResult>, success?: string, failure?: string, retryAfterMs?: number): Promise<void> };
}) {
  const [now, setNow] = useState(() => performance.now());
  const launchIds = useRef(new Map<string, string>());
  const { busy, feedback, run } = operation;
  const article = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState(false);
  const deadline = voiceCardDeadline(card);
  const settled = voiceCardCanExpire(card);
  const { setVoiceCardInUse } = actions;
  useLayoutEffect(() => {
    // Replacing or disabling a focused button can remove it without a blur event.
    if (focused && (hidden || !article.current?.contains(document.activeElement))) setFocused(false);
    const unreadFeedback = hidden && feedback !== "";
    if (!settled || !(focused || busy || unreadFeedback)) return;
    setVoiceCardInUse(card.id, true);
    return () => setVoiceCardInUse(card.id, false);
  }, [card, settled, focused, busy, hidden, feedback, setVoiceCardInUse]);
  useEffect(() => {
    if (hidden || deadline === null) return;
    let timer: number | undefined;
    const tick = () => {
      const time = performance.now();
      setNow(time);
      if (time < deadline) timer = window.setTimeout(tick, Math.min(100, deadline - time));
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [deadline, hidden]);
  // Standalone routes present one card at a time. Keep the operation and retry ID mounted.
  if (hidden) return null;
  const button = (label: string, hint: string, click: () => void, style = "", disabled = false) =>
    <Tooltip label={hint}><button type="button" className={`btn ${style}`} disabled={busy || disabled} onClick={click}>{label}</button></Tooltip>;
  const act = (action: "cancel" | "send-now") => {
    const time = performance.now();
    if (card.state === "pending" && (deadline === null || time >= deadline)) {
      setNow(time);
      return;
    }
    const label = action === "cancel" ? "Cancel" : "Send now";
    void run(() => api.voiceCardAction(card.id, action, { deadline }), "", label + " was not confirmed. ", voiceCardRetryDelay(deadline));
  };
  const cancel = button("Cancel", "Cancel pending voice delivery", () => act("cancel"), "btn-ghost");
  const remaining = Math.max(0, (deadline ?? 0) - now);
  const first = card.parts[0];
  const split = card.parts.length > 1;
  const sessionOf = (target?: SpokenName | null) => actions.sessions.find(s => s.id === target?.sessionId);
  const stateOf = (target?: SpokenName | null) => sessionOf(target)?.state.replaceAll("_", " ") ?? target?.state.replace("-", " ");
  const named = (target?: SpokenName | null) => target ? <AgentName view={target} /> : "agent";
  function outcome(part: VoiceCard["parts"][number]) {
    const target = part.target;
    const state = part.outcome ?? card.state;
    const name = target?.name ?? "agent";
    if (part.immediateStop && !part.outcome) return <b>Stopping {named(target)}…</b>;
    switch (state) {
      case "sent":
      case "queued":
        return <div className="vc-success"><Icon name={state === "sent" ? "check" : "clock"} />
          {state === "sent" ? <>{part.immediateStop ? "Stop sent to " : "Sent to "}{named(target)}</> : <>Queued behind {named(target)}’s current turn</>}</div>;
      case "held": {
        // The live outbox also identifies a session that resumed from hibernation.
        const session = actions.sessions.find(s => s.pendingTurns.some(t => t.id === part.turnId)) ?? sessionOf(target);
        const question = actions.reviews.find(r => r.sessionId === session?.id && r.status === "pending" && !agentKeepsWorking(r));
        const turn = session?.pendingTurns.find(t => t.id === part.turnId);
        return <><div className="vc-row"><Icon name="clock" /><b className="vc-grow">Held for {named(target)}</b>
          {button("Cancel message", "Recall this message from the agent’s queue", () => session && turn && void run(() => api.recallPendingTurn(session.id, turn.id, turn.revision)), "btn-ghost", !turn)}</div>
          <RosterRow target={target} title={name} detail={question ? "Asked: " + question.title : target?.role} state="blocked · older session" />
          <div className="vc-meta">{name}'s session started before this was possible, so the question cannot be set aside. Your message is delivered once it is answered.</div>
          <SpokenHint name={name} action="answer">Say <q>{name}, answer: ...</q> to answer it.</SpokenHint>
          <div className="vc-right">{button("Open question", "Open the question holding this message", () => session && actions.openQuestion(session.id), "", !question)}</div></>;
      }
      case "not-running": {
        if (!target || part.detail === "The selected session is unavailable.") {
          return <><b>{named(target)} is unavailable</b><span className="vc-meta">Nothing was sent</span></>;
        }
        const resident = target.kind === "resident";
        return <><div className="vc-row"><b className="vc-grow">{named(target)} {resident ? "isn't running" : "has finished"}</b><span className="vc-meta">Nothing was sent</span></div>
          <RosterRow target={target} title={name} detail={target?.role} state={resident ? "stopped" : "completed"} />
          <div className="vc-row"><span className="vc-hint vc-grow">{resident ? "Relaunch him, then say it again." : "Completed sessions are not resumed."}</span>
          {resident ? button("Relaunch " + name, "Start a new run for this resident", () => void run(() => {
            const id = launchIds.current.get(target.key) ?? newRequestId();
            launchIds.current.set(target.key, id);
            return actions.relaunch(target, id);
          }, "Relaunch requested."))
            : button("Start a follow-up task", "Open a new task on the same repository", () => void run(async () => actions.followUp(target.taskId!)), "", !target?.taskId)}</div></>;
      }
      case "cancelled": return <b>{split ? <>{named(target)} · </> : null}Cancelled</b>;
      case "failed": return <><b>Failed to send to {named(target)}</b><span className="vc-meta">{part.detail ?? card.detail}</span></>;
    }
  }

  let body: ReactNode;
  switch (card.state) {
    case "resolving": body = <b>Working out who this is for</b>; break;
    case "unsure":
      body = <><div className="vc-row"><Icon name="unsure" /><b>Who is this for?</b></div>
        <div className="vc-heard"><u>{first?.text.match(/^\S+/u)?.[0]}</u>{first?.text.replace(/^\S+/u, "")}</div>
        {card.candidates.map(c => {
          const target = actions.roster.find(t => t.key === (c.target?.key ?? c.id)) ?? c.target;
          return <RosterRow key={c.id} title={c.title} target={target} detail={c.detail} state={stateOf(target)}
            pick={() => void run(() => api.voiceCardAction(card.id, "pick", { candidateId: c.id }), "", "Recipient selection was not confirmed. ")} disabled={busy} />;
        })}
        <div className="vc-row"><span className="vc-grow vc-hint">Say the name again, or click a row. <q>Cancel</q> drops it.</span>{cancel}</div></>;
      break;
    case "pending": {
      const mention = !!card.mentions?.length;
      const remainingParts = card.parts.filter(part => !part.immediateStop);
      const recipient = remainingParts[0]?.target?.name;
      let sendLabel = "Send now";
      if (split && remainingParts.length > 1) sendLabel = "Send both now";
      else if ((split || mention) && recipient) sendLabel = "Send to " + recipient + " now";
      const sendHint = split && remainingParts.length > 1 ? "Deliver both messages before the countdown ends"
        : "Deliver this message before the countdown ends";
      body = <><div className="vc-row"><Icon name="mic" /><span className="vc-grow">{split ? <b>Two messages</b> : mention ? <b>One message</b> : <>To {named(first?.target)}</>}</span>
        {remaining > 0 && <span className="vc-seconds" aria-hidden="true">{card.provisionalDeadline ? "≤" : ""}{voiceCountdownSeconds(remaining, card.windowMs)}s</span>}</div>
        {card.parts.map((p, i) => split || mention ? <RosterRow key={i} target={p.target} title={p.target?.name ?? "Agent"}
          detail={p.immediateStop ? p.detail ?? p.text : mention ? messageWithMentions(p.text, card.mentions!) : p.text}
          state={p.immediateStop ? (p.outcome ? "stop " + p.outcome.replace("-", " ") : "stopping") : stateOf(p.target)} /> : <div key={i}>{p.text}</div>)}
        {card.mentions?.map(t => <div key={t.key} className="vc-meta">{t.name} is mentioned. Nothing is sent to {t.name}.</div>)}
        {deadline === null || remaining === 0 ? <span className="vc-meta">{deadline === null ? "Sending…" : "Awaiting delivery confirmation"}</span> : <>
          <div className="vc-count" aria-hidden="true"><i style={{ width: Math.min(100, remaining / (card.windowMs ?? 4000) * 100) + "%" }} /></div>
          <div className="vc-row"><span className="vc-hint vc-grow">Say <q>cancel</q> to stop{split ? card.parts.some(p => p.immediateStop) ? " the remaining message" : " both" : ""}.</span>
            {cancel}{button(sendLabel, sendHint, () => act("send-now"), "btn-send")}</div></>}</>;
      break;
    }
    default:
      body = <>{card.parts.map((part, index) => <div className="vc-outcome" key={index}>{outcome(part)}</div>)}
        {(card.state === "sent" || card.state === "queued") && card.openQuestions > 0 && <>
          <div className="vc-meta">{card.openQuestions} open question{card.openQuestions === 1 ? "" : "s"}.</div>
          <SpokenHint action="answer" name={first?.target?.name ?? ""}>Say <q>{first?.target?.name}, answer</q> to reply to one.</SpokenHint></>}</>;
  }
  return <article ref={article} role="status" data-fading={(fading && !focused && !busy) || undefined}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    className={`voice-card vc-${card.state}${split || card.mentions?.length ? " vc-multiple" : ""}`}
    style={first?.target?.colorId ? residentAccentStyle(first.target.colorId) : undefined}>
    {body}{feedback && <span className="vc-meta">{feedback}</span>}
  </article>;
}
