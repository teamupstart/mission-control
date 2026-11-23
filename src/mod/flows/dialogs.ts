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
export async function askPages(host: Asker, pages: readonly Question[]): Promise<Picked> {
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
    if (chosen.value === "more") continue;
    return { kind: "pick", value: chosen.value, label: chosen.label };
  }
  return { kind: "dismissed" };
}

/**
 * Asks for a line of text under the dialog's Other field. A dialog needs choices, so the one
 * offered is Cancel, and anything typed is the answer. `undefined` means the person cancelled
 * or dismissed it.
 */
export async function askText(host: Asker, header: string, question: string): Promise<string | undefined> {
  const answer = await host.ask({
    header,
    question,
    options: [{ label: "Cancel", description: "Do not dispatch" }, { label: "Type it under Other" }],
  });
  if (answer.kind === "other") return answer.text.trim() === "" ? undefined : answer.text;
  return undefined;
}
