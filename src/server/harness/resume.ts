import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@shared/types.ts";
import { agentSubprocessEnv, dropPaneIdentityEnv } from "../agent-subprocess-env.ts";
import { STATE_DIR, resumeGuardPath } from "../config.ts";
import { missionToolsAvailability } from "../mission-tools.ts";
import { MISSION_MCP_TOOLS, missionMcpDescriptor, resolveMissionMcpRuntime, verifyMissionMcpTools,
  type MissionMcpDescriptor, type MissionMcpTool } from "../mission-mcp.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { shellCommand } from "../terminal/shell.ts";
import { run } from "../util/exec.ts";
import { LAUNCH_SCRIPT_FILE } from "../terminal/launch-process.ts";
import { beginResumeLaunch, createResumeLease, reconcileResumeLeases, resumeLeaseRoot,
  revokeResumeLease, writeResumeRecord, type ResumeLease } from "../terminal/resume-lease.ts";
import { harnessFor, resumeArgvFor } from "./index.ts";

export interface ResumeContext {
  managed: boolean;
  requiredTools: readonly MissionMcpTool[];
  extraDirs: readonly string[];
}
export interface PreparedResume {
  cwd: string;
  argv: string[];
  wrappedArgv: string[];
  stateHome: string;
  lease: ResumeLease;
  requiredTools: readonly MissionMcpTool[];
  descriptor: MissionMcpDescriptor | null;
  instrumented: boolean;
  beginLaunch(): void;
  dispose(): boolean;
}
const preparing = new Set<string>();

export function managedResumeRoot(): string {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  return resumeLeaseRoot(STATE_DIR);
}

export function recheckManagedResumes() {
  return reconcileResumeLeases(managedResumeRoot(), Date.now(), preparing);
}

export function resumeConversation(session: Pick<Session, "agent" | "agentSessionId">): string {
  return `${session.agent}:${session.agentSessionId}`;
}

/** All fallible provisioning, including the final wrapper, precedes SDK stop. */
export async function prepareTerminalResume(session: Session, context: ResumeContext): Promise<PreparedResume> {
  if (!session.cwd || !session.agentSessionId) throw new Error("this conversation has no checkout or native identity to resume");
  const argv = await resumeArgvFor(session.agent, session.agentSessionId, session.permissionMode);
  if (!argv) throw new Error(`${session.agent} cannot reopen a conversation`);
  const guard = resumeGuardPath();
  if (!existsSync(guard)) throw new Error("Mission Control's managed resume guard is not built - run: npm run build");
  const runtime = await resolveMissionMcpRuntime(process.execPath);
  const guardCheck = await run(runtime.command, [guard, "--check"], { env: runtime.env, timeoutMs: 5_000 });
  if (guardCheck.code !== 0 || guardCheck.stdout.trim() !== "mission-resume-guard-v1") {
    throw new Error("Mission Control's managed resume guard is unusable - run: npm run build");
  }
  const lease = createResumeLease(managedResumeRoot(), resumeConversation(session), preparing, session.id);
  const dispose = () => { preparing.delete(lease.id); return revokeResumeLease(lease); };
  try {
    const harness = harnessFor(session.agent);
    // SDK launch history has no durable subset ledger. Preserve the complete vocabulary.
    const requiredTools = [...new Set([...context.requiredTools,
      ...(session.runtime === "sdk" ? MISSION_MCP_TOOLS : [])])];
    const needsTools = context.managed || requiredTools.length > 0;
    if (needsTools && requiredTools.length === 0) requiredTools.push(...MISSION_MCP_TOOLS);
    let descriptor: MissionMcpDescriptor | null = null;
    let instrumented = false;
    if (needsTools) {
      const available = await missionToolsAvailability(session.agent);
      if (!available.available) throw new Error(available.reason ?? "Mission tools are unavailable");
      if (harness.missionTools?.mechanism === "mcp-client") {
        descriptor = await missionMcpDescriptor(session.cwd, lease.home);
        if (!descriptor) throw new Error("Mission Control's MCP server is not built - run: npm run build");
        dropPaneIdentityEnv(descriptor.env);
        delete descriptor.env.MISSION_SESSION_ID;
        delete descriptor.env.FLEET_SESSION_ID;
        delete descriptor.env.HARNESS_SESSION_ID;
        descriptor.env.MISSION_AGENT_SESSION_ID = session.agentSessionId;
        const checked = await verifyMissionMcpTools(requiredTools, descriptor);
        if (!checked.ok) throw new Error(checked.reason);
      }
      const rendered = await harness.resumeTools({ descriptor, stateHome: lease.home,
        requiredTools });
      argv.push(...rendered.args);
      instrumented = rendered.instrumented;
    }
    const scope = harness.multiRepoDispatch;
    if (context.extraDirs.length && scope?.kind === "flags") argv.push(...scope.launchArgs([...context.extraDirs]));
    const env = agentSubprocessEnv({}, { stateHome: lease.home, loopbackAccess: true, cwd: session.cwd });
    dropPaneIdentityEnv(env);
    delete env.MISSION_SESSION_ID;
    env.MISSION_AGENT_SESSION_ID = session.agentSessionId;
    writeResumeRecord(join(lease.home, "launch.json"), { argv, env, cwd: session.cwd });
    const wrapper = join(lease.home, LAUNCH_SCRIPT_FILE);
    // This tiny shell holds no config or credential. The guard claims before reading either.
    const command = [runtime.command, guard, lease.root, lease.id];
    writeFileSync(wrapper, `#!/bin/sh\n${runtime.env.ELECTRON_RUN_AS_NODE ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}exec ${shellCommand(command)}\n`, { mode: 0o700 });
    return { cwd: session.cwd, argv, wrappedArgv: [FIXED_OS_EXECUTABLES.sh, wrapper], stateHome: lease.home,
      lease, descriptor, requiredTools, instrumented, dispose,
      beginLaunch: () => { beginResumeLaunch(lease); preparing.delete(lease.id); } };
  } catch (error) {
    dispose();
    throw error;
  }
}
