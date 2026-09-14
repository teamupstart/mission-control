/**
 * What a telemetry endpoint is allowed to be, and where a credential may travel.
 *
 * Pure functions on purpose: Settings validation (Phase 2) and the exporter boundary must give
 * the same answer, and the only way to guarantee that is for both to call this. A rule enforced
 * at one of the two is a rule an operator can save past and then have silently applied - or
 * worse, not applied.
 */
import type { TelemetrySignal } from "@shared/telemetry.ts";

export type EndpointProblem =
  | "empty"
  | "unparseable"
  | "unsupported_scheme"
  | "credential_requires_https"
  | "has_credentials_in_url";

export interface EndpointValidation {
  ok: boolean;
  problem: EndpointProblem | null;
  /** Human-readable, safe to show and safe to log. Never echoes a credential. */
  detail: string;
  /** True when the host is a loopback address, which is what makes plain HTTP acceptable. */
  loopback: boolean;
  /** Set when the endpoint is allowed but weaker than it should be. */
  warning: string | null;
}

/** IPv4 loopback, IPv6 loopback and the names that resolve to them. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8 in full, not just 127.0.0.1: a Collector bound to 127.0.0.2 is as local as one
  // on .1, and refusing it would be a rule nobody could explain.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Validate a base endpoint URL for a destination that may or may not carry a credential.
 *
 * The credential rule is the sharp one: a bearer token on a plaintext connection to anywhere
 * but this machine is a credential on the wire, so it is refused at configuration time and
 * again before transmission. Loopback HTTP stays supported because that is what every local
 * Collector is, and requiring TLS there would make the documented reference stack unusable.
 */
export function validateEndpoint(
  endpoint: string,
  opts: { hasCredential: boolean },
): EndpointValidation {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) {
    return { ok: false, problem: "empty", detail: "No endpoint configured.", loopback: false, warning: null };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      problem: "unparseable",
      detail: "The endpoint is not a URL.",
      loopback: false,
      warning: null,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      problem: "unsupported_scheme",
      detail: `OTLP/HTTP needs http or https, not ${url.protocol.replace(":", "")}.`,
      loopback: false,
      warning: null,
    };
  }
  // A username or password in the URL would be logged by every proxy on the way and copied
  // into any diagnostic that prints the endpoint. The header is the supported carrier.
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      problem: "has_credentials_in_url",
      detail: "Put the credential in the header field, not in the URL.",
      loopback: false,
      warning: null,
    };
  }
  const loopback = isLoopbackHost(url.hostname);
  if (opts.hasCredential && url.protocol === "http:" && !loopback) {
    return {
      ok: false,
      problem: "credential_requires_https",
      detail: "A credential may only be sent over HTTPS, or to a loopback Collector.",
      loopback,
      warning: null,
    };
  }
  const warning =
    !loopback && url.protocol === "http:"
      ? "This endpoint is remote and unencrypted. HTTPS is strongly preferred."
      : null;
  return { ok: true, problem: null, detail: "", loopback, warning };
}

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
