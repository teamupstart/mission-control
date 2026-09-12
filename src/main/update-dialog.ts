// Routing an update question to the dashboard.
//
// Every one of the updater's seven conversations is a Mission Control modal, drawn by the
// renderer. There is deliberately NO platform message box left in this path: a
// `dialog.showMessageBox` sheet is a second, unthemed auto-update surface, which is exactly
// what this change exists to remove. A question the dashboard cannot take is therefore not
// re-asked somewhere greyer - it settles as its own dismissal, which is the same answer as
// pressing "Later", and the updater carries on exactly as it does for a deferred question.
// The snapshot it publishes still reaches the dashboard banner, so the state is not lost.

import type {
  UpdateDialogChoice,
  UpdateDialogContent,
  UpdateDialogRequest,
} from "../shared/update-dialog.ts";
import { updateDialogDismissal } from "../shared/update-dialog.ts";

/**
 * How long a question waits for the dashboard before settling as a dismissal.
 *
 * Generous rather than snappy, and deliberately so. The only moments the dashboard is not
 * already mounted are a cold launch and a window being recreated, both of which mean the
 * renderer is loading right now - `window.ts` retries the load for up to fifteen seconds
 * against a daemon that may itself still be starting. Timing out early there would drop the
 * one question a fresh install asks ("did the update work?"). Nothing is blocked while it
 * waits except the update conversation itself.
 */
export const UPDATE_DIALOG_HOST_TIMEOUT_MS = 20_000;

export interface UpdateDialogPort {
  /** Is there a loaded, visible dashboard that can draw a modal right now? */
  canPresent(): boolean;
  /**
   * Reveal the dashboard. Called only when `canPresent()` is false - see `present`.
   */
  reveal(): void;
  /** Push one request at the renderer. False when it could not be delivered at all. */
  send(request: UpdateDialogRequest): boolean;
  /** A fresh id per dialog, so an answer names the question it is answering. */
  newId(): string;
  /** Schedule `fn`; returns its cancel. Injected so a test needs no real clock. */
  delay(ms: number, fn: () => void): () => void;
}

interface Pending {
  id: string;
  content: UpdateDialogContent;
  settle(choice: UpdateDialogChoice): void;
}

export class UpdateDialogPresenter {
  /** A renderer has announced it can draw these. */
  private hosted = false;
  private readonly waiting = new Set<() => void>();
  /**
   * Every question still awaiting an answer, by id.
   *
   * A map rather than a single slot because more than one can legitimately be open: the
   * outcome notice fires seconds after launch, and a manual check started from the menu bar
   * while it is still up is a second conversation, not a replacement for the first. Each
   * `present()` holds its own promise, and an answer reaches it by id alone - so the order
   * they are answered in has nothing to do with the order they were asked in.
   */
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly port: UpdateDialogPort,
    private readonly hostTimeoutMs: number = UPDATE_DIALOG_HOST_TIMEOUT_MS,
  ) {}

  /**
   * The dashboard mounted its update-dialog layer.
   *
   * Re-offers everything still unanswered, which is what makes a reload survivable: the
   * renderer loses whatever was on screen, and main is the only side that still knows a
   * question is outstanding.
   */
  attach(): void {
    this.hosted = true;
    const waking = [...this.waiting];
    this.waiting.clear();
    for (const wake of waking) wake();
    for (const entry of this.pending.values()) this.port.send({ ...entry.content, id: entry.id });
  }

  /**
   * The renderer went away for good, so nothing can answer what it was holding.
   *
   * Settling matters more than what it settles to: `checkForUpdates()` awaits these, and an
   * answer that never arrives leaves the command's promise - and the update itself - wedged
   * for the life of the process.
   */
  detach(): void {
    this.hosted = false;
    const outstanding = [...this.pending.values()];
    this.pending.clear();
    for (const entry of outstanding) entry.settle(updateDialogDismissal(entry.content).choice);
  }

  /** An answer came back from the dashboard. Unknown ids are ignored, not guessed at. */
  answer(id: unknown, choice: unknown): void {
    if (typeof id !== "string") return;
    if (choice !== "confirm" && choice !== "dismiss") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.settle(choice);
  }

  /** How many questions are still awaiting an answer. */
  get outstanding(): number {
    return this.pending.size;
  }

  async present(content: UpdateDialogContent): Promise<UpdateDialogChoice> {
    // Nothing is revealed while the dashboard is already up, so a person with the window
    // open sees exactly the flow they saw before: `preparing` reveals, an accepted
    // `available` reveals, and no other question moves the window. This is not a new
    // decision about when to show the window - it is the one thing that stands in for the
    // parentless `dialog.showMessageBox` this change deleted. That sheet was how a question
    // reached someone whose window was hidden; with no sheet left anywhere, and no second
    // unthemed surface wanted, showing the window is what keeps that person asked at all.
    if (!this.port.canPresent()) this.port.reveal();
    if (!this.hosted && !(await this.waitForHost())) return updateDialogDismissal(content).choice;
    const id = this.port.newId();
    if (!this.port.send({ ...content, id })) return updateDialogDismissal(content).choice;
    return new Promise<UpdateDialogChoice>((settle) => {
      this.pending.set(id, { id, content, settle });
    });
  }

  private waitForHost(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const wake = (): void => {
        this.waiting.delete(wake);
        cancel();
        resolve(true);
      };
      const cancel = this.port.delay(this.hostTimeoutMs, () => {
        this.waiting.delete(wake);
        resolve(false);
      });
      this.waiting.add(wake);
    });
  }
}
