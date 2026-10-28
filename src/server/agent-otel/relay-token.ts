import { randomBytes, timingSafeEqual } from "node:crypto";

// The relay-only capability.
//
// Codex takes its exporter headers through `-c`, which is argv, which any process on the
// machine can read. The daemon token must never be there: it authorizes hooks, MCP and the
// ledger. This token authorizes posting arbitrary bodies to `/v1/{logs,metrics,traces}`
// for forwarding with the configured upstream headers; metrics never reach the local ledger. Minted per daemon process and
// never persisted: the app-server processes that carry it are children of this process.

/** The header a relay-token holder authenticates with. */
export const AGENT_OTEL_RELAY_HEADER = "x-mission-otel-relay";

const TOKEN = randomBytes(24).toString("hex");

export function agentOtelRelayToken(): string {
  return TOKEN;
}

export function checkAgentOtelRelayToken(provided: string | null | undefined): boolean {
  if (typeof provided !== "string") return false;
  // Byte lengths, not string lengths: a header with non-ASCII characters can match the
  // token's length in characters and still differ in bytes, and `timingSafeEqual` throws then.
  const given = Buffer.from(provided);
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
