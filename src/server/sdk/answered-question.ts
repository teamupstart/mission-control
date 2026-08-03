import type { PaneDialog, PlanDecision, PlanDecisionAnswer } from "@shared/types.ts";
import type { SessionRequestAnswer } from "../harness/types.ts";
import { decisionLead, formatResponse } from "@shared/review-item.ts";
import { titleLine } from "@shared/title.ts";

/**
 * Turning an answered driver QUESTION into the record the conversation replays.
 *
 * ## The gap this closes
 *
 * A session's questions reach the human down one of two channels, and until this existed
 * only one of them left a trace.
 *
 * A session we dispatch to a TERMINAL has Claude's built-in `AskUserQuestion` taken away
 * and calls `request_input` instead (`ask-channel.ts`), which is a review: a durable row
 * carrying the questions, the options and what was picked, which `ReviewAnswerCard` draws
 * back into the log in the human's voice.
 *
 * A session on the SDK runtime keeps the built-in, deliberately - the ask arrives through
 * `canUseTool` as a driver request, which IS the dashboard's own control, so the MCP
 * stand-in would be approximating something we already have natively (`claude/sdk.ts`).
 * But answering one only resolves the callback the agent is blocked on. No review row is
 * written, and the transcript cannot cover for it: the answer lands in the JSONL as a user
 * turn that is purely a `tool_result`, which every harness parser drops as machine noise
 * (`claude/transcript.ts`). So the log read: a grey `AskUserQuestion` chip, a silence, then
 * the agent acting on a decision that appeared from nowhere.
 *
 * Projecting the answer into the SAME review shape - rather than giving driver answers
 * their own table and their own card - is what keeps that from being two features. The
 * conversation already merges resolved reviews by `resolvedAt` and already knows not to put
 * Foreman's answers in the human's mouth (`isHumanResolvedReview`); a second record type
 * would need a second copy of both rules, and the two would drift.
 *
 * ## Why questions only
 *
 * `kind === "question"` is asserted, and the other four kinds are deliberately left alone.
 * A permission prompt is answered dozens of times an hour on an auto-mode session and
 * recording each one would bury the conversation in "you approved Bash" - and a `plan`,
 * `approval` or `trust` ask is a yes/no whose outcome the next turn states anyway. A
 * question is the one ask whose answer is CONTENT: it chose between things, and what it
 * passed over is unrecoverable from anywhere else.
 *
 * A pane dialog is excluded by the same test rather than by an extra one, because a screen
 * cannot classify itself - the parser sees a numbered block with a cursor on it and has no
 * way to know whether that is a permission prompt or a clarifying question, which is why
 * `kind` is absent for a pane (`PaneDialog.kind`). Recording those would mean guessing.
 */

/** The review fields an answered question produces. Everything else is the manager's. */
export interface AnsweredQuestion {
  /** Clipped for the conversation byline, the same way `request_input` clips its own. */
  title: string;
  /** The heading the human was shown above the questions. */
  body: string;
  decisions: PlanDecision[];
  selections: PlanDecisionAnswer[];
  /** The selections flattened, in the one spelling `/api/reviews/:id/resolve` also writes. */
  response: string;
}

/**
 * Ids are POSITIONAL - `q1`, `q1o2` - and not the question's or option's own text.
 *
 * The wire shape a driver form is answered with matches by label, because that is what the
 * human clicked; a stored review matches by id, because a label may be rewritten while the
 * answer stands. Minting ids here is the join between the two, and minting them from
 * position rather than from the text keeps them short, unique within the row, and safe to
 * use as a React key and inside an `aria-labelledby` - an agent-supplied string is none of
 * those things (`ReviewAnswer.tsx` documents the space-separated-token hazard).
 */
function decisionId(index: number): string {
  return `q${index + 1}`;
}

/**
 * The questions as decision points, with free text admitted on every one.
 *
 * `allowOther` is unconditional because the driver form genuinely offers it: `DriverForm`
 * puts a text box under every question, and `driverFormAnswer` accepts `text` in place of
 * labels for any of them. Setting it from anything narrower would make `formatResponse`
 * drop a typed answer as though the human had chosen nothing.
 */
