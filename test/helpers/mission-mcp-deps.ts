import type { MissionMcpDescriptor } from "../../src/server/mission-mcp.ts";

// A Mission Control MCP server that is registered and publishes what it is asked for.
//
// Every Claude and Codex launch now requires `request_input`, and a dispatch or SDK resume
// is refused unless the server's bundle actually publishes it - a real handshake against the
// built `dist/mcp/server.mjs`. A test that only means "the server is there" passes these
// deps instead, so it never depends on whether `npm run build` ran first (CI runs `npm test`
// before it does). A test that is ABOUT a missing or stale server passes its own.
//
// No runtime imports: safe to import statically above a file's state-dir setup.

export const MISSION_TEST_DESCRIPTOR: MissionMcpDescriptor = {
  serverName: "mission-control",
  command: "/usr/bin/node",
  args: ["/m.mjs"],
  env: {},
};

export const MISSION_TEST_MCP_DEPS = {
  missionMcpDescriptor: async (): Promise<MissionMcpDescriptor | null> => MISSION_TEST_DESCRIPTOR,
  verifyMissionMcpTools: async (): Promise<{ ok: true }> => ({ ok: true }),
};
