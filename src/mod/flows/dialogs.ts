import type { DispatchOption } from "@shared/dispatch-options.ts";
import type { HomeDispatchOptionsResponse } from "@shared/home-dispatch.ts";
import type { ModHost } from "../host.ts";

type Asker = Pick<ModHost, "ask">;
type Question = HomeDispatchOptionsResponse["questions"][number];

/** What the person did with one question, whatever its pages. */
export type Picked =
  | { kind: "pick"; value: string; label: string }
  /** Text typed under Other. */
  | { kind: "other"; text: string }
  | { kind: "dismissed" };

/** The consecutive pages the daemon built for one question, or none when it did not ask it. */
export function pagesOf(questions: readonly Question[], id: Question["id"]): Question[] {
  return questions.filter((question) => question.id === id);
}

/**
 * Shows a question's pages as the daemon built them, word for word and in its order (7.5, 7.11).
 * `More...` moves to the next page and anything else ends the question. The mod never reorders
 * or rewords an option.
 */
export async function askPages(host: Asker, pages: readonly Question[], session?: { live?: () => boolean }): Promise<Picked> {
  for (const page of pages) {
    const answer = await host.ask({
      header: page.header,
      question: page.question,
      options: page.options.map((option: DispatchOption) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    });
    if (answer.kind === "dismissed") return { kind: "dismissed" };
    if (answer.kind === "other") return { kind: "other", text: answer.text };
    const chosen = page.options.find((option) => option.label === answer.label);
    if (!chosen) return { kind: "dismissed" };
    // `More...` may be answered after the session ended: no further page is opened for a session that is gone.
    if (chosen.value === "more") {
      if (session?.live && !session.live()) return { kind: "dismissed" };
      continue;
    }
    return { kind: "pick", value: chosen.value, label: chosen.label };
  }
  return { kind: "dismissed" };
}

export const TEXT_CANCEL_LABEL = "Cancel";
export const TEXT_POINTER_LABEL = "Type it under Other";
/** Said before the question again when the person picked the pointer instead of typing. */
export const TEXT_POINTER_HINT = "Type your answer in the Other field below.";
/**
 * How many times one text question is shown in all. Picking the pointer asks again, so a person
 * who clicked it is not cancelled; the bound keeps a surface that answers on its own from looping.
 */
const TEXT_ASKS = 3;

/**
 * Asks for a line of text under the dialog's Other field. The dialog needs at least two choices, so
 * it offers Cancel and a pointer to the Other field. Picking the pointer is not an answer and not a
 * cancel: the question is asked again with a hint. `undefined` means the person cancelled, dismissed
 * the dialog, typed nothing, kept picking the pointer, or the session ended between asks.
 */
export async function askText(
  host: Asker,
  header: string,
  question: string,
  session?: { live?: () => boolean },
): Promise<string | undefined> {
  for (let asked = 0; asked < TEXT_ASKS; asked += 1) {
    // No second dialog for a session that ended under the first.
    if (asked > 0 && session?.live && !session.live()) return undefined;
    const answer = await host.ask({
      header,
      question: asked === 0 ? question : `${TEXT_POINTER_HINT} ${question}`,
      options: [{ label: TEXT_CANCEL_LABEL, description: "Do not dispatch" }, { label: TEXT_POINTER_LABEL }],
    });
    if (answer.kind === "other") return answer.text.trim() === "" ? undefined : answer.text;
    if (answer.kind !== "pick" || answer.label !== TEXT_POINTER_LABEL) return undefined;
  }
  return undefined;
}
