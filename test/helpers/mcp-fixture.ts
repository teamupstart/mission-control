import { readFileSync, writeFileSync } from "node:fs";

// A real stdio MCP server, for the guards that can only be checked by talking to one.
//
// `mission-mcp.ts` verifies a launch by running an actual `initialize` + `tools/list` against
// the bundle it is about to register, because every other guard in the daemon checks that the
// bundle EXISTS and none of them can see what is inside it - the gap that let a
// `dist/mcp/server.mjs` six days older than `submit_scout_artifacts` serve its other seven
// tools while a scout that had to call that one deadlocked with no error anywhere.
//
// Testing that guard means spawning something it can interrogate. Not `dist/mcp/server.mjs`:
// everything in `test/` runs against `src/` and must pass on a fresh checkout, so a case that
// needed `npm run build` would report a missing build as a broken guard. Not a mock either -
// the entire claim under test is that a REAL handshake happens, so a fake that returned tool
// names without a subprocess would assert nothing.
//
// So: the ~30 lines of MCP that a `tools/list` needs. Newline-delimited JSON-RPC on stdio,
// answering `initialize` and `tools/list` and ignoring everything else.

/**
 * Write a stdio MCP server publishing exactly `tools`, and return its path.
 *
 * Re-writing the same path with a different tool set is how a rebuild is simulated - the
 * verifier keys its cache on the file's identity on disk, so the new content is picked up
 * exactly as `npm run build` would be.
 */
export function writeMcpFixture(path: string, tools: readonly string[]): string {
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(`${path}.spawns`)}, "spawn\\n");
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        tools: ${JSON.stringify(tools.map((t) => ({ name: t, description: t, inputSchema: { type: "object" } })))},
      } });
    }
  }
});
`,
  );
  return path;
}

/**
 * How many times a fixture has actually been launched.
 *
 * The caching claim - one handshake per build rather than one per dispatch - checked by
 * observation rather than by timing, which would be a flake waiting to happen.
 */
export function mcpFixtureSpawns(path: string): number {
  try {
    return readFileSync(`${path}.spawns`, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
