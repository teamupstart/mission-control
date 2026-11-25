import * as tls from "node:tls";

/**
 * Add the operating system's certificate store to the roots every outbound TLS connection in this
 * process verifies against: `fetch`, `https`, and anything else that uses the default context.
 *
 * Behind a TLS-inspecting proxy (a corporate VPN) every remote server presents a certificate
 * signed by the proxy's root. That root is installed in the system store (the macOS keychain) and
 * nowhere in Node's bundled Mozilla set, so without this a voice model download from Hugging Face,
 * a Jira REST sweep and every other outbound request fail with `SELF_SIGNED_CERT_IN_CHAIN` while
 * `curl` on the same machine succeeds. `NODE_EXTRA_CA_CERTS` is no answer for most operators: a
 * daemon started from the Finder or a LaunchAgent never sees the login shell's environment.
 *
 * This is the in-process equivalent of `--use-system-ca`, which resident MCP launchers start with
 * (`RESIDENT_MCP_LAUNCHER_RUNTIME_FLAGS`). The daemon has too many launchers to rely on a flag:
 * Electron's utility process, the LaunchAgent, `make start`, `npm start` and the installed CLI.
 *
 * Roots are only added, never removed, and verification is never relaxed. The bundled set,
 * `NODE_EXTRA_CA_CERTS`, and the system store a `--use-system-ca` launch already added all stay.
 * Node 24.0 to 24.4 lack the API; there the daemon keeps Node's default roots, as before, and
 * says so once at startup, because a download through the proxy will still be refused.
 */
export function trustSystemCertificates(api: SystemTrustApi = tls): SystemTrustResult {
  if (typeof api.setDefaultCACertificates !== "function" || typeof api.getCACertificates !== "function") {
    console.warn(
      `[tls] the system certificate store was not added: Node ${process.versions.node} lacks tls.setDefaultCACertificates (24.5 or newer has it). ` +
        "Outbound requests trust only Node's own roots and NODE_EXTRA_CA_CERTS.",
    );
    return "unsupported";
  }
  try {
    const defaults = api.getCACertificates("default");
    const roots = new Set([...defaults, ...api.getCACertificates("system")]);
    api.setDefaultCACertificates([...roots]);
    console.log(`[tls] added ${roots.size - new Set(defaults).size} root(s) from the system certificate store`);
    return "trusted";
  } catch (error) {
    // An unreadable keychain must not stop the daemon: it starts with the roots it had.
    console.warn(`[tls] could not add the system certificate store: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

export type SystemTrustResult = "trusted" | "unsupported" | "failed";

/** The slice of `node:tls` this needs, so a test can stand in for it. */
export interface SystemTrustApi {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}
