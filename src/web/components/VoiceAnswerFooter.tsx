import { hintExample } from "./AgentName.tsx";
import type { HintName } from "@shared/inbox.ts";
import { optionLetter, spokenOrdinal } from "@shared/voice-answers.ts";
import type { PlanDecision, PlanDecisionOption } from "@shared/types.ts";
import { type DashboardVoiceAnswer, voiceCardDeadline, voiceCountdownSeconds } from "../lib/voice-card-clock.ts";
import { useNow } from "../useNow.ts";
import { Tooltip } from "./Tooltip.tsx";
import { VoiceIcon } from "./VoiceCardView.tsx";

export function CardVoiceFoot({ children }: { children: React.ReactNode }) {
  return <div className="vh-foot"><VoiceIcon name="mic" /><span>{children}</span></div>;
}

export function QuestionVoiceHint({ name, decision }: { name?: HintName; decision?: PlanDecision }) {
  const count = decision?.options.length ?? 0;
  const addressed = name ?? "reply";
  const example = count > 1 && name ? "B" : "A";
  const prefix = name ? "Say " : "No spoken name: with this card open, say ";
  const option = hintExample(addressed, `{name}, option ${example}`);
  if (decision && !decision.allowOther) return <CardVoiceFoot>{prefix}{option} to select an option.</CardVoiceFoot>;
  return <CardVoiceFoot>
    {prefix}{count > 0 && <>{option}{name ? " to answer, or " : " or "}</>}
    {hintExample(addressed, name ? "{name}, my answer is …" : "{name}, …")}{name ? " to answer in your own words." : "."}
  </CardVoiceFoot>;
}

export function PlanVoiceHint({ address, decisions, answered, missing, refused }: {
  address: HintName; decisions: PlanDecision[]; answered: number; missing: number; refused: boolean;
}) {
  const submit = hintExample(address, "{name}, submit");
  const phrase = (index: number, letter: string) => "{name}, " + spokenOrdinal(index + 1) + " one " + letter;
  let hint;
  if (missing < 0) {
    hint = <>All {answered === 3 ? "three" : answered} answered. Say {submit}, or click Submit.</>;
  } else if (refused) {
    hint = <>Say {hintExample(address, phrase(missing, "A"))}{decisions[missing]!.options.length > 1 &&
      <> or {hintExample(address, phrase(missing, "B"))}</>}, then {submit}.</>;
  } else if (answered > 0) {
    hint = <>Filled in, not sent. Say {hintExample(address, phrase(missing, "A"))} for the {answered === decisions.length - 1 ? "last" : "next"} one.</>;
  } else {
    const first = phrase(0, decisions[0]!.options.length > 1 ? "B" : "A");
    hint = <>Say {hintExample(address, first + (decisions.length > 1 ? ", second one A" : ""))} to fill it in. Nothing is sent until you say {submit}.</>;
  }
  return <CardVoiceFoot>{hint}</CardVoiceFoot>;
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
