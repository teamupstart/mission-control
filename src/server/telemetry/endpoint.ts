/**
 * What a telemetry endpoint is allowed to be, and where a credential may travel.
 *
 * The predicates themselves moved to `@shared/telemetry-endpoint.ts` when the Settings form
 * gained the same validation: Phase 1's reason for making them pure was that the form and the
 * exporter had to agree, and a browser cannot import from `src/server/`. They are re-exported
 * here so every existing daemon-side caller keeps its import, and this module keeps the parts
 * that are genuinely daemon-only - URL resolution, redirect policy and log labelling.
 */
import type { TelemetrySignal } from "@shared/telemetry.ts";

export {
  isLoopbackHost,
  validateEndpoint,
  type EndpointProblem,
  type EndpointValidation,
} from "@shared/telemetry-endpoint.ts";
import { isLoopbackHost } from "@shared/telemetry-endpoint.ts";

/** The per-signal URL, resolved once from the base. OTLP/HTTP's documented default paths. */
export function signalUrl(endpoint: string, signal: TelemetrySignal): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  return signal === "metrics" ? `${base}/v1/metrics` : `${base}/v1/traces`;
}

/**
 * Whether a credential may follow a redirect.
 *
 * Only when the redirect stays on the exact same origin AND that origin still satisfies the
 * transport rule. Anything else - a different host, a downgrade to plaintext, a cross-origin
 * hop - drops the credential, which in practice means the request is reissued without it and
 * usually refused. That refusal is the correct outcome: a redirect is not authorization to
 * hand a token to a destination the operator never configured.
 */
export function credentialSurvivesRedirect(from: string, to: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(from);
    b = new URL(to, from);
  } catch {
    return false;
  }
  if (a.origin !== b.origin) return false;
  if (b.protocol === "http:" && !isLoopbackHost(b.hostname)) return false;
  return true;
}

/**
 * A URL safe to put in an error message or a log line.
 *
 * Scheme, host, port and path only. Query strings are dropped wholesale rather than filtered,
 * because "which query parameters are secret" is not a question worth being wrong about once.
 */
export function safeEndpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable endpoint)";
  }
}
