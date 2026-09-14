/**
 * Types for the two things `observability.mjs` exports to TypeScript callers.
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
