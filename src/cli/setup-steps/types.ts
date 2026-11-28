/**
 * One step of `mctl setup` and `mctl doctor` (spec 7.14). Each step file exports `id`,
 * `implemented` and `run`; the ordered list is in `index.ts`.
 */
export const SETUP_STEP_IDS = ["daemon", "flag", "mod", "agents", "codex", "doctor"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** What a step is run with. `live` is `mctl doctor --live`, the only run that spends tokens. */
export interface SetupStepOptions {
  live: boolean;
  off?: boolean;
  /** What the step touches outside itself; tests inject fakes, the commands use the real ones. */
  deps?: Partial<import("./context.ts").SetupDeps>;
}

/** One line of `mctl doctor`: what was checked, whether it holds, and the fix when it does not. */
export interface DoctorCheck {
  name: string;
  /** `warn` is reported but never fails the run. */
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface SetupStepResult {
  id: SetupStepId;
  /** `skipped` is a stub that changed nothing; the runner never counts it as a failure. */
  status: "ok" | "skipped" | "failed";
  message: string;
  /** The checks behind a `doctor` result, one per line. */
  checks?: DoctorCheck[];
}

/** The phase that replaces a step's stub; the skeleton test pins it so no step is left unowned. */
export type SetupStepOwner = "P7" | "P14" | "P15";

export interface SetupStep {
  id: SetupStepId;
  owner: SetupStepOwner;
  /** False while the file is a stub; the owning phase sets it true by replacing the file. */
  implemented: boolean;
  run: (options: SetupStepOptions) => Promise<SetupStepResult>;
}

/** The result every stub returns: it changes nothing and says so. */
export function stubResult(id: SetupStepId, message: string): SetupStepResult {
  return { id, status: "skipped", message };
}
