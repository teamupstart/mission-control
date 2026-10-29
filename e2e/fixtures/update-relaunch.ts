import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { UpdateController, type UpdaterPort } from "../../src/main/updater.ts";
import { UpdateDialogPresenter } from "../../src/main/update-dialog.ts";
import { clearUpdateOutcome, readSettledUpdateOutcome, updateOutcomePath } from "../../src/main/update-outcome.ts";
import { UPDATE_DIALOGS, type UpdateDialogRequest } from "../../src/shared/update-dialog.ts";

/** Real outcome store, controller and presenter, replacing only the Electron IPC transport. */
export async function updateOutcomeHost(page: Page, directory: string) {
  const messages: string[] = [];
  const presenter = new UpdateDialogPresenter({
    canPresent: () => true, reveal: () => {}, newId: randomUUID,
    send: (request) => {
      void page.evaluate((value) => {
        (window as unknown as { deliverUpdate(request: UpdateDialogRequest): void }).deliverUpdate(value);
      }, request);
      return true;
    },
    log: (message) => messages.push(message),
    delay: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
  });
  await page.exposeFunction("updateHostReady", () => presenter.attach());
  await page.exposeFunction("updateHostReceived", (id: string) => presenter.received(id));
  await page.exposeFunction("updateHostAnswer", (id: string, choice: string) => presenter.answer(id, choice));
  await page.addInitScript(() => {
    const host = window as unknown as {
      updateHostReady(): Promise<void>;
      updateHostReceived(id: string): Promise<void>;
      updateHostAnswer(id: string, choice: string): Promise<void>;
    };
    const listeners = new Set<(request: UpdateDialogRequest) => void>();
    Object.defineProperty(window, "deliverUpdate", {value: (request: UpdateDialogRequest) => {
      for (const listener of listeners) listener(request);
    }});
    Object.defineProperty(window, "missionDesktop", {value: {
      isDesktop: true, onOpenSettings: () => () => {}, updates: {
        getState: async () => null, onState: () => () => {},
        onDialog: (listener: (request: UpdateDialogRequest) => void) => {
          listeners.add(listener); void host.updateHostReady();
          return () => listeners.delete(listener);
        },
        receivedDialog: (id: string) => { void host.updateHostReceived(id); },
        answerDialog: (id: string, choice: string) => { void host.updateHostAnswer(id, choice); },
      },
    }});
  });
  const unexpected = (): never => { throw new Error("An outcome-only launch must not install or contact a provider"); };
  const port: UpdaterPort = {
    packaged: true, arch: "x64", // outcome still appears, background update checks stay disabled
    currentVersion: () => "1.26.0", currentCommit: () => null,
    readSnoozes: () => ({}), writeSnoozes: () => {},
    readAlpha: () => false, writeAlpha: unexpected,
    installSnapshot: unexpected, latestRelease: unexpected, latestMainCommit: unexpected,
    runtime: unexpected, stage: unexpected, stagedBundleIdentity: unexpected,
    handoff: unexpected, requestQuit: unexpected, launchPreflight: unexpected,
    helperSource: () => "", stateDirectory: () => directory,
    readOutcome: () => readSettledUpdateOutcome(directory),
    clearOutcome: (expected) => clearUpdateOutcome(updateOutcomePath(directory), expected),
    now: Date.now, random: () => 0, log: (message) => messages.push(message),
    dialogs: {
      available: unexpected, ready: unexpected, upToDate: unexpected, preparing: unexpected,
      applying: unexpected, error: unexpected,
      outcome: async (outcome, delivery) => { await presenter.present(UPDATE_DIALOGS.outcome(outcome), delivery); },
    },
  };
  let controller: UpdateController | null = null;
  let pending: Promise<void> = Promise.resolve();
  return {
    messages,
    async launch() {
      presenter.detach();
      await pending;
      controller?.stop();
      await page.reload();
      controller = new UpdateController(port);
      pending = controller.start();
    },
    async stop() { presenter.detach(); await pending; controller?.stop(); },
  };
}
