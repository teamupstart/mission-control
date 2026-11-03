import type { TranscriptAdvisor } from "@shared/types.ts";
import { modelLabel } from "@shared/model.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The sentence an advisor call reads as in the conversation.
 *
 * Worded after Claude Code's own rendering of the same blocks, so a person who has seen the
 * TUI recognises it: a review, a refusal, or the CLI's "Advisor unavailable (<code>)".
 */
export function advisorNoteLabel(advisor: TranscriptAdvisor): string {
  if (advisor.outcome === "error") return `Advisor unavailable (${advisor.errorCode ?? "unknown"})`;
  if (advisor.outcome === "declined") return "Advisor declined to advise on this request";
  const model = modelLabel(advisor.model);
  return `${model ? `Advisor (${model})` : "Advisor"} reviewed the conversation`;
}

/**
 * One advisor call inside an assistant turn, in both conversation renderings.
 *
 * The advisor's own words sit behind a disclosure that starts closed: they are written for
 * the executor model, often run long, and the turn that follows already shows what Claude
 * did with them. A redacted result has no words to show, and an error is a single line.
 */
export function AdvisorNote({ advisor }: { advisor: TranscriptAdvisor }): React.JSX.Element {
  const label = advisorNoteLabel(advisor);
  const tone = advisor.outcome === "error" ? " advisor-note-error" : "";
  if (advisor.text) {
    return (
      <details className={`advisor-note${tone}`}>
        <Tooltip label="Show what the advisor told Claude">
          <summary>{label}</summary>
        </Tooltip>
        <div className="advisor-note-text">{advisor.text}</div>
      </details>
    );
  }
  return <p className={`advisor-note${tone}`}>{label}</p>;
}
