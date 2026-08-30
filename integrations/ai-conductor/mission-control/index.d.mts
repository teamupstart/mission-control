// Types for `index.mjs`, hand-written beside it - the same split
// `src/shared/harness-runtime.d.mts` makes, and for the same reason.
//
// The implementation is plain ESM JavaScript because this directory is COPIED into another
// program's plugin home and has to run exactly as it sits here, under whatever loader that
// program was started with. This file is what lets Mission Control's own suite import it
// under `tsc --noEmit` and hold it to a contract anyway.

/** One run, addressed the way conductor addresses one: a repository, a worktree, a slug. */
export interface MissionControlRun {
  repo: string;
  worktree: string;
  slug: string;
}

/**
 * The implementation-run event kinds this build subscribes to are frozen at ai-conductor
 * 0.104.0 (`1631544a`); the additive Engineer kinds are frozen at Phase 1 (`8685e121`).
 *
 * Enumerated because conductor's event bus has no wildcard subscription.
 */
export declare const FORWARDED_EVENT_TYPES: readonly string[];

/**
 * Which run an event belongs to, resolved from the process rather than from the event.
 *
 * Exported for the tests: conductor's `VisualizerPlugin.start(emitter)` passes no run
 * identity and a `ConductorEvent` carries none, so this resolution is the part of the plugin
 * most likely to be wrong on a machine nobody tested.
 */
export declare function resolveRun(
  env: Record<string, string | undefined>,
  cwd: string,
  event?: Record<string, unknown> | null,
): MissionControlRun | null;

export interface MissionControlEngineerEnvelope {
  repo: string;
  seq: number;
  event: Record<string, unknown>;
  engineerRunId: string;
  correlationId: string | null;
  engineerAttempt: number;
  attemptKey: string;
}

/** Additive Engineer identity that never invents an implementation slug or worktree. */
export declare function engineerEnvelope(
  event?: Record<string, unknown> | null,
): MissionControlEngineerEnvelope | null;

/** How a caller may override what the plugin would otherwise resolve for itself. */
export interface MissionControlVisualizerOptions {
  /** Pin one run, removing the guessing in `resolveRun`. `<repo>/.worktrees/<slug>`. */
  worktree?: string;
  /** The daemon to post to. Defaults to `MISSION_CONTROL_URL`, then loopback. */
  url?: string;
  /** The shared secret. Defaults to `MISSION_CONTROL_TOKEN`, then the daemon's token file. */
  token?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/** What this instance has seen. For the tests, and for a support question. */
export interface MissionControlVisualizerStats {
  buffered: number;
  dropped: number;
  warnings: number;
}

/**
 * conductor's `VisualizerPlugin`, as this plugin implements it.
 *
 * Structural rather than imported: this package must not depend on conductor's TypeScript,
 * which is not published and is not present in the directory this is copied into.
 */
export interface MissionControlVisualizer {
  readonly name: string;
  start(emitter: {
    on(type: string, handler: (event: Record<string, unknown>) => void): void;
    off?(type: string, handler: (event: Record<string, unknown>) => void): void;
  }): void;
  stop(): Promise<void>;
  stats(): MissionControlVisualizerStats;
}

export declare function createMissionControlVisualizer(
  options?: MissionControlVisualizerOptions,
): MissionControlVisualizer;

declare const plugin: MissionControlVisualizer;
export default plugin;
