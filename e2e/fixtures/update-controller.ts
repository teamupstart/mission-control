import type { Page } from "@playwright/test";
import type { UpdateController } from "../../src/main/updater.ts";
import type { UpdateSnapshot } from "../../src/shared/update.ts";

export async function connectUpdateController(page: Page, controller: UpdateController, managedBinary = false): Promise<() => void> {
  await page.exposeFunction("binaryUpdateCommand", async (command: string, alpha?: boolean) => {
    if (command === "check") await controller.check(true);
    if (command === "apply") await controller.apply();
    if (command === "install") await controller.install();
    if (command === "cancel") controller.cancel();
    if (command === "defer") controller.defer();
    if (command === "alpha") controller.setAlpha(alpha!);
    return controller.getSnapshot();
  });
  await page.addInitScript((binary: boolean) => {
    const listeners = new Set<(value: UpdateSnapshot) => void>();
    const publish = (value: UpdateSnapshot) => {for (const listener of listeners) listener(value);};
    Object.defineProperty(window, "pushBinaryUpdate", {value: publish});
    // The preload's dialog channel, so a controller's `dialogs` port can render the dashboard's
    // update dialog exactly as the app's main process does (see `pushUpdateDialog`).
    const dialogs = new Set<(request: unknown) => void>();
    Object.defineProperty(window, "pushUpdateDialog", {value: (request: unknown) => {for (const listener of dialogs) listener(request);}});
    const command = async (name: string, alpha?: boolean) => {
      const value = await (window as unknown as {binaryUpdateCommand(name: string, alpha?: boolean): Promise<UpdateSnapshot>}).binaryUpdateCommand(name, alpha);
      publish(value); return value;
    };
    Object.defineProperty(window, "missionDesktop", {value: {
      isDesktop: true, onOpenSettings: () => () => {},
      ...(binary ? {binaryInstallation: {getState: async () => ({action: null, destination: "/Applications/Mission Control.app", message: "This destination is already managed."})}} : {}),
      updates: {getState: () => command("state"), check: () => command("check"), apply: () => command("apply"),
        install: () => command("install"), cancel: () => command("cancel"), defer: () => command("defer"), setAlpha: (alpha: boolean) => command("alpha", alpha),
        onState: (listener: (value: UpdateSnapshot) => void) => {listeners.add(listener); return () => listeners.delete(listener);},
        onDialog: (listener: (request: unknown) => void) => {dialogs.add(listener); return () => dialogs.delete(listener);},
        receivedDialog: () => {}, answerDialog: () => {}},
    }});
  }, managedBinary);
  const unsubscribe = controller.subscribe(snapshot => {
    void page.evaluate(value => (window as unknown as {pushBinaryUpdate?(value: UpdateSnapshot): void}).pushBinaryUpdate?.(value), snapshot).catch(() => {});
  });
  await page.reload();
  return unsubscribe;
}

/** Show an update dialog request in the connected dashboard, as the main process would. */
export async function pushUpdateDialog(page: Page, request: unknown): Promise<void> {
  await page.evaluate(value => (window as unknown as {pushUpdateDialog(value: unknown): void}).pushUpdateDialog(value), request);
}
