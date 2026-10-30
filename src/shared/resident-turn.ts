/** Durable wake identity. Append-only grammar; rendered separately from the agent's prompt. */
export function residentWakeMarker(runId: string, seq: number): string {
  return `[mission-resident:${runId}:${seq}]`;
}
export function residentWakeText(text: string): string | null {
  return /^\[mission-resident:[A-Za-z0-9-]+:\d+\]\n/.test(text)
    ? text.replace(/^\[mission-resident:[A-Za-z0-9-]+:\d+\]\n/, "") : null;
}
