/**
 * One step of `mctl setup` and `mctl doctor` (spec 7.14). Each step file exports `id`,
 * `implemented` and `run`; the ordered list is in `index.ts`.
 */
export const SETUP_STEP_IDS = ["daemon", "flag", "mod", "agents", "codex", "doctor"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** What a step is run with. `live` is `mctl doctor --live`, the only run that spends tokens. */
export interface SetupStepOptions {
  live: boolean;
}

export interface SetupStepResult {
  id: SetupStepId;
  /** `skipped` is a stub that changed nothing; the runner never counts it as a failure. */
  status: "ok" | "skipped" | "failed";
  message: string;
}

export interface SetupStep {
  id: SetupStepId;
  /** False while the file is a stub; the owning phase sets it true by replacing the file. */
  implemented: boolean;
  run: (options: SetupStepOptions) => Promise<SetupStepResult>;
}

/** The result every stub returns: it changes nothing and says so. */
export function stubResult(id: SetupStepId, message: string): SetupStepResult {
  return { id, status: "skipped", message };
}
