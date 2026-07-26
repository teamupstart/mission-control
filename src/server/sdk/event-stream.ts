import type { SdkEvent } from "../harness/types.ts";

/**
 * The ordered mailbox every driver publishes its `SdkEvent`s through.
 *
 * Shared rather than per-adapter because it is the same problem in every one of them, and
 * it is not the interesting part: a driver's events do not all come from one place. Claude's
 * message loop produces most of them while `canUseTool` and its PR hooks are callbacks the
 * SDK invokes on its own schedule; Codex's frame pump produces most of them while an
 * approval answer resolves one from a route handler. A queue is what lets several writers
 * feed one ordered stream without either side blocking the other, and `SdkSupervisor.pump`
 * is the single reader on the far end.
 *
 * `emit` after `end` is DROPPED rather than thrown. Ending is what a driver does once it
 * has said `exited`, and a late event from a callback that had not unwound yet is not an
 * error - it is a fact about a session nobody is listening to any more.
 */
export class EventStream {
  private queued: SdkEvent[] = [];
  private waiting: ((m: IteratorResult<SdkEvent>) => void) | null = null;
  private ended = false;

  emit(evt: SdkEvent): void {
    if (this.ended) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: evt, done: false });
      return;
    }
    this.queued.push(evt);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SdkEvent> {
    for (;;) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      const message = await new Promise<IteratorResult<SdkEvent>>((resolve) => {
        this.waiting = resolve;
      });
      if (message.done) return;
      yield message.value;
    }
  }
}
