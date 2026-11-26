import { VoiceTranscriptText as Transcript } from "./VoiceTranscriptText.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { voiceCardDeadline, voiceCardRetryDelay, voiceCountdownSeconds, type DashboardVoiceCard, type VoiceCardRetention } from "../lib/voice-card-clock.ts";
import type { Session, ReviewItem } from "@shared/types.ts";
import { voiceCardCanExpire, type VoiceCard } from "@shared/voice-routing.ts";
import { spokenNameLabel, type SpokenName } from "@shared/voice-names.ts";
import { askSentence, type VoiceSpeechState } from "@shared/voice-speech.ts";
import { residentAccentStyle } from "../residents/marker.ts";
import { AgentName, SpokenHint } from "./AgentName.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { api, type ActionResult } from "../lib/api.ts";
import { newRequestId } from "../lib/request-id.ts";

export interface VoiceCardActions {
  speechJob?: VoiceSpeechState["job"];
  sessions: readonly Session[];
  reviews: readonly ReviewItem[];
  roster: readonly SpokenName[];
  setVoiceCardRetention(id: string, retention: VoiceCardRetention): void;
  openRecentlyHeard?(): void;
  openQuestion(sessionId: string, questionId: string): void;
  followUp(taskId: string): Promise<ActionResult> | ActionResult;
  relaunch(target: SpokenName, requestId: string): Promise<ActionResult>;
}

function RosterRow({ target, title, detail, transcript, state, pick, disabled }: {
  target?: SpokenName | null; title: string; detail: ReactNode; transcript?: string; state?: string; pick?: () => void; disabled?: boolean;
}) {
  const Tag = pick ? "button" : "div";
  const row = <Tag className="vc-roster" style={target?.colorId ? residentAccentStyle(target.colorId) : undefined}
    {...(pick && { type: "button" as const, onClick: pick, disabled })}>
    <span className="agent-dot" /><span className="vc-grow"><span className="vc-name">{title}</span>{" "}
      {target?.kind === "resident" && <span className="resident-chip">RESIDENT</span>}
      {transcript === undefined ? <span className="vc-role">{detail}</span> :
        <Transcript as="span" className="vc-role" text={transcript}>{detail}</Transcript>}</span><span className="vc-state">{state}</span>
  </Tag>;
  return pick ? <Tooltip label={`Choose ${title} for this message`}>{row}</Tooltip> : row;
}

