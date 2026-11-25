import { optionLetter } from "@shared/voice-answers.ts";
import type { PlanDecision, PlanDecisionOption } from "@shared/types.ts";
import { type DashboardVoiceAnswer, voiceCardDeadline, voiceCountdownSeconds } from "../lib/voice-card-clock.ts";
import { useNow } from "../useNow.ts";
import { Tooltip } from "./Tooltip.tsx";
import { VoiceIcon } from "./VoiceCardView.tsx";

export function CardVoiceFoot({ children }: { children: React.ReactNode }) {
  return <div className="vh-foot"><VoiceIcon name="mic" /><span>{children}</span></div>;
}

export function QuestionVoiceHint({ name, decision }: { name?: string; decision?: PlanDecision }) {
  const count = decision?.options.length ?? 0;
  const addressed = name ?? "reply";
  const example = count > 1 && name ? "B" : "A";
  const prefix = name ? "Say " : "No spoken name: with this card open, say ";
  const option = <q>{addressed}, option {example}</q>;
  if (decision && !decision.allowOther) return <CardVoiceFoot>{prefix}{option} to select an option.</CardVoiceFoot>;
  return <CardVoiceFoot>
    {prefix}{count > 0 && <>{option}{name ? " to answer, or " : " or "}</>}
    <q>{name ? name + ", my answer is …" : "reply, …"}</q>{name ? " to answer in your own words." : "."}
  </CardVoiceFoot>;
}

const monotonicNow = () => performance.now();

export function VoiceAnswerFooter({ answer, options, act, cancelStatus, canSubmit }: {
  answer: DashboardVoiceAnswer; canSubmit: boolean; options?: PlanDecisionOption[]; cancelStatus?: "requested" | "failed"; act(action: "cancel" | "send-now"): Promise<void>;
}) {
  const now = useNow(true, 100, monotonicNow);
  const remaining = Math.min(answer.windowMs, Math.max(0, voiceCardDeadline(answer)! - now));
  const submitHint = cancelStatus ? "Cancellation is awaiting confirmation"
    : !canSubmit ? "Focus this question in this dashboard to submit here" : "Submit this voice answer before the countdown ends";
  const selected = answer.selections?.[0]?.selected[0];
  const alternate = selected ? options?.findIndex(option => option.id !== selected) : -1;
  return <div className="av-foot" role="status">
    <div className="vc-count"><i style={{ width: (answer.windowMs ? remaining / answer.windowMs * 100 : 0) + "%" }} /></div>
    <div className="av-foot-row"><VoiceIcon name="mic" /><span className="av-grow">{cancelStatus ? "Pending voice answer: " : answer.switched ? "Changed to " : "Voice answer: "}
      <b>{cancelStatus && !selected ? answer.text : answer.label}</b><span className="av-foot-sub">
        {remaining === 0 ? "waiting for confirmation" : <>submits in <b>{answer.provisionalDeadline ? "≤" : ""}{voiceCountdownSeconds(remaining, answer.windowMs)}s</b></>}
      </span></span>
      <Tooltip label={cancelStatus ? "Request cancellation again" : "Cancel this pending voice answer"}>
        <button className="btn btn-ghost" onClick={() => void act("cancel")}>{cancelStatus ? "Retry cancel" : "Cancel"}</button>
      </Tooltip>
      <Tooltip label={submitHint}>
        <button className="btn btn-approve" disabled={!canSubmit || !!cancelStatus || remaining === 0} onClick={() => void act("send-now")}>Submit now</button>
      </Tooltip></div>
    <span className="av-hint">{cancelStatus
      ? (cancelStatus === "failed" ? "Could not cancel the voice answer." : "Cancellation requested.")
      : <>Say <q>cancel</q> to stop{alternate != null && alternate >= 0 && <>, or <q>no, {optionLetter(alternate)}</q> to switch</>}.</>}</span>
  </div>;
}
