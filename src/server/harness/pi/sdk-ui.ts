import { randomUUID } from "node:crypto";
import type { SessionRequest, SessionRequestAnswer, SdkEvent } from "../types.ts";
import { redact } from "./sdk-errors.ts";

export interface PiDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** The value-returning UI Pi can use without a terminal. Vendor types stop at sdk-deps. */
export interface PiHostUI {
  select(title: string, options: string[], opts?: PiDialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: PiDialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: PiDialogOptions): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  unsupported(method: string): void;
}

type Pending = {
  request: SessionRequest;
  finish(value: string | undefined): void;
};

/** One resolver per shared request id. Only the head is visible; every waiter is bounded. */
export class PiUIBridge implements PiHostUI {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private generation = 0;
  private suspended = false;
  private diagnosticAt = -Infinity;
  private readonly unsupportedMethods = new Set<string>();

  constructor(
    private readonly emit: (event: SdkEvent) => void,
    private diagnostic: (message: string) => void,
    private readonly defaultTimeout = 5 * 60_000,
  ) {}

  onDiagnostic(handler: (message: string) => void): void { this.diagnostic = handler; }

  get waiting(): boolean { return this.pending.size > 0; }

  select(title: string, options: string[], opts?: PiDialogOptions): Promise<string | undefined> {
    // Refuse values the shared wire cannot represent, instead of silently changing an answer.
    if (options.length === 0 || options.length > 99 || options.some((o) => !o || o.length > 500)) {
      this.notify("Pi selector has unsupported options", "warning");
      return Promise.resolve(undefined);
    }
    return this.ask(title, options, opts);
  }

  async confirm(title: string, message: string, opts?: PiDialogOptions): Promise<boolean> {
    return (await this.ask(`${title}\n\n${message}`, ["Yes", "No"], opts)) === "Yes";
  }

  input(title: string, placeholder?: string, opts?: PiDialogOptions): Promise<string | undefined> {
    return this.ask(title, [], opts, { multiline: false, placeholder });
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    if (prefill && prefill.length > 4000) {
      this.notify("Pi editor text exceeds the supported 4000 characters", "warning");
      return Promise.resolve(undefined);
    }
    return this.ask(title, [], undefined, { multiline: true, initialValue: prefill });
  }

  /** Trust is distinct from an extension question so automation cannot answer it as task input. */
  trust(cwd: string): Promise<string | undefined> {
    return this.ask(
      `Trust Pi project resources in ${cwd}?\n\nAllow Pi to load project settings, install project packages, and execute local extensions. Pi remembers this decision.`,
      ["Trust project", "Skip project resources"], undefined, undefined, "trust",
    );
  }

  private ask(
    prompt: string,
    labels: string[],
    opts?: PiDialogOptions,
    textInput?: { multiline: boolean; placeholder?: string; initialValue?: string },
    kind: SessionRequest["kind"] = "question",
  ): Promise<string | undefined> {
    if (this.closed || opts?.signal?.aborted) return Promise.resolve(undefined);
    if (!prompt || prompt.length > 4000 || this.pending.size >= 16) {
      this.notify("Pi question exceeds the supported size or pending limit", "warning");
      return Promise.resolve(undefined);
    }
    const id = randomUUID();
    const request: SessionRequest = {
      id, kind, prompt,
      options: labels.map((label, index) => ({ number: index + 1, label })),
      ...(textInput ? { questions: [{ question: prompt, options: [], multiSelect: false, textInput }] } : {}),
    };
    return new Promise((resolve) => {
      const finish = (value: string | undefined) => {
        const wasHead = this.pending.keys().next().value === id;
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", abort);
        if (wasHead) {
          this.emit({ kind: "request_resolved", requestId: id });
          const next = this.pending.values().next().value;
          if (next) this.emit({ kind: "request", request: next.request });
        }
        resolve(value);
      };
      const abort = () => finish(undefined);
      const timeout = opts?.timeout;
      const timer = setTimeout(() => {
        finish(undefined);
        this.notify("Pi question timed out and was cancelled", "warning");
      }, timeout !== undefined && Number.isFinite(timeout)
        ? Math.max(0, Math.min(timeout, this.defaultTimeout)) : this.defaultTimeout);
      timer.unref();
      this.pending.set(id, { request, finish });
      opts?.signal?.addEventListener("abort", abort, { once: true });
      if (this.pending.size === 1) this.emit({ kind: "request", request });
    });
  }

  answer(id: string, answer: SessionRequestAnswer): void {
    const held = this.pending.get(id);
    if (!held || this.pending.keys().next().value !== id) throw new Error("this Pi request is no longer pending");
    if (answer.kind === "option") {
      const option = held.request.options.find((o) => o.number === answer.number && o.label === answer.label);
      if (!option) throw new Error("this Pi request has no matching option");
      held.finish(option.label);
      return;
    }
    if (held.request.questions?.[0]?.textInput && answer.kind === "form" && answer.answers.length === 1) {
      const value = answer.answers[0]!;
      if (value.question === held.request.prompt && value.labels.length === 0 && typeof value.text === "string" && value.text.length <= 4000) {
        held.finish(value.text);
        return;
      }
    }
    throw new Error("this Pi request requires a matching answer");
  }

  /** Retired extensions can never open another question on a replacement conversation. */
  context(): PiHostUI {
    const generation = this.generation;
    const live = () => !this.closed && !this.suspended && generation === this.generation;
    return {
      select: (...args) => live() ? this.select(...args) : Promise.resolve(undefined),
      confirm: (...args) => live() ? this.confirm(...args) : Promise.resolve(false),
      input: (...args) => live() ? this.input(...args) : Promise.resolve(undefined),
      editor: (...args) => live() ? this.editor(...args) : Promise.resolve(undefined),
      notify: (...args) => { if (live()) this.notify(...args); },
      unsupported: (method) => { if (live()) this.unsupported(method); },
    };
  }

  suspend(): void { this.suspended = true; this.cancel(); }
  resume(): void { this.suspended = false; }

  invalidate(): void { this.generation += 1; this.cancel(); }

  cancel(): void {
    // Delete tail first so cancelling a session never flashes the next abandoned question.
    for (const held of [...this.pending.values()].reverse()) held.finish(undefined);
  }

  close(): void { this.closed = true; this.cancel(); }

  notify(message: string, type: "info" | "warning" | "error" = "info"): boolean {
    if (this.closed || Date.now() - this.diagnosticAt < 250) return false;
    this.diagnosticAt = Date.now();
    this.diagnostic(`Pi ${type}: ${redact(message).slice(0, 500)}`);
    return true;
  }

  unsupported(method: string): void {
    if (this.unsupportedMethods.has(method)) return;
    if (this.notify(`Extension UI ${method} is unavailable in managed sessions`, "warning")) {
      this.unsupportedMethods.add(method);
    }
  }
}
