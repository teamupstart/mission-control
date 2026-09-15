/**
 * What a telemetry endpoint is allowed to be, and where a credential may travel.
 *
 * Shared rather than daemon-only, and that placement IS the rule: the Settings form and the
 * daemon's own validation must give the same answer, or an operator saves a configuration the
 * form accepted and the exporter then silently refuses - or, far worse, one the form warned
 * about and the exporter sent anyway. A second copy of these predicates is exactly how those
 * two come apart, so there is one.
 *
 * Pure. No `node:` imports, no fetch, no state - the browser imports it to decide what to show
 * under an input, and `src/server/telemetry/endpoint.ts` re-exports it for the transport
 * boundary that is still the final enforcement point.
 */

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

