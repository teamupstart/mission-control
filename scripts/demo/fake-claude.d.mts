// Types for the parts of `fake-claude.mjs` a TypeScript caller uses. Same pattern as
// `scripts/db-shell.d.mts` and `src/shared/harness-runtime.d.mts`: the module stays plain
// JavaScript (it is spawned as a bare executable, so it cannot be compiled), and this file
// is what lets `test/` import its pure helpers under `noImplicitAny`.
//
// Only the exported matcher is declared. Everything else in that file is the session itself,
// which runs behind an `isMain` guard and is not importable behaviour.

/** One step of a scenario. `kind` discriminates; the rest varies by kind. */
export interface DemoScenarioStep {
  kind: "assistant" | "tool" | "editFile" | "ask" | "result";
  text?: string;
  name?: string;
  input?: unknown;
  path?: string;
  content?: string;
  questions?: unknown[];
  delayMs?: number;
}

/** One `*.json` file under `MISSION_DEMO_SCENARIO_DIR`. */
export interface DemoScenario {
  title: string;
  /** Case-insensitive substrings matched against the dispatched intent. */
  match?: string[];
  /** Picked when nothing else matches. Exactly one scenario should set it. */
  default?: boolean;
  steps: DemoScenarioStep[];
}

/**
 * Every scenario in `dir` (default `MISSION_DEMO_SCENARIO_DIR`), filename-sorted, or the
 * built-in fallback when the directory is absent, unreadable, or holds nothing usable.
 */
export function loadScenarios(dir?: string): DemoScenario[];

/**
 * The scenario whose `match` substrings hit `prompt`, else the flagged default, else the
 * first. Never returns undefined for a non-empty table.
 */
export function selectScenario(
  scenarios: DemoScenario[],
  prompt: string | undefined | null,
): DemoScenario;
