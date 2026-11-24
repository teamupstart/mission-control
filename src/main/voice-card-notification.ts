import type { EventEmitter } from "node:events";
import type { NotificationConstructorOptions } from "electron";
import { VOICE_CANCEL_WINDOW_SECONDS } from "../shared/voice.ts";
import { VoiceCardNoticeSchema, type VoiceCardNoticeResult } from "../shared/voice-routing.ts";

const actionLabels = {
  single: ["Cancel", "Send now"],
  both: ["Cancel both", "Send both now"],
  remaining: ["Cancel remaining", "Send remaining now"],
} as const;

type IpcSource = { sender: unknown; senderFrame: unknown };
type IpcListener = (event: IpcSource, input: unknown) => unknown;
type NoticeContents = Pick<EventEmitter, "on"> & { mainFrame: unknown };
type NoticeWindow = { webContents: NoticeContents; isFocused(): boolean; show(): void };
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
  const dismiss = new Map<string, { contents: NoticeContents; close(): void }>();
  const observed = new WeakSet<NoticeContents>();
  function watchPage(contents: NoticeContents) {
    if (observed.has(contents)) return;
    observed.add(contents);
    const closePageNotices = () => {
      for (const pending of dismiss.values()) if (pending.contents === contents) pending.close();
    };
    // did-navigate only fires for a committed main-frame document change, including reload.
    contents.on("did-navigate", closePageNotices);
    contents.on("render-process-gone", closePageNotices);
    contents.on("destroyed", closePageNotices);
  }
  ipcMain.on("mission:voice-card-dismiss", (event, id) => {
    const owner = window();
    if (typeof id !== "string" || !ownsMainFrame(event, owner)) return;
    const pending = dismiss.get(id);
    if (pending?.contents === owner.webContents) pending.close();
  });
  ipcMain.handle("mission:voice-card-notice", (event, input: unknown): VoiceCardNoticeResult | Promise<VoiceCardNoticeResult> => {
    const owner = window();
    if (!ownsMainFrame(event, owner) || !NativeNotification.isSupported()) return null;
    const parsed = VoiceCardNoticeSchema.safeParse(input);
    if (!parsed.success) return null;
    const { id, title, body, deadline, scope } = parsed.data;
    const ms = Math.min(VOICE_CANCEL_WINDOW_SECONDS.max * 1000, deadline - Date.now());
    if (ms <= 0 || dismiss.has(id)) return null;
    if (owner.isFocused()) return "window-focused";
    return new Promise<"cancel" | "send-now" | null>(resolve => {
      const notice = new NativeNotification({ title, subtitle: "Say “cancel” to stop.", body, silent: true,
        actions: actionLabels[scope].map(text => ({ type: "button", text })) });
      const finish = (action: "cancel" | "send-now" | null) => {
        if (dismiss.get(id) !== pending) return;
        dismiss.delete(id);
        clearTimeout(timer);
        notice.close();
        resolve(Date.now() < deadline ? action : null);
      };
      const timer = setTimeout(() => finish(null), ms);
      const pending = { contents: owner.webContents, close: () => finish(null) };
      dismiss.set(id, pending);
      watchPage(owner.webContents);
      notice.once("action", (event, actionIndex) => {
        const index = actionIndex ?? event.actionIndex;
        finish(index === 0 ? "cancel" : index === 1 ? "send-now" : null);
      });
      notice.once("click", () => { if (dismiss.get(id) === pending) owner.show(); finish(null); });
      notice.once("close", () => finish(null));
      notice.once("failed", () => finish(null));
      notice.show();
    });
  });
}
