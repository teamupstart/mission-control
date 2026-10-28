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
    const command = async (name: string, alpha?: boolean) => {
      const value = await (window as unknown as {binaryUpdateCommand(name: string, alpha?: boolean): Promise<UpdateSnapshot>}).binaryUpdateCommand(name, alpha);
      publish(value); return value;
    };
    Object.defineProperty(window, "missionDesktop", {value: {
      isDesktop: true, onOpenSettings: () => () => {},
      ...(binary ? {binaryInstallation: {getState: async () => ({action: null, destination: "/Applications/Mission Control.app", message: "This destination is already managed."})}} : {}),
      updates: {getState: () => command("state"), check: () => command("check"), apply: () => command("apply"),
        install: () => command("install"), cancel: () => command("cancel"), defer: () => command("defer"), setAlpha: (alpha: boolean) => command("alpha", alpha),
        onState: (listener: (value: UpdateSnapshot) => void) => {listeners.add(listener); return () => listeners.delete(listener);}},
    }});
  }, managedBinary);
  const unsubscribe = controller.subscribe(snapshot => {
    void page.evaluate(value => (window as unknown as {pushBinaryUpdate?(value: UpdateSnapshot): void}).pushBinaryUpdate?.(value), snapshot).catch(() => {});
  });
  await page.reload();
  return unsubscribe;
}
