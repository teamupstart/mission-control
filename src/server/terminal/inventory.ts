import type { TerminalBackendId } from "@shared/terminal.ts";

/** A complete observation, or no trustworthy answer. Empty is confirmed absence. */
export type TerminalInventory<T> = T[] | null;

const lastFailureLog = new Map<TerminalBackendId, number>();
const FAILURE_LOG_INTERVAL_MS = 60_000;

/** Adapters may fail or throw; neither observation authorizes resource cleanup. */
export async function readInventory<T>(backend: TerminalBackendId, read: () => Promise<TerminalInventory<T>>): Promise<TerminalInventory<T>> {
  try {
    return await read();
  } catch (error) {
    const now = Date.now();
    const last = lastFailureLog.get(backend);
    if (last === undefined || now - last >= FAILURE_LOG_INTERVAL_MS) {
      lastFailureLog.set(backend, now);
      console.error(`[terminal] ${backend} inventory failed:`, error);
    }
    return null;
  }
}
