import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedResumeFixture } from "./helpers/managed-resume-fixture.ts";

// A hibernated TERMINAL task's Resume, through the production preparation: the managed terminal
// resume (`prepareTerminalResume`) of the SAME conversation, in the task's own checkout, with
// the mode it last ran in. Only the terminal itself is scripted - the launch and the agent
// appearing in discovery - so what is asserted is what a real terminal would have been handed.

const home = mkdtempSync(join(tmpdir(), "hibernation-terminal-resume-"));
process.env.MISSION_HOME = home;
process.env.MISSION_CLAUDE_BIN = process.execPath;
await managedResumeFixture(home);
const { Registry } = await import("../src/server/registry.ts");
const { HibernationManager } = await import("../src/server/hibernation/manager.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { mkMuxHandle, mkTask } = await import("./helpers/session-fixture.ts");
after(() => rmSync(home, { recursive: true, force: true }));

type Discovered = import("../src/server/discovery/correlate.ts").DiscoveredSession;
type Prepared = import("../src/server/harness/resume.ts").PreparedResume;

function discovered(id: string, cwd: string, pane: string, pid: number): Discovered {
  return {
    syntheticId: id, agent: "claude", name: "work", nameSource: "process", cwd, gitBranch: "harness/t",
    pid, tty: `ttys${pid}`, terminals: [mkMuxHandle({ session: `home-${pid}`, paneId: pane })], startedAt: pid,
  } as Discovered;
}

function started(registry: InstanceType<typeof Registry>, cwd: string, pane: string, conversation: string): void {
  for (const event of ["SessionStart", "Stop"]) {
    registry.applyHook({ agent: "claude", event, sessionId: conversation, cwd, transcriptPath: null,
      env: { tmuxPane: pane } } as never);
  }
}

test("a terminal Resume launches the managed resume of the same conversation in its checkout", async () => {
  applyFeatureFlagIntent({ kind: "flag", id: "task-hibernation", enabled: true });
  const cwd = join(home, "worktree");
  mkdirSync(cwd, { recursive: true });
  const registry = new Registry();
  let launched: Prepared | null = null;
  const hibernation = new HibernationManager(registry, null, {
    terminal: {
      stop: async () => {
        registry.applyDiscovery([]);
        return { ok: true };
      },
      // The scripted process is gone once discovery stops seeing it.
      exited: async () => true,
      // `prepare` is the production default: the real managed resume is composed here.
      spawn: async (input) => {
        launched = input.prepared;
        setImmediate(() => {
          registry.applyDiscovery([discovered("proc-new", cwd, "%2", 2)]);
          started(registry, cwd, "%2", "conv-real");
        });
        return { homeName: input.name, homeBackend: "tmux", terminalResourceId: "multiplexer:tmux:$4" };
      },
      // The scripted terminal never runs the guard, so the launch is proven by the session it
      // brings up; production asks the lease's guard process and the emulator tab instead.
      provesLaunch: async (session) => session.id === "proc-new",
      closeHome: async () => ({ ok: true }),
      launchLive: () => false,
      backendFor: () => "tmux",
      appearMs: 2_000,
    },
  });
  registry.applyDiscovery([discovered("proc-old", cwd, "%1", 1)]);
  started(registry, cwd, "%1", "conv-real");
  registry.upsertTask(mkTask({ id: "real", title: "Real resume", status: "running", sessionId: "proc-old", worktreePath: cwd, repoRoot: cwd }));

  assert.equal((await hibernation.hibernate("proc-old")).ok, true);
  const result = await hibernation.resume("real");
  try {
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    const prepared = launched as Prepared | null;
    assert.ok(prepared, "a managed resume was prepared and handed to the terminal");
    assert.equal(prepared.cwd, cwd, "in the task's own checkout");
    const resumeAt = prepared.argv.indexOf("--resume");
    assert.ok(resumeAt > 0, prepared.argv.join(" "));
    assert.equal(prepared.argv[resumeAt + 1], "conv-real", "reopening the same conversation");
    assert.equal(registry.getTask("real")?.sessionId, "proc-new");
    assert.equal(registry.getTask("real")?.status, "running");
  } finally {
    (launched as Prepared | null)?.dispose();
  }
});
