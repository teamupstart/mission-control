// Types for the parts of `fake-claude.mjs` a TypeScript caller uses. Same pattern as
// `scripts/db-shell.d.mts` and `src/shared/harness-runtime.d.mts`: the module stays plain
// JavaScript (it is spawned as a bare executable, so it cannot be compiled), and this file
// is what lets `test/` import its pure helpers under `noImplicitAny`.
//
// Only the scenario matcher and the headless (`claude -p`) answers are declared. Everything else
// in that file is the session itself, which runs behind an `isMain` guard and is not importable
// behaviour.

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
  /**
   * The title of the scenario this one CONTINUES after a restart.
   *
   * Every restored session receives the same continuation prompt word for word, so a continuation
   * cannot be routed by its own text: it is routed by the work it belongs to. See
   * `selectContinuation`.
   */
  continues?: string;
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

/** The prefix of the prompt a restored session receives when its turn was cut short. */
export const CONTINUATION_MARKER: string;

/** The scenario declaring itself `original`'s continuation, or null when none does. */
export function continuationFor(
  scenarios: DemoScenario[],
  original: DemoScenario | null | undefined,
): DemoScenario | null;

/**
 * What a restored session plays for its continuation turn: the scenario that continues the work
 * `originalIntent` describes, else whatever `prompt` itself matches.
 */
export function selectContinuation(
  scenarios: DemoScenario[],
  originalIntent: string | null,
  prompt: string,
): DemoScenario;

/** The first human turn in a transcript this player wrote earlier, or null if it holds none. */
export function firstUserPrompt(lines: string[]): string | null;

/** Put this in a Persona's guidance and this player refuses that Persona's review. */
export const DEMO_FAIL_VERDICT_MARKER: string;

/** The reviewer's name, read from the first heading of the guidance a review prompt quotes. */
export function personaUnderReview(prompt: string | undefined | null): string;

/**
 * The `PersonaVerdict` this player answers one review with - a pass, unless the quoted guidance
 * carries `DEMO_FAIL_VERDICT_MARKER`. Declared as `unknown` on purpose: the test that matters
 * parses it with the daemon's own `parsePersonaVerdict`, which a pre-typed return would let it
 * skip.
 */
export function personaVerdict(prompt: string | undefined | null): unknown;

/**
 * The one-shot answer for a `claude -p` prompt: a Persona verdict, a compacted workflow intent, a
 * reconciled goal, a task title, or the matched scenario's title.
 */
export function headlessAnswer(prompt: string): string;

/**
 * The usage keys a finished turn's `result` frame carries, in the CLI's own shape - which is what
 * puts a demo card's spend in the ledger, since an OTLP row naming a driven session is dropped.
 *
 * Typed loosely on purpose: the test that matters reads it with the daemon's own
 * `claudeTurnUsage`, and a pre-typed return would let it skip that.
 */
export function turnUsage(): Record<string, unknown>;
