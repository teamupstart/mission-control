import { useCallback, useEffect, useRef } from "react";
import { api } from "./api.ts";

const HEARTBEAT_MS = 10_000;

/**
 * Report this tab's live composer state to the daemon without making the textarea
 * controlled. The daemon uses a lease, so this heartbeat is the only timer the browser
 * needs and a crashed tab cannot block Foreman forever.
 */
export function useComposerActivity(sessionId: string): {
  onFocus: () => void;
  onBlur: () => void;
  onInput: () => void;
} {
  const clientId = useRef(globalThis.crypto.randomUUID());
  const focused = useRef(false);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);

  const report = useCallback((isFocused: boolean, typed = false): void => {
    void api.reportComposerActivity(sessionId, clientId.current, isFocused, typed);
  }, [sessionId]);

  const stopHeartbeat = useCallback((): void => {
    if (heartbeat.current) clearInterval(heartbeat.current);
    heartbeat.current = null;
  }, []);

  const onFocus = useCallback((): void => {
    focused.current = true;
    report(true);
    stopHeartbeat();
    heartbeat.current = setInterval(() => report(true), HEARTBEAT_MS);
  }, [report, stopHeartbeat]);

  const onBlur = useCallback((): void => {
    focused.current = false;
    stopHeartbeat();
    report(false);
  }, [report, stopHeartbeat]);

  const onInput = useCallback((): void => {
    report(focused.current, true);
  }, [report]);

  useEffect(() => () => {
    stopHeartbeat();
    if (focused.current) report(false);
  }, [report, stopHeartbeat]);

  return { onFocus, onBlur, onInput };
}
