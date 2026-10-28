import { randomBytes, timingSafeEqual } from "node:crypto";

// The relay-only capability.
//
// Codex takes its exporter headers through `-c`, which is argv, which any process on the
// machine can read. The daemon token must never be there: it authorizes hooks, MCP and the
// ledger. This token authorizes exactly one thing, posting OTLP to `/v1/{logs,metrics,traces}`
// for forwarding, and metrics it carries never reach the ledger. Minted per daemon process and
// never persisted: the app-server processes that carry it are children of this process.

/** The header a relay-token holder authenticates with. */
export const AGENT_OTEL_RELAY_HEADER = "x-mission-otel-relay";

const TOKEN = randomBytes(24).toString("hex");

export function agentOtelRelayToken(): string {
  return TOKEN;
}

export function checkAgentOtelRelayToken(provided: string | null | undefined): boolean {
  if (typeof provided !== "string" || provided.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
}
