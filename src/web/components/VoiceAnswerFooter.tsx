import { optionLetter, type VoiceAnswer } from "@shared/voice-answers.ts";
import type { PlanDecisionOption } from "@shared/types.ts";
import { useNow } from "../useNow.ts";
import { VoiceIcon } from "./VoiceCardView.tsx";

export function CardVoiceFoot({ children }: { children: React.ReactNode }) {
  return <div className="vh-foot"><VoiceIcon name="mic" /><span>{children}</span></div>;
}

export function QuestionVoiceHint({ name, count }: { name?: string; count: number }) {
  const addressed = name ?? "reply";
  const example = count > 1 && name ? "B" : "A";
  return <CardVoiceFoot>
    {name ? "Say " : "No spoken name: with this card open, say "}
    {count > 0 && <><q>{addressed}, option {example}</q>{name ? " to answer, or " : " or "}</>}
    <q>{name ? name + ", answer: …" : "reply, …"}</q>{name ? " to answer in your own words." : "."}
  </CardVoiceFoot>;
}

export function VoiceAnswerFooter({ answer, options, act, cancelStatus }: {
  answer: VoiceAnswer; options?: PlanDecisionOption[]; cancelStatus?: "requested" | "failed"; act(action: "cancel" | "send-now"): Promise<void>;
}) {
  const now = useNow(true, 100);
  const remaining = Math.min(answer.windowMs, Math.max(0, answer.deadline - now));
  const selected = answer.selections?.[0]?.selected[0];
  const alternate = selected ? options?.findIndex(option => option.id !== selected) : -1;
  return <div className="av-foot" role="status">
    <div className="vc-count"><i style={{ width: (answer.windowMs ? remaining / answer.windowMs * 100 : 0) + "%" }} /></div>
    <div className="av-foot-row"><VoiceIcon name="mic" /><span className="av-grow">{cancelStatus ? "Pending voice answer: " : answer.switched ? "Changed to " : "Voice answer: "}
      <b>{cancelStatus && !selected ? answer.text : answer.label}</b><span className="av-foot-sub">
        {cancelStatus && remaining === 0 ? "waiting for confirmation" : <>submits in <b>{Math.ceil(remaining / 1000)}s</b></>}
      </span></span>
      <button className="btn btn-ghost" onClick={() => void act("cancel")}>{cancelStatus ? "Retry cancel" : "Cancel"}</button>
      <button className="btn btn-approve" disabled={!!cancelStatus} onClick={() => void act("send-now")}>Submit now</button></div>
    <span className="av-hint">{cancelStatus
      ? (cancelStatus === "failed" ? "Could not cancel the voice answer." : "Cancellation requested.")
      : <>Say <q>cancel</q> to stop{alternate != null && alternate >= 0 && <>, or <q>no, {optionLetter(alternate)}</q> to switch</>}.</>}</span>
  </div>;
}