const icons = {
  warn: "M8 2.2l6.3 11H1.7z M8 6.5v3.2M8 11.7v.1",
  speaker: "M2.5 6H5l3.5-3v10L5 10H2.5z M11 5.5a3.5 3.5 0 0 1 0 5 M12.8 3.5a6.5 6.5 0 0 1 0 9",
  mic: "M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z M4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5",
  unsure: "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M8 11.5v.1",
  check: "M3 8.5l3.2 3.2L13 4.8",
  clock: "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M8 4.5V8l2.3 1.5",
};
export function VoiceIcon({ name }: { name: keyof typeof icons }) {
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

/** The live region announces the available time once when this window becomes visible. */
export function CountdownAnnouncement({ card, deadline }: { card: DashboardVoiceCard; deadline: number }) {
  const [message] = useState(() => {
    const seconds = voiceCountdownSeconds(deadline - performance.now(), card.windowMs);
    if (!seconds) return "";
    const amount = (card.provisionalDeadline ? "up to " : "") + seconds + (seconds === 1 ? " second" : " seconds");
    const action = card.reason === "inbox-action" ? "run" : card.reason === "voice-answer" ? "submit" : "send";
    return "This card opened with " + amount + " to cancel or " + action + " now.";
  });
  return <span className="sr-only">{message}</span>;
}

export function VoiceCardView({ card, actions, operation, surface, hidden = false, fading = false, onActivate }: {
  card: DashboardVoiceCard; actions: VoiceCardActions; surface?: "pill" | "popover"; hidden?: boolean; fading?: boolean; onActivate?: () => void;
  operation: { busy: boolean; feedback: string; run(perform: () => Promise<ActionResult>, success?: string, failure?: string, retryAfterMs?: number): Promise<void> };
}) {
  const [now, setNow] = useState(() => performance.now());
  const launchIds = useRef(new Map<string, string>());
  const { busy, feedback, run } = operation;
  const article = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState(false);
  const deadline = voiceCardDeadline(card);
  const settled = voiceCardCanExpire(card);
  const { setVoiceCardRetention } = actions;
  useLayoutEffect(() => {
    // Replacing or disabling a focused button can remove it without a blur event.
    if (focused && (hidden || !article.current?.contains(article.current.ownerDocument.activeElement))) setFocused(false);
  }, [card, focused, busy, feedback, hidden]);
  const retention = busy || (focused && !hidden) ? "in-use" : hidden && feedback ? "hidden-feedback" : "reading";
  useLayoutEffect(() => {
    if (!settled) return;
    setVoiceCardRetention(card.id, retention);
  }, [card.id, settled, retention, setVoiceCardRetention]);
  useLayoutEffect(() => () => setVoiceCardRetention(card.id, "reading"), [card.id, setVoiceCardRetention]);
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
  // A hidden card keeps its operation and retry ID mounted until its surface shows it again.
  if (hidden) return null;
  const button = (label: string, hint: string, click: () => void, style = "", disabled = false, describedBy?: string) =>
    <Tooltip label={hint}><button type="button" className={`btn ${style}`} disabled={busy || disabled} onClick={click} aria-describedby={describedBy}>{label}</button></Tooltip>;
  const act = (action: "cancel" | "send-now") => {
    const time = performance.now();
    if (card.state === "pending" && (deadline === null || time >= deadline)) {
      setNow(time);
      return;
    }
    const label = action === "cancel" ? "Cancel" : card.reason === "voice-answer" ? "Submit now" : "Send now";
    void run(() => api.voiceCardAction(card.id, action, { deadline, answerCompanion: card.reason === "voice-answer" }), "", label + " was not confirmed. ", voiceCardRetryDelay(deadline));
  };
  const cancel = button("Cancel", "Cancel pending voice delivery", () => act("cancel"), "btn-ghost vc-cancel");
  const remaining = Math.max(0, (deadline ?? 0) - now);
  const first = card.parts[0];
  const split = card.parts.length > 1;
  const sessionOf = (target?: SpokenName | null) => actions.sessions.find(s => s.id === target?.sessionId);
  const stateOf = (target?: SpokenName | null) => sessionOf(target)?.state.replaceAll("_", " ") ?? target?.state.replace("-", " ");
  const named = (target?: SpokenName | null) => target ? <AgentName view={{ ...target, name: spokenNameLabel(target) }} /> : "agent";
  function outcome(part: VoiceCard["parts"][number]) {
    const target = part.target;
    const state = part.outcome ?? card.state;
    const name = target ? spokenNameLabel(target) : part.restoredSession?.name ?? "agent";
    const recipient = target ? named(target) : name;
    if (part.immediateStop && !part.outcome) return <b>Stopping {named(target)}…</b>;
    switch (state) {
      case "sent":
        return <div className="vc-success"><VoiceIcon name="check" />{part.command === "stop" || part.immediateStop ? "Stop sent to " : "Sent to "}{recipient}</div>;
      case "queued": {
        const session = sessionOf(target);
        return <div className="vc-success"><VoiceIcon name="clock" />{session?.state === "working" && !session.pause
          ? <>Queued behind {recipient}’s current turn</> : <>Queued for {recipient}</>}</div>;
      }
      case "held": {
        // The live outbox also identifies a session that resumed from hibernation.
        const session = actions.sessions.find(s => s.pendingTurns.some(t => t.id === part.turnId))
          ?? actions.sessions.find(s => s.id === (target?.sessionId ?? part.restoredSession?.id));
        const address = actions.roster.find(row => row.sessionId === session?.id);
        // A filed plan still gates the task, but its call no longer blocks spoken delivery.
        const question = actions.reviews.find(r => r.sessionId === session?.id && r.status === "pending" && r.waitMode !== "message");
        const turn = session?.pendingTurns.find(t => t.id === part.turnId);
        const wordsId = part.turnId && `voice-recall-words-${part.turnId}`;
        return <><div className="vc-row"><VoiceIcon name="clock" /><b className="vc-grow">Held for {recipient}</b>
          {button("Cancel message", "Recall this message from the agent’s queue", () => session && turn && void run(
            () => api.recallPendingTurn(session.id, turn.id, turn.revision, AbortSignal.timeout(5000)),
            "", "Recall was not confirmed. ", voiceCardRetryDelay(null)), "btn-ghost", !turn, wordsId)}</div>
          <Transcript as="q" id={wordsId} text={turn?.spokenWords ?? part.text} />
          <RosterRow target={target} title={name} detail={question ? "Asked: " + question.title : target?.role} state="blocked" />
          <div className="vc-meta">Your message stays queued until there are no blocking questions.</div>
          {address && <SpokenHint name={address} action="answer" command="{name}, my answer is …" instruction="to answer it." />}
          <div className="vc-right">{button("Open question", "Open the question holding this message", () => question && actions.openQuestion(question.sessionId, question.id), "", !question)}</div></>;
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
      case "failed": return <><b>Failed to send to {recipient}</b><span className="vc-meta">{part.detail ?? card.detail}</span></>;
    }
  }

  const simple = !split && !card.mentions?.length && !["voice-answer", "question-notice", "inbox-action"].includes(card.reason);
  const pill = surface === "pill" && simple;
  const seconds = voiceCountdownSeconds(remaining, card.windowMs);
  const progress = Math.min(100, remaining / (card.windowMs ?? 4000) * 100) + "%";
  const time = <>{card.provisionalDeadline ? "≤" : ""}{seconds}{pill ? "" : "s"}</>;
  const timerButton = <Tooltip label="Deliver this message before the countdown ends">
    <button type="button" aria-label="Send now" disabled={busy} onClick={() => act("send-now")}
      className={pill ? "vc-ring" : "vc-time-button vc-seconds"}
      style={pill ? { background: `conic-gradient(var(--working) ${progress}, var(--border) ${progress})` } : undefined}><span>{time}</span></button>
  </Tooltip>;
  const job = actions.speechJob;
  const playing = job?.state === "ready" || job?.state === "speaking";
  const asking = playing && job.cardId === card.id;
  const waitingForSilence = playing || job?.state === "stopping";
  let body: ReactNode;
  switch (card.state) {
    case "resolving": body = <b>Working out who this is for</b>; break;
    case "unsure":
      body = <>{asking ? <div className="vc-ask"><VoiceIcon name="speaker" />
        <span className="vc-grow">Asking aloud: <q>{askSentence(card.candidates.map(c => c.kind === "agent" && c.target ? spokenNameLabel(c.target) : c.title))}</q></span>
        {button("Stop", "Stop asking aloud", () => void run(() => api.stopVoiceSpeech(job.id)), "btn-ghost")}</div>
        : <><div className="vc-row"><VoiceIcon name="unsure" /><b>{card.candidates[0]?.kind === "question" ? "Which question?" : "Who is this for?"}</b></div>
        <Transcript className="vc-heard" text={first?.text ?? ""}><u>{first?.text.match(/^\S+/u)?.[0]}</u>{first?.text.replace(/^\S+/u, "")}</Transcript></>}
        {card.candidates.map(c => {
          if (c.kind === "question") return <Tooltip key={c.id} label="Choose this question for your voice reply">
            <button type="button" className="vc-roster" disabled={busy}
              onClick={() => void run(() => api.voiceCardAction(card.id, "pick", { candidate: c }))}><span>{c.title}</span><span className="vc-meta">{c.detail}</span></button>
          </Tooltip>;
          const target = actions.roster.find(t => t.key === (c.target?.key ?? c.id)) ?? c.target;
          return <RosterRow key={c.id} title={c.target ? spokenNameLabel(c.target) : c.title} target={target} detail={c.detail} state={stateOf(target)}
            pick={() => void run(() => api.voiceCardAction(card.id, "pick", { candidate: c }), "", "Recipient selection was not confirmed. ")} disabled={busy} />;
        })}
        <div className="vc-row"><span className="vc-grow vc-hint">{waitingForSilence ? "Pick a row now, or speak once playback ends." : <>{card.candidates[0]?.kind === "question" ? (card.detail ?? "Say the ordinal, or click a question.") : "Say the name again, or click a row."} <q>Cancel</q> drops it.</>}</span>{cancel}</div>
        {actions.openRecentlyHeard && button("Recently heard", "Open recently heard utterances", actions.openRecentlyHeard, "vc-history-link")}</>;
      break;
    case "pending": {
      if (pill && deadline !== null && remaining > 0) {
        body = <>{timerButton}<span className="vc-pill-message">
          To {named(first?.target)}: {first?.text}</span>{cancel}
          <span className="vc-pill-hint">Say <q>cancel</q> to stop.</span></>;
        break;
      }
      const mention = !!card.mentions?.length;
      const remainingParts = card.parts.filter(part => !part.immediateStop);
      const target = remainingParts[0]?.target;
      const recipient = target && spokenNameLabel(target);
      let sendLabel = card.reason === "voice-answer" ? "Submit now" : "Send now";
      if (card.reason === "inbox-action") sendLabel = "Run now";
      if (split && remainingParts.length > 1) sendLabel = "Send both now";
      else if ((split || mention) && recipient) sendLabel = "Send to " + recipient + " now";
      const sendHint = card.reason === "inbox-action" ? "Run this inbox action before the countdown ends"
        : card.reason === "voice-answer" ? "Submit this answer before the countdown ends" : split && remainingParts.length > 1 ? "Deliver both messages before the countdown ends"
        : "Deliver this message before the countdown ends";
      body = <><div className="vc-row">{(!surface || !simple) && <VoiceIcon name="mic" />}<span className="vc-grow">{card.reason === "inbox-action" ? <b>{first?.target ? named(first.target) : "Inbox action"}</b> : card.reason === "voice-answer" ? <b>Voice answer{first?.target && <> for {named(first.target)}</>}</b> : split ? <b>Two messages</b> : mention ? <b>One message</b> : <>To {named(first?.target)}</>}</span>
        {remaining > 0 && (surface && simple ? timerButton : <span className="vc-seconds" aria-hidden="true">{card.provisionalDeadline ? "≤" : ""}{voiceCountdownSeconds(remaining, card.windowMs)}s</span>)}</div>
        {card.questionTitle && <div className="vc-meta">{card.questionTitle}</div>}
        {card.parts.map((p, i) => {
          if (!split && !mention) return <Transcript key={i} text={p.text} />;
          const text = p.immediateStop ? p.detail ?? p.text : p.text;
          return <RosterRow key={i} target={p.target} title={p.target ? spokenNameLabel(p.target) : "Agent"} transcript={text}
            detail={mention && !p.immediateStop ? messageWithMentions(text, card.mentions!) : text}
            state={p.immediateStop ? (p.outcome ? "stop " + p.outcome.replace("-", " ") : "stopping") : stateOf(p.target)} />;
        })}
        {card.mentions?.map(t => <div key={t.key} className="vc-meta">{spokenNameLabel(t)} is mentioned. Nothing is sent to {spokenNameLabel(t)}.</div>)}
        {deadline === null || remaining === 0 ? <span className="vc-meta">{deadline === null ? "Sending…" : "Awaiting delivery confirmation"}</span> : <>
          <div className="vc-count" aria-hidden="true"><i style={{ width: Math.min(100, remaining / (card.windowMs ?? 4000) * 100) + "%" }} /></div>
          <div className="vc-row"><span className="vc-hint vc-grow">Say <q>cancel</q> to stop{split ? card.parts.some(p => p.immediateStop) ? " the remaining message" : " both" : ""}.</span>
            {cancel}{(!surface || !simple) && button(sendLabel, sendHint, () => act("send-now"), "btn-send")}</div></>}</>;
      break;
    }
    default:
      body = card.detail && ["capture-limit", "question-notice", "form-not-open", "form-incomplete", "inbox-action", "voice-answer"].includes(card.reason) ? <b>{card.detail}</b> : <>{card.parts.map((part, index) => <div className="vc-outcome" key={index}>{outcome(part)}</div>)}
        {(card.state === "sent" || card.state === "queued") && card.openQuestions > 0 && <>
          <div className="vc-meta">{card.openQuestions} open question{card.openQuestions === 1 ? "" : "s"}.</div>
          <SpokenHint action="answer" name={first?.target ?? ""} command="{name}, answer" instruction="to reply to one." /></>}</>;
  }
  return <article ref={article} role="status" tabIndex={surface ? -1 : undefined} aria-label={pill && card.state === "pending" ? `To ${first?.target && spokenNameLabel(first.target)}: ${first?.text}` : undefined} data-fading={(fading && !focused && !busy) || undefined}
    onFocus={() => { setFocused(true); onActivate?.(); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    data-pill={pill && ((card.state === "pending" && remaining > 0) || card.state === "sent" || card.state === "queued") || undefined}
    className={`voice-card vc-${card.state}${split || card.mentions?.length ? " vc-multiple" : ""}`}
    style={first?.target?.colorId ? residentAccentStyle(first.target.colorId) : undefined}>
    {body}{feedback && <span className="vc-meta">{feedback}</span>}
  </article>;
}
