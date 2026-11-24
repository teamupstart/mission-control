import type { NotificationConstructorOptions } from "electron";
import { z } from "zod";
import { VOICE_CANCEL_WINDOW_SECONDS } from "../shared/voice.ts";

const noticeSchema = z.object({
  id: z.string().uuid(), title: z.string().max(256), body: z.string().max(32768),
  deadline: z.number().int(), scope: z.enum(["single", "both", "remaining"]).default("single"),
}).strict();

const actionLabels = {
  single: ["Cancel", "Send now"],
  both: ["Cancel both", "Send both now"],
  remaining: ["Cancel remaining", "Send remaining now"],
} as const;

type IpcSource = { sender: unknown; senderFrame: unknown };
type IpcListener = (event: IpcSource, input: unknown) => unknown;
type NoticeWindow = { webContents: { mainFrame: unknown }; isFocused(): boolean; show(): void };
function ownsMainFrame(event: IpcSource, owner: NoticeWindow | null): owner is NoticeWindow {
  return owner !== null && event.sender === owner.webContents && event.senderFrame != null && event.senderFrame === owner.webContents.mainFrame;
}
interface NoticeConstructor {
  new(options: NotificationConstructorOptions): {
    once(event: "action", listener: (event: { actionIndex?: number }, actionIndex?: number) => void): void;
    once(event: "click" | "close" | "failed", listener: () => void): void;
    show(): void;
    close(): void;
  };
  isSupported(): boolean;
}

/** The renderer owns the card. Return only an action on this still-open notice. */
export function registerVoiceCardNotifications(
  ipcMain: { on(channel: string, listener: IpcListener): void; handle(channel: string, listener: IpcListener): void },
  window: () => NoticeWindow | null,
  NativeNotification: NoticeConstructor,
): void {
  const dismiss = new Map<string, () => void>();
  ipcMain.on("mission:voice-card-dismiss", (event, id) => {
    if (typeof id === "string" && ownsMainFrame(event, window())) dismiss.get(id)?.();
  });
  ipcMain.handle("mission:voice-card-notice", (event, input: unknown) => {
    const owner = window();
    if (!ownsMainFrame(event, owner) || owner.isFocused() || !NativeNotification.isSupported()) return null;
    const parsed = noticeSchema.safeParse(input);
    if (!parsed.success) return null;
    const { id, title, body, deadline, scope } = parsed.data;
    const ms = Math.min(VOICE_CANCEL_WINDOW_SECONDS.max * 1000, deadline - Date.now());
    if (ms <= 0 || dismiss.has(id)) return null;
    return new Promise<"cancel" | "send-now" | null>(resolve => {
      const notice = new NativeNotification({ title, subtitle: "Say “cancel” to stop.", body, silent: true,
        actions: actionLabels[scope].map(text => ({ type: "button", text })) });
      const finish = (action: "cancel" | "send-now" | null) => {
        if (!dismiss.delete(id)) return;
        clearTimeout(timer);
        notice.close();
        resolve(Date.now() < deadline ? action : null);
      };
      const timer = setTimeout(() => finish(null), ms);
      dismiss.set(id, () => finish(null));
      notice.once("action", (event, actionIndex) => {
        const index = actionIndex ?? event.actionIndex;
        finish(index === 0 ? "cancel" : index === 1 ? "send-now" : null);
      });
      notice.once("click", () => { owner.show(); finish(null); });
      notice.once("close", () => finish(null));
      notice.once("failed", () => finish(null));
      notice.show();
    });
  });
}
