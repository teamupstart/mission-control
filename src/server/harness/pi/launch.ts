import { randomUUID } from "node:crypto";

export interface PiLaunchPreparation {
  args: string[];
  sessionId: string;
}

export function preparePiLaunch(): PiLaunchPreparation {
  const sessionId = randomUUID();
  return { args: ["--session-id", sessionId], sessionId };
}
