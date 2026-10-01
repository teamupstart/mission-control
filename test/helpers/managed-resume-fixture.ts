import { after, afterEach } from "node:test";
import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeMcpFixture } from "./mcp-fixture.ts";

/** Source-only tests build the guard into their fixture, never depend on dist/. */
export async function managedResumeFixture(home: string): Promise<void> {
  mkdirSync(home, { recursive: true });
  const { MISSION_MCP_TOOLS } = await import("../../src/server/mission-mcp.ts");
  const { managedResumeRoot, recheckManagedResumes } = await import("../../src/server/harness/resume.ts");
  const { revokeResumeLease } = await import("../../src/server/terminal/resume-lease.ts");
  const prior = { guard: process.env.MISSION_RESUME_GUARD, mcp: process.env.MISSION_MCP_SERVER };
  const guard = join(home, "resume-guard.mjs");
  await build({ entryPoints: ["src/server/terminal/resume-guard.ts"], outfile: guard, bundle: true,
    platform: "node", format: "esm", target: "node24", alias: { "@shared": "./src/shared" } });
  process.env.MISSION_RESUME_GUARD = guard;
  process.env.MISSION_MCP_SERVER = writeMcpFixture(join(home, "mcp.mjs"), MISSION_MCP_TOOLS);
  const root = managedResumeRoot();
  afterEach(() => { for (const status of recheckManagedResumes()) revokeResumeLease(status.lease); });
  after(() => {
    if (prior.guard === undefined) delete process.env.MISSION_RESUME_GUARD;
    else process.env.MISSION_RESUME_GUARD = prior.guard;
    if (prior.mcp === undefined) delete process.env.MISSION_MCP_SERVER;
    else process.env.MISSION_MCP_SERVER = prior.mcp;
    rmSync(root, { recursive: true, force: true });
  });
}
