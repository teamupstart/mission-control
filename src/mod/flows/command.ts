import { HOME_DISPATCH_OFFERED_KINDS } from "@shared/dispatch-options.ts";
import type { TaskKind } from "@shared/types.ts";
import { LAUNCHER_ENABLED } from "../constants.ts";
import type { ModHost, ModPaneOpen } from "../host.ts";
import { PANE_WIDER_NOTICE, describeDraft, remindOrDropWaitingDraft, runDispatchFlow, type FlowResult } from "./dispatch.ts";
import type { FlowSession } from "./routes.ts";

/**
 * The `/mission-dispatch` command (spec 7.11) and the launcher (7.4). P11 owns this file.
 *
 * | Arguments                  | Does                                                              |
 * | none                       | Start, then the dispatch flow                                     |
 * | `{kind} {text}`            | The fast path: the dialogs start at After work                    |
 * | `inbox`                    | Opens the pane on Needs you                                       |
 * | `check`, `check {taskId}`  | Opens the pane on Tasks, or on that task's row                    |
 * | `pane`                     | Opens the pane as it was                                          |
 * | `{taskId}`                 | Opens the pane on that task, when the inbox lists it              |
 * | any text, a draft waiting  | The description, word for word                                    |
 * | any other text             | A brief: the dialogs start at Kind                                |
 *
 * A pane argument counts only when it is the whole argument, so `check the flaky logs` is a
 * brief (L20). The pane arguments call `paneOpen` with the tab or the task id and nothing else.
 */

export { PANE_WIDER_NOTICE };

type CommandHost = Pick<ModHost, "ask" | "notice" | "toast" | "fetch" | "fillPrompt" | "paneOpen" | "paneState">;

/** Whether a word names a kind the command offers (chat is never one). */
function kindNamed(word: string): TaskKind | null {
  const wanted = word.toLowerCase();
  return HOME_DISPATCH_OFFERED_KINDS.find((kind) => kind === wanted) ?? null;
}

async function listedTask(host: CommandHost, word: string): Promise<boolean> {
  const inbox = await host.paneState.get("inbox");
  return inbox?.items.some((item) => item.taskId === word) ?? false;
}

async function openPane(host: CommandHost, session: FlowSession, open: ModPaneOpen): Promise<FlowResult> {
  // A command whose session ended while it waited opens nothing.
  if (session.live && !session.live()) return { outcome: "cancelled", line: "cancelled" };
  const placed = await host.paneOpen({ ...open, focus: true, ...(session.live ? { guard: session.live } : {}) });
  // A session that ended while the open was in flight is also reported as not placed; it gets no
  // "wider window" line for a pane it no longer has.
  if (session.live && !session.live()) return { outcome: "cancelled", line: "cancelled" };
  // Opening the pane returns no text, or one line when it cannot be placed (7.11).
  if (!placed.isPlaced) host.notice(PANE_WIDER_NOTICE);
  return { outcome: "pane", line: "" };
}

export async function runDispatchCommand(host: CommandHost, session: FlowSession, args: string): Promise<FlowResult> {
  const text = args.trim();
  if (text === "") {
    // A blank command while a draft waits for its description does not silently abandon it.
    const waitingDraft = await host.paneState.get("draftId");
    if (waitingDraft) {
      const reminded = await remindOrDropWaitingDraft(host, session, waitingDraft);
      if (reminded) return reminded;
      // The drop path ends with the session gone: nothing starts over in a session that is not there.
      if (session.live && !session.live()) return { outcome: "cancelled", line: "cancelled" };
    }
    return runDispatchFlow(host, session, { entry: "first-message" });
  }

  // A draft waiting for its description takes the text word for word, even when it reads like a
  // pane argument or a task id: the person is describing a task, not asking for the pane.
  const waiting = await host.paneState.get("draftId");
  if (waiting) {
    // The raw argument: spaces the person typed around the description are theirs.
    const described = await describeDraft(host, session, waiting, args);
    if (described) return described;
  }

  const words = text.split(/\s+/);
  const first = words[0]!;
  const lowered = first.toLowerCase();
  if (words.length === 1) {
    if (lowered === "inbox") return openPane(host, session, { tab: "needs-you" });
    if (lowered === "check") return openPane(host, session, { tab: "tasks" });
    if (lowered === "pane") return openPane(host, session, {});
    if (await listedTask(host, first)) return openPane(host, session, { taskId: first });
  } else if (words.length === 2 && lowered === "check" && (await listedTask(host, words[1]!))) {
    return openPane(host, session, { taskId: words[1]! });
  }

  // The fast path: a kind and the description, so the dialogs start at After work.
  const kind = words.length > 1 ? kindNamed(first) : null;
  if (kind) {
    const rest = text.slice(first.length).trimStart();
    return runDispatchFlow(host, session, { entry: "command", kind, words: rest });
  }
  return runDispatchFlow(host, session, { entry: "command", words: text });
}

/**
 * The launcher: the Start dialog as a session opens. It runs only when the registration offers
 * it and `LAUNCHER_ENABLED` is on (spike S10 or S11 answered), so with the gate off the mod
 * never opens a dialog on its own.
 */
export async function runLauncher(
  host: CommandHost,
  session: FlowSession,
  registration: { offerLauncher: boolean },
  enabled: boolean = LAUNCHER_ENABLED,
): Promise<FlowResult | null> {
  if (!enabled || !registration.offerLauncher) return null;
  return runDispatchFlow(host, session, { entry: "first-message" });
}
