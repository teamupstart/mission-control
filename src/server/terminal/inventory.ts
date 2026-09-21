/** A complete observation, or no trustworthy answer. Empty is confirmed absence. */
export type TerminalInventory<T> = T[] | null;

/** Adapters may fail or throw; neither observation authorizes resource cleanup. */
export async function readInventory<T>(read: () => Promise<TerminalInventory<T>>): Promise<TerminalInventory<T>> {
  try {
    return await read();
  } catch {
    return null;
  }
}
