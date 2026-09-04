export type UpdatePrepareStage =
  | "starting"
  | "prerequisites"
  | "source"
  | "release"
  | "checkout"
  | "dependencies"
  | "build"
  | "verify";

export interface UpdatePrepareStageEntry {
  id: UpdatePrepareStage;
  label: string;
  /** Where the bar sits while this stage runs, from 0 to 1. */
  fraction: number;
}

export interface UpdatePrepareProgress {
  label: string;
  fraction: number;
  step: number;
  steps: number;
  percent: number;
}

export type UpdateProgressLine =
  | { kind: "stage"; stage: string }
  | { kind: "staged"; version: string; bundlePath: string };

export const UPDATE_PREPARE_STAGES: readonly UpdatePrepareStageEntry[];
export const UPDATE_PROGRESS_MARKER: string;
export const UPDATE_STAGED_MARKER: string;
export function isUpdatePrepareStage(value: unknown): value is UpdatePrepareStage;
export function updatePrepareProgress(stage: string): UpdatePrepareProgress;
export function parseUpdateProgressLine(line: string): UpdateProgressLine | null;