function decisionsFor(dialog: PaneDialog): PlanDecision[] {
  const questions = dialog.questions ?? [];
  if (questions.length > 0) {
    return questions.map((q, i) => ({
      id: decisionId(i),
      question: q.question,
      options: q.options.map((o) => ({
        id: `${decisionId(i)}o${o.number}`,
        label: o.label,
        ...(o.detail ? { detail: o.detail } : {}),
      })),
      ...(q.multiSelect ? { multiSelect: true } : {}),
      allowOther: true,
    }));
  }
  // A single-ask question: one decision, headed by the prompt the rows answer. `questions`
  // is absent for these, so the rows are read off `options` where every other surface reads
  // them (`driverOptionAnswer` verifies against exactly this list).
  if (dialog.options.length === 0) return [];
  return [
    {
      id: decisionId(0),
      question: dialog.prompt ?? "",
      options: dialog.options.map((o) => ({
        id: `${decisionId(0)}o${o.number}`,
        label: o.label,
        ...(o.detail ? { detail: o.detail } : {}),
      })),
      allowOther: true,
    },
  ];
}

/** An empty answer for every decision, so a question passed over still replays as asked. */
function blankAnswers(decisions: PlanDecision[]): Map<string, PlanDecisionAnswer> {
  return new Map(decisions.map((d) => [d.id, { decisionId: d.id, selected: [], other: null }]));
}

/**
 * Project an answered driver question into review fields, or null when there is nothing
 * worth recording.
 *
 * Null is returned rather than a half-filled record for every case the caller must not
 * write: a dialog that is not a driver question, a request with no rows to have chosen
 * between, and an answer shape that cannot name what was picked. A record that could not
 * say what was chosen would put an empty gold card in the log where a decision belongs -
 * worse than the silence it replaces, because it looks like an answer.
 */
export function answeredQuestion(
  dialog: PaneDialog | null | undefined,
  answer: SessionRequestAnswer,
): AnsweredQuestion | null {
  if (!dialog || dialog.source !== "driver" || dialog.kind !== "question") return null;
  const decisions = decisionsFor(dialog);
  if (decisions.length === 0) return null;

  const byId = blankAnswers(decisions);
  switch (answer.kind) {
    case "form": {
      for (const one of answer.answers) {
        const decision = decisions.find((d) => d.question === one.question);
        // Already refused upstream by `driverFormAnswer`, which will not deliver an answer
        // naming a question the request does not carry. Skipped rather than failing the
        // whole record: the answer has ALREADY reached the agent by the time this runs, so
        // the only thing left to decide is how much of it the log can honestly show.
        if (!decision) continue;
        const stored = byId.get(decision.id)!;
        stored.selected = decision.options
          .filter((o) => one.labels.includes(o.label))
          .map((o) => o.id);
        stored.other = one.text?.trim() ? one.text.trim() : null;
      }
      break;
    }
    case "option": {
      // A single ask, so there is exactly one decision to hang it on. Matched on the label
      // rather than the number for the same reason `optionRowMiss` verifies it: the number
      // is a position on a list that may have been re-read since.
      const decision = decisions[0]!;
      const stored = byId.get(decision.id)!;
      const picked = decision.options.find((o) => o.label === answer.label);
      if (!picked) return null;
      stored.selected = [picked.id];
      break;
    }
    // Prose. It never reaches this seam - `answerDriverRequest` is fed only by
    // `/select-option` and `/submit-options`, which project `option` and `form` - and it
    // carries no way to say WHICH question it answers, so a record built from one would
    // have to guess. Listed rather than defaulted so a fourth answer shape is a type error
    // here instead of a silent omission.
    case "text":
      return null;
  }

  const selections = decisions.map((d) => byId.get(d.id)!);
  // Nothing was matched: an answer that named no option and typed no text has no content to
  // replay, and drawing the form with every row unmarked would misreport it as a dismissal.
  if (selections.every((s) => s.selected.length === 0 && !s.other)) return null;

  const body = dialog.prompt ?? decisions[0]!.question;
  return {
    title: titleLine(body),
    body,
    decisions,
    selections,
    response: formatResponse(decisions, selections, decisionLead("input")),
  };
}
