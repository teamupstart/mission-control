import type { ThinkingLevel } from "@shared/types.ts";
import { EventStream } from "../../sdk/event-stream.ts";
import type { SdkSessionHandle, SdkTurn, SessionRequestAnswer } from "../types.ts";
import { PiUIBridge } from "./sdk-ui.ts";
import { classifyPiFailure } from "./sdk-errors.ts";

/**
 * Pi may ask before it has a runtime. Yield the same handle at that question boundary so
 * the supervisor can adopt and pump it. Ordinary launch failures still reject synchronously;
 * failures after an operator-visible question go through the shared exit/eviction event.
 */
export async function startPi(
  initialize: (out: EventStream, ui: PiUIBridge, signal: AbortSignal, own: (handle: SdkSessionHandle) => void) => Promise<SdkSessionHandle>,
): Promise<SdkSessionHandle> {
  const out = new EventStream();
  const abort = new AbortController();
  let questionShown!: () => void;
  const question = new Promise<void>((resolve) => { questionShown = resolve; });
  const ui = new PiUIBridge(
    (event) => { out.emit(event); if (event.kind === "request") questionShown(); },
    (activity) => out.emit({ kind: "state", state: "working", activity }),
  );
  let driver: SdkSessionHandle | undefined;
  let initialized = false;
  const ready = initialize(out, ui, abort.signal, (handle) => { driver = handle; })
    .then((handle) => { initialized = true; return handle; });
  // Always observe rejection, including one that occurs after launch yielded to a question.
  void ready.catch((error: unknown) => {
    ui.close();
    out.emit({ kind: "exited", reason: classifyPiFailure(error, null).message, resumable: false });
    out.end();
  });
  let stopping: Promise<void> | undefined;
  const requireReady = (): SdkSessionHandle => {
    if (abort.signal.aborted) throw new Error("this Pi session's driver has stopped");
    if (!driver || !initialized) throw new Error("Pi is still starting; answer its pending question first");
    return driver;
  };
  const handle: SdkSessionHandle = {
    events: out,
    send: async (turn: SdkTurn) => requireReady().send(turn),
    sendIfIdle: async (turn: SdkTurn) => {
      if (abort.signal.aborted) throw new Error("this Pi session's driver has stopped");
      return initialized && driver && !ui.waiting ? driver.sendIfIdle(turn) : null;
    },
    answer: async (id: string, answer: SessionRequestAnswer) => ui.answer(id, answer),
    interrupt: async () => { ui.cancel(); if (driver) await driver.interrupt(); },
    clearContext: async () => { ui.cancel(); await (await ready).clearContext?.(); },
    setPermissionMode: null,
    setEffort: async (effort: ThinkingLevel) => requireReady().setEffort!(effort),
    setModel: async (model: string) => requireReady().setModel!(model),
    stop: () => stopping ??= (async () => {
      abort.abort();
      ui.close();
      await driver?.stop();
      await ready.catch(() => null);
    })(),
  };
  await Promise.race([ready, question]);
  return handle;
}
