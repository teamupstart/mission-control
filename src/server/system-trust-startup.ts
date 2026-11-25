import { trustSystemCertificates } from "./system-trust.ts";

/**
 * Imported for its side effect, by the daemon's entry point only, directly after
 * `migrate-state.ts`. ES modules evaluate imports in source order, so the system certificate
 * store joins the default roots before any later import is evaluated and can open a TLS
 * connection. A call in the body of `index.ts` would run only after every import had.
 */
trustSystemCertificates();
