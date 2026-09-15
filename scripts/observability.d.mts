/**
 * Types for the things `observability.mjs` exports to TypeScript callers.
 *
 * The script itself stays plain JavaScript because it is an operator-facing command that has
 * to run with bare `node` and no loader. The integration test imports it rather than restating
 * the host addresses, so that the test and the command an operator runs can never disagree
 * about which port the stack is on.
 */
export declare const ENDPOINTS: {
  readonly otlp: string;
  readonly collectorHealth: string;
  readonly prometheus: string;
  readonly tempo: string;
  readonly grafana: string;
  readonly dashboard: string;
};

export declare function waitUntilReady(
  timeoutMs?: number,
): Promise<{ ok: boolean; waiting: string[] }>;

/** Stop or start one component, leaving the rest running. */
export declare function composeService(
  action: "stop" | "start",
  service: "collector" | "prometheus" | "tempo" | "grafana",
): { ok: boolean; output: string };

/**
 * Exit with an explanation when docker itself could not be run.
 *
 * Exported so the branch can be covered without a machine that has no Docker: `spawnSync`
 * reports a missing or stopped Docker as `error` set and `status: null`, which a check reading
 * only the status exits on in silence.
 */
export declare function requireDocker(result: {
  error?: Error | null;
  status?: number | null;
}): void;
