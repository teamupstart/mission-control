import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import { z } from "zod";

/** The packaged daemon learns the shell's public key through its private parent port.
 * A request only reads the key already loaded by the shell's listener. */
const messageType = "mission:voice-shell-verifier";
const request = z.object({ type: z.literal(messageType), id: z.uuid() });
const reply = request.extend({ key: z.string().nullable() });

export function serveDesktopVoiceVerifier(child: UtilityProcess, publicKey: () => string | undefined) {
  child.on("message", (ask: unknown) => {
    const parsed = request.safeParse(ask);
    if (parsed.success) child.postMessage({ ...parsed.data, key: publicKey() ?? null });
  });
}

export function desktopVoiceVerifier(port = process.parentPort) {
  let pending: Promise<boolean> | undefined;
  return () => {
    if (!port || process.env.MISSION_VOICE_DESKTOP_VERIFIER !== "1" || process.env.MISSION_VOICE_SHELL_PUBLIC_KEY) return true;
    return pending ??= new Promise<boolean>(resolve => {
      const id = randomUUID();
      const finish = (received: boolean) => {
        clearTimeout(timer);
        port.off("message", receive);
        resolve(received);
      };
      const receive = ({ data }: { data: unknown }) => {
        const parsed = reply.safeParse(data);
        if (!parsed.success || parsed.data.id !== id) return;
        if (parsed.data.key) process.env.MISSION_VOICE_SHELL_PUBLIC_KEY ??= parsed.data.key;
        finish(true);
      };
      const timer = setTimeout(() => finish(false), 2000);
      port.on("message", receive);
      try { port.postMessage({ type: messageType, id }); } catch { finish(false); }
    }).finally(() => { pending = undefined; });
  };
}
