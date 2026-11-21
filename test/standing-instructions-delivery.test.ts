import { isTerminalBackendId } from "../src/shared/terminal.ts";
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "../src/shared/types.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import { mkOriginAndClone, seedGitRepo } from "./helpers/git-fixture.ts";

// Repository standing instructions reaching a real launch, on every one of the five shipped
// harness · runtime pairs.
//
// Two things are being defended here and they pull in opposite directions.
//
// The first is that a repository with NO standing instructions dispatches a byte-identical
// prompt and argv to what it did before this feature existed. That is the decisive
// regression guard, and it is stated as a difference: the same dispatch is run twice, once
// against an empty document and once against a configured one, and the ONLY permitted
// difference is the delivery itself.
//
// The second is EXACTLY-ONCE. A pair with an out-of-band channel carries the block there and
// must not also prefix it into turn one; a pair without one prefixes it and sends nothing out
// of band. Both would have the agent read the same rule twice on its first turn, which for a
// rule phrased as a prohibition invites reading the repetition as emphasis about something
// the operator said once. So every case below asserts the prompt AND the launch payload
// together - neither a double send nor a silent drop can pass on one of them alone.

const home = mkdtempSync(join(tmpdir(), "mission-standing-delivery-"));
process.env.HARNESS_HOME = home;
// Binaries that exist, so bin resolution can never be what fails a launch. The terminal home
// is faked through the dispatcher's `spawn` seam.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_CODEX_BIN = "/bin/echo";
process.env.MISSION_PI_BIN = "/bin/echo";
// The ask channel rides on every Claude launch, so its redirect always leads the one
// `--append-system-prompt`; the measurement below is what this feature adds AFTER it.
// A stand-in bundle: the ask channel only checks that the path EXISTS, and every
// Claude and Codex launch now requires `request_input`, so a launch with no bundle at all
// is refused. What it publishes is answered by the `verifyMissionMcpTools` stub.
process.env.MISSION_MCP_SERVER = join(home, "server.mjs");
writeFileSync(process.env.MISSION_MCP_SERVER, "// not executed by this test\n");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { openDb, getStandingInstructions, insertStandingInstructions, moveStandingInstructions } = await import(
  "../src/server/db.ts"
);
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { taskPlanDiscovery } = await import("../src/server/plans/inputs.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { standingInstructionsView, updateStandingInstructions } = await import(
  "../src/server/instructions/config.ts"
);
const { STANDING_INSTRUCTIONS_HEADING, STANDING_INSTRUCTIONS_MULTI_HEADING } = await import("../src/server/instructions/compose.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { askChannelPrompt } = await import("../src/server/ask-channel.ts");

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

const RULE = "Never run the E2E suite locally. It only runs in CI.";
const DEFAULT_RULE = "Preserve unrelated work.";
const BLOCK = `${STANDING_INSTRUCTIONS_HEADING}\n\n${DEFAULT_RULE}\n\n${RULE}`;

/** The Mission Control MCP server every Claude and Codex launch is now handed. */
const MISSION_DESCRIPTOR = { serverName: "mission-control", command: "/usr/bin/node", args: ["/m.mjs"], env: {} };

const clones: string[] = [];

after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const root of clones) rmSync(root, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_CODEX_BIN;
  delete process.env.MISSION_PI_BIN;
  delete process.env.MISSION_MCP_SERVER;
});

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  setHarnessesConfig({ sessionRuntime: { claude: "terminal", codex: "terminal", pi: "terminal" } });
});

/** A repo a worktree can actually be cut from, named by its CANONICAL path. */
function seedRepo(name: string): string {
  const repo = join(home, name);
  seedGitRepo(repo, { branch: "main", files: { "file.txt": "base\n" } });
  // Realpath, because `resolveRepoPath` canonicalizes and the macOS temp dir is a symlink -
  // a key stored under the uncanonical spelling would match nothing, which is exactly the
  // silent "nothing applies" this feature has to avoid.
  return realpathSync(repo);
}

/** Store a default and repository addition through the same door the route uses. */
function setRule(repoPath: string, text: string): void {
  const result = updateStandingInstructions({
    expectedEtag: standingInstructionsView().etag,
    default: DEFAULT_RULE,
    repositories: { [repoPath]: text },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
}

let seq = 0;
function mkDiscovered(over: Partial<DiscoveredSession>): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys10${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/task-${n}`,
    gitBranch: "harness/task",
    pid: 1000 + n,
    tty: `ttys10${n}`,
    terminals: [mkMuxHandle({ session: `si${n}`, windowName: "w", windowIndex: 0, paneId: `%${100 + n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

interface TerminalRun {
  registry: InstanceType<typeof Registry>;
  argv: string[];
  terminalBackend: string | null;
  /** The composed prompt, from the pane paste or (for Pi) from the launch argv. */
  prompt: string;
  sessionId: string;
  nativeId: string;
}

/**
 * Drive one real terminal dispatch, faking only the terminal home and the pane.
 *
 * Everything under test runs for real: provisioning, resolution against the stored document,
 * composition, and the argv assembly.
 */
async function terminalDispatch(options: {
  agent: "claude" | "codex" | "pi";
  repo: string;
  taskId: string;
  intent: string;
  /** The `headless-mode` flag, which gates repository task skills. Off unless a case says so. */
  headlessMode?: boolean;
  kind?: "ship" | "bugfix";
}): Promise<TerminalRun> {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: options.taskId,
      status: "dispatching",
      repoRoot: options.repo,
      title: "Standing instructions",
      intent: options.intent,
      agent: options.agent,
      ...(options.kind ? { kind: options.kind } : {}),
    }),
  );
  const nativeId = `native-${options.taskId}`;
  let argv: string[] = [];
  let terminalBackend: string | null = null;
  let pasted: string | null = null;
  let sessionId = "";
  const dispatcher = new Dispatcher(registry, async () => {}, {
    headlessModeEnabled: () => options.headlessMode ?? false,
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    spawn: async (_label, _short, cwd, _bin, args, _stateHome, selectedBackend) => {
      argv = [...(args ?? [])];
      terminalBackend = selectedBackend ?? null;
      const discovered = mkDiscovered({
        agent: options.agent,
        cwd,
        syntheticId: `sid-${options.taskId}`,
      });
      registry.applyDiscovery([discovered]);
      sessionId = discovered.syntheticId;
      registry.applyHook({
        agent: options.agent,
        event: "SessionStart",
        sessionId: nativeId,
        cwd,
        transcriptPath: null,
        env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId },
      });
      return { homeName: `home-${options.taskId}`, homeBackend: isTerminalBackendId(selectedBackend) ? selectedBackend : "tmux", terminalResourceId: null };
    },
    inject: async (session, text) => {
      pasted = text;
      registry.applyHook({
        agent: options.agent,
        event: "UserPromptSubmit",
        sessionId: nativeId,
        cwd: session.cwd,
        transcriptPath: null,
        prompt: text,
        env: { tmuxPane: "%1" },
      });
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  await dispatcher.dispatch(options.taskId);
  const task = registry.getTask(options.taskId);
  assert.equal(task?.status, "running", `dispatch failed: ${task?.error ?? "unknown"}`);
  // Pi's turn one travels in the argv rather than through a paste.
  const prompt = pasted ?? String(argv[argv.length - 1]);
  return { registry, argv, terminalBackend, prompt, sessionId, nativeId };
}

test("a saved terminal backend reaches the next launch and stays with its task home", async () => {
  setHarnessesConfig({ terminalBackend: { claude: "herdr" } });
  const run = await terminalDispatch({
    agent: "claude",
    repo: seedRepo("terminal-backend-repo"),
    taskId: "terminal-backend-task",
    intent: "use the configured terminal",
  });

  assert.equal(run.terminalBackend, "herdr");
  const task = run.registry.getTask("terminal-backend-task")!;
  assert.equal(task.homeBackend, "herdr");
  run.registry.upsertTask({
    ...task,
    status: "done",
    worktreePath: null,
    homeName: null,
    homeBackend: null,
    terminalResourceId: null,
  });
});

/** Records what the dispatcher asked the supervisor for, and answers with a card. */
function fakeSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      const session = registry.registerSdkSession({
        // Unique across the whole file: the snapshot table outlives any one Registry, so a
        // reused key would let one test's row be read back as the next test's.
        id: `sdk:${++seq}`,
        agent: input.agent,
        name: input.name,
        cwd: input.cwd,
      });
      // The real supervisor writes the launch snapshot here, because it is the only caller
      // that sees what the driver reported back about the channel it could actually use. The
      // stand-in records the requested mechanism, which is what a driver that did as it was
      // asked reports; the fallback case is proven against the real class below.
      if (input.standingInstructions?.delivery.text) {
        registry.recordStandingInstructions(session.id, input.standingInstructions.delivery);
      }
      return session;
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

async function sdkDispatch(options: {
  agent: "claude" | "codex";
  repo: string;
  taskId: string;
  intent: string;
}) {
  setHarnessesConfig({ sessionRuntime: { [options.agent]: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: options.taskId,
      status: "dispatching",
      repoRoot: options.repo,
      title: "Standing instructions",
      intent: options.intent,
      agent: options.agent,
    }),
  );
  const supervisor = fakeSupervisor(registry);
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    inject: async () => {
      throw new Error("an embedded dispatch must never type at a pane");
    },
  }).dispatch(options.taskId);
  const task = registry.getTask(options.taskId);
  assert.equal(task?.status, "running", `dispatch failed: ${task?.error ?? "unknown"}`);
  return { registry, start: supervisor.starts[0]!, sessionId: `sdk:${seq}` };
}

// ---- the decisive regression guard ----

test("a repository with NO standing instructions dispatches a byte-identical prompt and argv", async () => {
  const repo = seedRepo("guard-repo");
  const intent = "sort out the flexbox helper";
  const baseline = await terminalDispatch({
    agent: "claude",
    repo,
    taskId: "guard-none",
    intent,
  });

  // No standing-instruction heading, separator or extra newline is added to the normal
  // task contract, including its repository-scoped plan discovery.
  assert.equal(
    baseline.prompt,
    withTaskKindContract(registryTask(baseline, "guard-none"), intent, {
      planDiscovery: await taskPlanDiscovery(registryTask(baseline, "guard-none")),
    }),
  );
  // The only append is the ask redirect every Claude launch carries.
  assert.equal(baseline.argv.filter((a) => a === "--append-system-prompt").length, 1);
  assert.equal(baseline.argv[baseline.argv.indexOf("--append-system-prompt") + 1], askChannelPrompt);
  // And nothing was recorded about a delivery that did not happen.
  assert.equal(baseline.registry.standingInstructionsFor(baseline.sessionId), null);

  // Now the SAME dispatch against a configured document. The argv difference is the whole
  // measurement: the block joins the one append, after the redirect, and nothing else moved.
  setRule(repo, RULE);
  const withRules = await terminalDispatch({
    agent: "claude",
    repo,
    taskId: "guard-some",
    intent,
  });
  const at = baseline.argv.indexOf("--append-system-prompt") + 1;
  assert.deepEqual(withRules.argv, baseline.argv.map((arg, i) => (i === at ? `${askChannelPrompt}\n\n${BLOCK}` : arg)));
  // Exactly once: the pair HAS a channel, so turn one is untouched.
  assert.equal(withRules.prompt, withTaskKindContract(registryTask(withRules, "guard-some"), intent, {
    planDiscovery: await taskPlanDiscovery(registryTask(withRules, "guard-some")),
  }));
});

// ---- delivery, per pair ----

test("claude · terminal carries it on ONE --append-system-prompt, and not in turn one", async () => {
  const repo = seedRepo("claude-terminal");
  setRule(repo, RULE);
  const run = await terminalDispatch({
    agent: "claude",
    repo,
    taskId: "pair-claude-terminal",
    intent: "do the thing",
  });
  assert.equal(run.argv.filter((a) => a === "--append-system-prompt").length, 1);
  assert.equal(run.argv[run.argv.indexOf("--append-system-prompt") + 1], `${askChannelPrompt}\n\n${BLOCK}`);
  assert.equal(run.prompt.includes(RULE), false, "and not also in turn one");
  assert.equal(
    run.registry.standingInstructionsFor(run.sessionId)?.mechanism,
    "claude-append-system-prompt",
  );
});

test("codex · terminal carries it in turn one, and nowhere else", async () => {
  for (const agent of ["codex"] as const) {
    const repo = seedRepo(`${agent}-terminal`);
    setRule(repo, RULE);
    const run = await terminalDispatch({
      agent,
      repo,
      taskId: `pair-${agent}-terminal`,
      intent: "THE-OPERATOR-REQUEST",
    });
    assert.match(run.prompt, /Never run the E2E suite locally/, `${agent} turn one`);
    assert.ok(run.prompt.includes(BLOCK), "the default precedes the repository addition");
    // Above the request it governs.
    assert.ok(
      run.prompt.indexOf(RULE) < run.prompt.indexOf("THE-OPERATOR-REQUEST"),
      `${agent}: the operator's rules come before the request`,
    );
    assert.equal(
      run.argv.includes("--append-system-prompt"),
      false,
      `${agent} has no out-of-band channel to use`,
    );
    assert.equal(run.registry.standingInstructionsFor(run.sessionId)?.mechanism, "prompt-prefix");
  }
});

test("claude · sdk and codex · sdk carry it out of band, and not in turn one", async () => {
  for (const agent of ["claude", "codex"] as const) {
    const repo = seedRepo(`${agent}-sdk`);
    setRule(repo, RULE);
    const run = await sdkDispatch({
      agent,
      repo,
      taskId: `pair-${agent}-sdk`,
      intent: "THE-OPERATOR-REQUEST",
    });
    assert.equal(run.start.standingInstructions?.delivery.text, BLOCK, `${agent} · sdk`);
    assert.equal(run.start.prompt.includes(RULE), false, "and not also in turn one");
    assert.equal(
      run.registry.standingInstructionsFor(run.sessionId)?.mechanism,
      agent === "claude" ? "claude-sdk-system-prompt-append" : "codex-developer-instructions",
    );
  }
});

test("an SDK dispatch with no rules passes an empty out-of-band value", async () => {
  const repo = seedRepo("sdk-none");
  const run = await sdkDispatch({
    agent: "claude",
    repo,
    taskId: "sdk-none",
    intent: "do the thing",
  });
  assert.deepEqual(run.start.standingInstructions, {
    delivery: { text: "", mechanism: "none", sources: [] },
    fallbackPrompt: "",
  });
  assert.equal(run.registry.standingInstructionsFor(run.sessionId), null);
});

// ---- the launch snapshot ----

test("the snapshot records what was delivered, survives every rotation, and never re-resolves", async () => {
  const repo = seedRepo("snapshot-repo");
  setRule(repo, RULE);
  const run = await terminalDispatch({
    agent: "claude",
    repo,
    taskId: "snapshot",
    intent: "do the thing",
  });

  // Recorded under the key the session held at launch, and already carried to the native key
  // the SessionStart hook bound moments later.
  const first = run.registry.standingInstructionsFor(run.sessionId);
  assert.deepEqual(
    { text: first?.text, mechanism: first?.mechanism, sources: first?.sources },
    {
      text: BLOCK,
      mechanism: "claude-append-system-prompt",
      sources: [{ repoPath: repo, matchedKey: repo }],
    },
  );
  assert.equal(getStandingInstructions(run.nativeId)?.text, BLOCK, "it followed the first bind");

  // TWO more rotations, because a hook copied from `moveLaunchTurnOnInitialBind` passes the
  // first move and strands the row on the second - and a `/clear` does not end the process
  // the flag is installed on.
  for (const next of ["native-clear-1", "native-clear-2"]) {
    run.registry.applyHook({
      agent: "claude",
      event: "SessionStart",
      sessionId: next,
      cwd: run.registry.getSession(run.sessionId)!.cwd,
      transcriptPath: null,
      env: { tmuxPane: "%101" },
    });
    assert.equal(
      run.registry.standingInstructionsFor(run.sessionId)?.text,
      BLOCK,
      `reachable after rotating to ${next}`,
    );
    assert.equal(getStandingInstructions(next)?.text, BLOCK, `durable under ${next}`);
  }

  // Editing the configuration afterwards changes nothing, and REMOVING the override does not
  // delete it. A session keeps the standing instructions it launched with.
  setRule(repo, "a completely different rule");
  assert.equal(run.registry.standingInstructionsFor(run.sessionId)?.text, BLOCK);
  const view = standingInstructionsView();
  assert.ok(
    updateStandingInstructions({ expectedEtag: view.etag, repositories: { [repo]: null } }).ok,
  );
  assert.equal(run.registry.standingInstructionsFor(run.sessionId)?.text, BLOCK);
});

test("a multi-repo dispatch's row holds the WHOLE composed block and one source per repository", async () => {
  const primary = seedRepo("multi-primary");
  const secondary = seedRepo("multi-secondary");
  setRule(primary, "primary rule");
  setRule(secondary, "secondary rule");

  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "multi",
      status: "dispatching",
      repoRoot: primary,
      extraRepos: [
        {
          repoRoot: secondary,
          worktreePath: null,
          branch: null,
          provider: null,
          worktreeLeaseId: null,
          baseSha: null,
          prUrl: null,
          prState: null,
          mergedAt: null,
        },
      ],
      title: "Multi",
      intent: "do the thing",
      agent: "claude",
    } as Parameters<typeof mkTask>[0]),
  );
  const supervisor = fakeSupervisor(registry);
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
  }).dispatch("multi");
  assert.equal(registry.getTask("multi")?.status, "running", registry.getTask("multi")?.error ?? "");

  const snapshot = registry.standingInstructionsFor(`sdk:${seq}`);
  assert.ok(snapshot, "a multi-repo launch records one row");
  // One row, holding the whole labelled block - not one repository's share, which could not
  // represent what the agent actually read.
  assert.match(snapshot.text, /primary rule[\s\S]*secondary rule/);
  assert.equal(snapshot.text.split(DEFAULT_RULE).length - 1, 1);
  assert.ok(snapshot.text.indexOf(DEFAULT_RULE) < snapshot.text.indexOf("primary rule"));
  assert.deepEqual(snapshot.sources, [
    { repoPath: primary, matchedKey: primary },
    { repoPath: secondary, matchedKey: secondary },
  ]);
  assert.equal(supervisor.starts[0]?.standingInstructions?.delivery.text, snapshot.text);
});

test("a multi-repo dispatch appends each attached repository's skill once, in manifest order", async () => {
  const dispatchTwoRepos = async (taskId: string, primary: string, secondary: string) => {
    const registry = new Registry();
    registry.upsertTask(
      mkTask({
        id: taskId,
        status: "dispatching",
        repoRoot: primary,
        extraRepos: [
          { repoRoot: secondary, worktreePath: null, branch: null, provider: null, worktreeLeaseId: null, baseSha: null, prUrl: null, prState: null, mergedAt: null },
        ],
        title: "Multi skills",
        intent: "do the thing",
        agent: "claude",
        kind: "ship",
      } as Parameters<typeof mkTask>[0]),
    );
    const supervisor = fakeSupervisor(registry);
    setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
    await new Dispatcher(registry, async () => {}, {
      supervisor,
      headlessModeEnabled: () => true,
      missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
      verifyMissionMcpTools: async () => ({ ok: true }),
    }).dispatch(taskId);
    assert.equal(registry.getTask(taskId)?.status, "running", registry.getTask(taskId)?.error ?? "");
    return supervisor.starts[0]!;
  };
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  // Both repositories ship a skill: both blocks, once each, primary first.
  const a = seedRepo("skills-primary");
  const b = seedRepo("skills-secondary");
  commitSkill(a, "ship", "PRIMARY skill body\n");
  commitSkill(b, "ship", "SECONDARY skill body\n");
  const both = await dispatchTwoRepos("skills-multi", a, b);
  const headingA = "## Repository ship skill: skills-primary";
  const headingB = "## Repository ship skill: skills-secondary";
  assert.equal(count(both.prompt, headingA), 1);
  assert.equal(count(both.prompt, headingB), 1);
  assert.equal(count(both.prompt, "PRIMARY skill body"), 1);
  assert.equal(count(both.prompt, "SECONDARY skill body"), 1);
  assert.ok(both.prompt.indexOf(headingA) < both.prompt.indexOf(headingB), "manifest order");
  assert.ok(both.prompt.indexOf("PRIMARY skill body") < both.prompt.indexOf(headingB));
  assert.ok(both.prompt.endsWith("SECONDARY skill body"));
  assert.deepEqual(both.standingInstructions?.repoTaskSkills?.included.map((i) => i.repo), ["skills-primary", "skills-secondary"]);

  // Only the second repository ships one: just its block, still named by repository.
  const c = seedRepo("skills-none");
  const d = seedRepo("skills-only-second");
  commitSkill(d, "ship", "ONLY second body\n");
  const one = await dispatchTwoRepos("skills-multi-one", c, d);
  assert.equal(count(one.prompt, "## Repository ship skill: skills-only-second"), 1);
  assert.ok(!one.prompt.includes("ship skill: skills-none"), "the repository with no file contributes nothing");
  assert.equal(count(one.prompt, "## Repository ship skill"), 1);
  assert.deepEqual(one.standingInstructions?.repoTaskSkills?.included.map((i) => i.repo), ["skills-only-second"]);
});

test("the out-of-band fallback turn one keeps manifest -> instructions -> intent order", async () => {
  // A Codex SDK launch can only discover at launch that its channel is unusable, so the
  // dispatcher hands the supervisor a SECOND turn one with the block already composed in. It
  // has to be composed the same way the channel-less pairs compose theirs - by
  // `intentWithRepoManifest`, in the manifest slot - and not by wrapping the finished prompt,
  // which would put the operator's rules ABOVE the manifest naming the checkouts they govern.
  const primary = seedRepo("fallback-order-primary");
  const secondary = seedRepo("fallback-order-secondary");
  setRule(primary, RULE);

  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "fallback-order",
      status: "dispatching",
      repoRoot: primary,
      extraRepos: [
        {
          repoRoot: secondary,
          worktreePath: null,
          branch: null,
          provider: null,
          worktreeLeaseId: null,
          baseSha: null,
          prUrl: null,
          prState: null,
          mergedAt: null,
        },
      ],
      title: "Fallback order",
      intent: "THE-OPERATOR-REQUEST",
      agent: "codex",
    } as Parameters<typeof mkTask>[0]),
  );
  const supervisor = fakeSupervisor(registry);
  setHarnessesConfig({ sessionRuntime: { codex: "sdk" } });
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
  }).dispatch("fallback-order");
  assert.equal(
    registry.getTask("fallback-order")?.status,
    "running",
    registry.getTask("fallback-order")?.error ?? "",
  );

  const start = supervisor.starts[0]!;
  // The prompt actually sent still carries NOTHING - this pair has a channel, and the two
  // deliveries must never both happen.
  assert.equal(start.prompt.includes(RULE), false);
  const fallback = start.standingInstructions!.fallbackPrompt;
  const manifest = fallback.indexOf("## Repositories for this task");
  const block = fallback.indexOf(STANDING_INSTRUCTIONS_MULTI_HEADING);
  const intent = fallback.indexOf("THE-OPERATOR-REQUEST");
  assert.ok(manifest >= 0 && block >= 0 && intent >= 0, "all three are present");
  assert.ok(manifest < block, "the manifest comes first");
  assert.ok(block < intent, "and the operator's rules sit above the request they govern");
  // Byte-identical, either side of the block, to the prompt that would have been sent had
  // this pair had no channel at all. Two compositions of one ordering is how they drift.
  const multiBlock = `${STANDING_INSTRUCTIONS_MULTI_HEADING}\n\n${DEFAULT_RULE}\n\n### ${primary}\n\n${RULE}`;
  assert.equal(fallback, start.prompt.replace("THE-OPERATOR-REQUEST", `${multiBlock}\n\n---\n\nTHE-OPERATOR-REQUEST`));
});

test("a pair with NO out-of-band channel is given no fallback to compose twice", async () => {
  // `pi` has no channel, so its block is already inside `prompt`; a fallback here would be a
  // second copy waiting for a failure that cannot happen.
  const repo = seedRepo("no-fallback");
  setRule(repo, RULE);
  const run = await sdkDispatch({
    agent: "claude",
    repo,
    taskId: "no-fallback-claude",
    intent: "THE-OPERATOR-REQUEST",
  });
  // claude - sdk HAS a channel, so it does get one.
  assert.notEqual(run.start.standingInstructions?.fallbackPrompt, "");

  assert.ok(updateStandingInstructions({
    expectedEtag: standingInstructionsView().etag,
    default: "",
  }).ok);
  const bare = seedRepo("no-rules");
  const none = await sdkDispatch({
    agent: "claude",
    repo: bare,
    taskId: "no-fallback-none",
    intent: "THE-OPERATOR-REQUEST",
  });
  // And a repository with no rules composes no fallback at all.
  assert.equal(none.start.standingInstructions?.fallbackPrompt, "");
});

// ---- the driver's own report of what it could actually do ----

test("the snapshot records the channel the DRIVER used, not the one the launch asked for", async () => {
  // Codex only learns at launch whether its out-of-band channel is usable: it has to read the
  // operator's configured developer instructions before it can merge into them, and that read
  // can fail. When it does, the adapter delivers the block in turn one instead - and the
  // snapshot has to say so, because an assignment reads that snapshot to decide whether the
  // rule is still installed on the process or is turn-one prose that has to be repeated.
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, { missionMcpDescriptor: async () => MISSION_DESCRIPTOR, verifyMissionMcpTools: async () => ({ ok: true }) });
  const real = HARNESSES.codex.sdk;
  const launched: unknown[] = [];
  HARNESSES.codex.sdk = {
    answersRequests: true,
    async launch(opts) {
      launched.push(opts);
      // A driver that found its channel unusable and fell back, exactly as the Codex adapter
      // reports it (`codex-sdk-adapter.test.ts` drives the real one against a scripted server).
      return { ...stubHandle(), standingInstructionsMechanism: "prompt-prefix" as const };
    },
  };
  try {
    const session = await supervisor.start({
      agent: "codex",
      name: "fallback",
      cwd: "/wt/fallback",
      prompt: "THE-OPERATOR-REQUEST",
      model: null,
      effort: null,
      permissionMode: null,
      mcp: null,
      standingInstructions: {
        delivery: {
          text: BLOCK,
          mechanism: "codex-developer-instructions",
          sources: [{ repoPath: "/ws/repo", matchedKey: "/ws/repo" }],
        },
        fallbackPrompt: `${BLOCK}\n\n---\n\nTHE-OPERATOR-REQUEST`,
      },
      taskId: null,
    });
    const snapshot = registry.standingInstructionsFor(session.id);
    assert.equal(snapshot?.text, BLOCK, "the operator's words were delivered");
    assert.equal(snapshot?.mechanism, "prompt-prefix", "by the channel that actually carried them");

    // And the driver was handed a turn one it could fall back INTO, with the block above the
    // request rather than composed by the adapter at whatever position it could guess.
    const opts = launched[0] as { standingInstructions: string; standingInstructionsPrompt: string };
    assert.equal(opts.standingInstructions, BLOCK, "the channel was still attempted first");
    assert.ok(opts.standingInstructionsPrompt.indexOf(RULE) < opts.standingInstructionsPrompt.indexOf("THE-OPERATOR-REQUEST"));
  } finally {
    HARNESSES.codex.sdk = real;
    await supervisor.stopAll?.().catch?.(() => {});
  }
});

test("the real supervisor persists the skill launch record, with or without standing text", async () => {
  const record = {
    included: [{ repo: "app", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", bytes: 12, truncated: false }],
    skipped: [{ repo: "lib", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", reason: "too-large" as const }],
  };
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, { missionMcpDescriptor: async () => MISSION_DESCRIPTOR, verifyMissionMcpTools: async () => ({ ok: true }) });
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    answersRequests: true,
    async launch() {
      return stubHandle();
    },
  };
  try {
    const launch = (name: string, text: string, repoTaskSkills?: typeof record) =>
      supervisor.start({
        agent: "claude",
        name,
        cwd: "/wt/" + name,
        prompt: "go",
        model: null,
        effort: null,
        permissionMode: null,
        mcp: null,
        standingInstructions: {
          delivery: { text, mechanism: text ? "claude-sdk-system-prompt-append" : "none", sources: [] },
          fallbackPrompt: "",
          ...(repoTaskSkills ? { repoTaskSkills } : {}),
        },
        taskId: null,
      });

    // Skill record and no standing text: still recorded, as an empty "none" row.
    const skillsOnly = await launch("skills-only", "", record);
    const row = registry.standingInstructionsFor(skillsOnly.id);
    assert.equal(row?.text, "");
    assert.equal(row?.mechanism, "none");
    assert.deepEqual(row?.repoTaskSkills, record);
    assert.deepEqual(getStandingInstructions(row!.noteKey)?.repoTaskSkills, record, "and read back from the table");

    // Both a standing block and a skill record: both land on the one row.
    const both = await launch("both", BLOCK, record);
    const bothRow = registry.standingInstructionsFor(both.id);
    assert.equal(bothRow?.text, BLOCK);
    assert.deepEqual(bothRow?.repoTaskSkills, record);

    // Neither: no row at all, as before.
    const neither = await launch("neither", "");
    assert.equal(registry.standingInstructionsFor(neither.id), null);
  } finally {
    HARNESSES.claude.sdk = real;
    await supervisor.stopAll?.().catch?.(() => {});
  }
});

test("a later write that does not speak for skills keeps the stored record; an explicit null clears it", () => {
  const record = {
    included: [{ repo: "app", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", bytes: 3, truncated: false }],
    skipped: [],
  };
  const registry = new Registry();
  const session = registry.registerSdkSession({ id: "sdk:keep-skills", agent: "claude", name: "keep", cwd: "/wt/keep" });
  const delivery = { text: BLOCK, mechanism: "prompt-prefix" as const, sources: [] };
  registry.recordStandingInstructions(session.id, delivery, record);
  registry.recordStandingInstructions(session.id, delivery);
  assert.deepEqual(registry.standingInstructionsFor(session.id)?.repoTaskSkills, record, "omitted: kept");
  assert.deepEqual(getStandingInstructions(registry.standingInstructionsFor(session.id)!.noteKey)?.repoTaskSkills, record);
  // No text and nothing said about skills writes nothing, so the row is untouched.
  registry.recordStandingInstructions(session.id, { text: "", mechanism: "none", sources: [] });
  assert.equal(registry.standingInstructionsFor(session.id)?.text, BLOCK);
  registry.recordStandingInstructions(session.id, delivery, null);
  assert.equal(registry.standingInstructionsFor(session.id)?.repoTaskSkills, null, "explicit null: cleared");
});

test("an explicit no-skills launch with no standing text retires a stale skill record", () => {
  const record = {
    included: [{ repo: "app", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", bytes: 3, truncated: false }],
    skipped: [],
  };
  const none = { text: "", mechanism: "none" as const, sources: [] };
  const registry = new Registry();

  // A row that held only skills goes away, in memory and in the table.
  const a = registry.registerSdkSession({ id: "sdk:retire-a", agent: "claude", name: "a", cwd: "/wt/retire-a" });
  registry.recordStandingInstructions(a.id, none, record);
  const keyA = registry.standingInstructionsFor(a.id)!.noteKey;
  registry.recordStandingInstructions(a.id, none);
  assert.ok(registry.standingInstructionsFor(a.id), "omitted: not asserted, so kept");
  registry.recordStandingInstructions(a.id, none, null);
  assert.equal(registry.standingInstructionsFor(a.id), null);
  assert.equal(getStandingInstructions(keyA), undefined);

  // A row that also holds standing text keeps the text and loses only the skills.
  const b = registry.registerSdkSession({ id: "sdk:retire-b", agent: "claude", name: "b", cwd: "/wt/retire-b" });
  registry.recordStandingInstructions(b.id, { text: BLOCK, mechanism: "prompt-prefix", sources: [] }, record);
  registry.recordStandingInstructions(b.id, none, null);
  const kept = registry.standingInstructionsFor(b.id);
  assert.equal(kept?.text, BLOCK);
  assert.equal(kept?.repoTaskSkills, null);
  assert.equal(getStandingInstructions(kept!.noteKey)?.repoTaskSkills, null);

  // And with nothing stored, an explicit none writes no row.
  const c = registry.registerSdkSession({ id: "sdk:retire-c", agent: "claude", name: "c", cwd: "/wt/retire-c" });
  registry.recordStandingInstructions(c.id, none, null);
  assert.equal(registry.standingInstructionsFor(c.id), null);
});

test("a note-key rotation carries the skill launch record to the new key whole", () => {
  const record = {
    included: [{ repo: "app", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", bytes: 12, truncated: true }],
    skipped: [{ repo: "lib", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", reason: "empty" as const }],
  };
  insertStandingInstructions({
    noteKey: "rotate-from",
    text: "",
    mechanism: "none",
    sources: [],
    createdAt: 5,
    repoTaskSkills: record,
  });
  moveStandingInstructions("rotate-from", "rotate-to");
  assert.equal(getStandingInstructions("rotate-from"), undefined, "the old key is gone");
  assert.deepEqual(getStandingInstructions("rotate-to")?.repoTaskSkills, record);
});

test("a malformed stored skill record reads back as null without losing the row", () => {
  const db = openDb();
  const put = (key: string, raw: string | null) =>
    db
      .prepare(
        "INSERT INTO session_standing_instructions (note_key, text, mechanism, sources, created_at, repo_task_skills) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(key, "kept text", "prompt-prefix", "[]", 1, raw);
  put("malformed-json", "{not json");
  put("missing-arrays", JSON.stringify({ included: [] }));
  put("not-an-object", JSON.stringify("a string"));
  put("json-null", "null");
  put("empty-column", null);
  // Elements with the wrong shape are dropped; well-formed and merely unfamiliar ones survive.
  put(
    "bad-elements",
    JSON.stringify({
      included: [{}, { repo: "a", kind: "ship", path: "p", bytes: "12", truncated: false }, { repo: "a", kind: "future-kind", path: "p", bytes: 1, truncated: false }],
      skipped: [null, { repo: "a", kind: "ship", path: "p" }, { repo: "a", kind: "ship", path: "p", reason: "future-reason" }],
    }),
  );
  for (const key of ["malformed-json", "missing-arrays", "not-an-object", "json-null", "empty-column"]) {
    const row = getStandingInstructions(key);
    assert.equal(row?.text, "kept text", key + ": the row is still read");
    assert.equal(row?.repoTaskSkills, null, key + ": the record is null");
  }
  const mixed = getStandingInstructions("bad-elements")?.repoTaskSkills;
  assert.deepEqual(mixed, {
    included: [{ repo: "a", kind: "future-kind", path: "p", bytes: 1, truncated: false }],
    skipped: [{ repo: "a", kind: "ship", path: "p", reason: "future-reason" }],
  });
});

test("a RESUME leaves a stored skill launch record untouched, with or without a standing block", async () => {
  const record = {
    included: [{ repo: "app", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", bytes: 9, truncated: false }],
    skipped: [{ repo: "lib", kind: "ship" as const, path: ".claude/skills/ship/SKILL.md", reason: "empty" as const }],
  };
  for (const [id, thread, text, mechanism] of [
    ["sdk:resume-skills-only", "codex-thread-skills-only", "", "none"],
    ["sdk:resume-skills-block", "codex-thread-skills-block", BLOCK, "codex-developer-instructions"],
  ] as const) {
    upsertSdkSession({
      id,
      agent: "codex",
      agentSessionId: thread,
      cwd: "/wt/" + id,
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    });
    insertStandingInstructions({ noteKey: thread, text, mechanism, sources: [], createdAt: 1, repoTaskSkills: record });
  }
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, { missionMcpDescriptor: async () => MISSION_DESCRIPTOR, verifyMissionMcpTools: async () => ({ ok: true }) });
  const real = HARNESSES.codex.sdk;
  HARNESSES.codex.sdk = {
    answersRequests: true,
    async launch() {
      // The block's channel is unusable on this connection, which also rewrites the row.
      return { ...stubHandle(), standingInstructionsMechanism: "prompt-prefix" as const };
    },
  };
  try {
    await supervisor.restore();
    for (const [id, thread] of [
      ["sdk:resume-skills-only", "codex-thread-skills-only"],
      ["sdk:resume-skills-block", "codex-thread-skills-block"],
    ] as const) {
      assert.deepEqual(registry.standingInstructionsFor(id)?.repoTaskSkills, record, id + ": in memory");
      assert.deepEqual(getStandingInstructions(thread)?.repoTaskSkills, record, id + ": in the table");
    }
  } finally {
    HARNESSES.codex.sdk = real;
  }
});

test("a RESUME that falls back to prose corrects the snapshot, so the next assignment replays", async () => {
  // The sequence the snapshot has to survive: a Codex SDK launch installs the block on the
  // durable channel, the daemon restarts, and `config/read` is unusable NOW - so the resumed
  // process was told the rule as one message rather than having it installed. Left saying
  // `codex-developer-instructions`, the snapshot would tell the next assignment the rule was
  // still governing every turn, and the assignment would send none of it. A prefix governs
  // only the turn it rode in, which is exactly why `tasks.ts` repeats one.
  upsertSdkSession({
    id: "sdk:resume-fallback",
    agent: "codex",
    agentSessionId: "codex-thread-1",
    cwd: "/wt/resume-fallback",
    taskId: null,
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
    turnInProgress: false,
  });
  // What the LAUNCH recorded, under the note key a resume reads: the durable channel.
  insertStandingInstructions({
    noteKey: "codex-thread-1",
    text: BLOCK,
    mechanism: "codex-developer-instructions",
    sources: [{ repoPath: "/ws/repo", matchedKey: "/ws/repo" }],
    createdAt: 1,
  });
  // Constructed AFTER both rows, because a daemon reads them at boot and resumes afterwards.
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, { missionMcpDescriptor: async () => MISSION_DESCRIPTOR, verifyMissionMcpTools: async () => ({ ok: true }) });

  const real = HARNESSES.codex.sdk;
  const launched: { standingInstructions: string; standingInstructionsPrompt: string }[] = [];
  HARNESSES.codex.sdk = {
    answersRequests: true,
    async launch(opts) {
      launched.push(opts as never);
      // A driver that found the channel unusable on THIS connection and sent the block as
      // prose instead - what `codex-sdk-adapter.test.ts` drives the real adapter into.
      return { ...stubHandle(), standingInstructionsMechanism: "prompt-prefix" as const };
    },
  };
  try {
    await supervisor.restore();
    // It was attempted on the channel first, and it was given the stored block to send as
    // prose - by itself, because the intent is already in the conversation being reopened.
    assert.equal(launched[0]?.standingInstructions, BLOCK);
    assert.equal(launched[0]?.standingInstructionsPrompt, BLOCK);

    const snapshot = registry.standingInstructionsFor("sdk:resume-fallback");
    assert.equal(snapshot?.text, BLOCK, "the operator's words are unchanged");
    assert.equal(snapshot?.mechanism, "prompt-prefix", "and the row says how they really got there");
    // Durable, not only in memory: the next daemon restart reads this row, not this process.
    assert.equal(getStandingInstructions("codex-thread-1")?.mechanism, "prompt-prefix");
    assert.equal(getStandingInstructions("codex-thread-1")?.createdAt, 1, "and it is not re-aged");
  } finally {
    HARNESSES.codex.sdk = real;
  }

  // The consequence, end to end: an assignment into a session carrying THAT corrected
  // snapshot repeats the rule, where the same assignment against the launch's original
  // mechanism would have sent nothing.
  const replayed = await assignInto({
    agent: "claude",
    taskIntent: "and now do this",
    seed: (reg, sessionId) => {
      reg.recordStandingInstructions(sessionId, {
        text: BLOCK,
        mechanism: "codex-developer-instructions",
        sources: [],
      });
      reg.markStandingInstructionsPrefixed(sessionId);
    },
  });
  assert.match(replayed, new RegExp(STANDING_INSTRUCTIONS_HEADING));
  assert.ok(replayed.indexOf(RULE) < replayed.indexOf("and now do this"));
});

/** The smallest handle `adopt` can pump: a stream that ends, and controls that do nothing. */
function stubHandle() {
  return {
    events: (async function* () {})(),
    async send() {
      return "started" as const;
    },
    async sendIfIdle() {
      return "started" as const;
    },
    async interrupt() {},
    async answer() {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    async stop() {},
  };
}

// ---- assignment: launch resolves, assignment repeats ----

async function assignInto(options: {
  agent: "claude" | "pi";
  taskIntent: string;
  seed?: (registry: InstanceType<typeof Registry>, sessionId: string, cwd: string) => void;
}): Promise<string> {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const { root, clone: cwd } = mkOriginAndClone("mission-standing-assign-");
  clones.push(root);
  const discovered = mkDiscovered({
    agent: options.agent,
    cwd,
    syntheticId: `assign-${++seq}`,
    gitRoot: cwd,
    repoRoot: cwd,
  } as Partial<DiscoveredSession>);
  registry.applyDiscovery([discovered]);
  registry.applyHook({
    agent: options.agent,
    event: "Stop",
    sessionId: `assign-native-${seq}`,
    cwd,
    transcriptPath: null,
    env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId },
  });
  options.seed?.(registry, discovered.syntheticId, cwd);
  registry.upsertTask(mkTask({ id: `assign-task-${seq}`, repoRoot: cwd, intent: options.taskIntent }));

  const typed: string[] = [];
  const result = await tasks.assign(`assign-task-${seq}`, discovered.syntheticId, {
    paneReady: async () => ({ ok: true }),
    reset: async () => ({ ok: true, error: null, root: null, cleared: true, detached: true }),
    confirmReset: true,
    inject: async (_session, text) => {
      typed.push(text);
      return { ok: true, pasted: true, submitVerified: true };
    },
    rename: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return typed[0]!;
}

test("a session with no snapshot is assigned a byte-identical prompt to today", async () => {
  const text = await assignInto({ agent: "claude", taskIntent: "and now do this" });
  assert.equal(text.includes(STANDING_INSTRUCTIONS_HEADING), false);
  // A session launched without a standing instruction does not acquire one mid-life.
  assert.match(text, /^and now do this\n\n## Mission Control execution authorization/);
});

test("an assignment REPLAYS the snapshot on a prefix pair and composes nothing on a channel pair", async () => {
  // Nothing is resolved at an assignment. The repository cannot have changed - `assign`
  // refuses a multi-repo task - so the only thing that could have is the configuration, and
  // a live process's system prompt cannot be rewritten.
  const prefixText = await assignInto({
    agent: "claude",
    taskIntent: "and now do this",
    seed: (registry, sessionId) => {
      registry.recordStandingInstructions(sessionId, {
        text: BLOCK,
        mechanism: "prompt-prefix",
        sources: [{ repoPath: "/ws/whatever", matchedKey: "/ws/whatever" }],
      });
    },
  });
  // A prefix is turn-one prose that can be compacted away and does not govern later turns,
  // so it has to be repeated - and repeated UNCHANGED, from the snapshot rather than from a
  // fresh resolution.
  assert.match(prefixText, new RegExp(STANDING_INSTRUCTIONS_HEADING));
  assert.ok(prefixText.indexOf(RULE) < prefixText.indexOf("and now do this"));

  const channelText = await assignInto({
    agent: "claude",
    taskIntent: "and now do this",
    seed: (registry, sessionId) => {
      registry.recordStandingInstructions(sessionId, {
        text: BLOCK,
        mechanism: "claude-append-system-prompt",
        sources: [],
      });
    },
  });
  // The block is still installed on that process - that is what "durable" means - so
  // prefixing it again would have the agent read the same rule twice.
  assert.equal(channelText.includes(STANDING_INSTRUCTIONS_HEADING), false);
});

/** The provisioned task as the dispatch left it, for recomputing today's composition. */
function registryTask(run: TerminalRun, taskId: string) {
  const task = run.registry.getTask(taskId);
  assert.ok(task);
  return task;
}

test("Pi standing instructions move out of turn one without changing the empty launch", async () => {
  const repo = seedRepo("pi-terminal-channel");
  const intent = "THE-OPERATOR-REQUEST";
  const baseline = await terminalDispatch({ agent: "pi", repo, taskId: "pi-none", intent });
  assert.deepEqual(baseline.argv, ["--session-id", baseline.argv[1],
    withTaskKindContract(registryTask(baseline, "pi-none"), intent, {
      planDiscovery: await taskPlanDiscovery(registryTask(baseline, "pi-none")),
    })]);
  assert.equal(baseline.registry.standingInstructionsFor(baseline.sessionId), null);
  setRule(repo, RULE);
  const run = await terminalDispatch({ agent: "pi", repo, taskId: "pi-rule", intent });
  const expectedPrompt = withTaskKindContract(registryTask(run, "pi-rule"), intent, {
    planDiscovery: await taskPlanDiscovery(registryTask(run, "pi-rule")),
  });
  assert.deepEqual(run.argv, ["--append-system-prompt", BLOCK, "--session-id", run.argv[3], expectedPrompt]);
  assert.equal(run.prompt, expectedPrompt);
  assert.equal(run.prompt.includes(RULE), false);
  const snapshot = run.registry.standingInstructionsFor(run.sessionId);
  assert.equal(snapshot?.mechanism, "pi-append-system-prompt");
  assert.equal(snapshot?.text, BLOCK);
});

// Opt-in runtime measurement. The temporary observer only reads the live system prompt;
// it never supplies instructions, calls a model, or installs the later phase's extension.
test("live Pi receives the dispatched block once and preserves another append", {
  skip: !process.env.MISSION_PI_LIVE_PROBE_BIN,
}, async () => {
  const repo = seedRepo("pi-live-channel");
  setRule(repo, RULE);
  const run = await terminalDispatch({ agent: "pi", repo, taskId: "pi-live", intent: "LIVE-INTENT" });
  const output = join(home, "pi-system-prompt.txt");
  const observer = join(home, "pi-observer.ts");
  writeFileSync(observer, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(${JSON.stringify(output)}, ctx.getSystemPrompt());
    process.exit(0);
  });
}
`);
  const other = "PI-INDEPENDENT-APPEND-PROBE";
  const cwd = run.registry.getSession(run.sessionId)?.cwd;
  assert.ok(cwd, "the dispatched session has a worktree");
  execFileSync(process.env.MISSION_PI_LIVE_PROBE_BIN!, [
    "--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-skills",
    "--no-context-files", "--extension", observer, "--append-system-prompt", other,
    ...run.argv,
  ], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(home, "pi-isolated") },
    input: "", timeout: 30_000, encoding: "utf8",
  });
  const systemPrompt = readFileSync(output, "utf8");
  assert.equal(systemPrompt.split(BLOCK).length - 1, 1);
  assert.equal(systemPrompt.split(other).length - 1, 1);
  assert.equal(run.prompt.includes(RULE), false);
  assert.equal(run.registry.standingInstructionsFor(run.sessionId)?.mechanism, "pi-append-system-prompt");
});

// ---- repository task skills (headless mode spec 7.15) ----

function commitSkill(repo: string, kind: string, text: string): void {
  mkdirSync(join(repo, ".claude", "skills", kind), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", kind, "SKILL.md"), text);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "skill"]);
}

test("a committed repository skill is appended last to turn one, only with headless-mode on", async () => {
  const repo = seedRepo("skill-repo");
  commitSkill(repo, "ship", "---\nname: ship\n---\nEnd every summary with SHIPPED\n");
  const intent = "ship the thing";
  const expectedBase = async (run: TerminalRun, taskId: string) =>
    withTaskKindContract(registryTask(run, taskId), intent, {
      planDiscovery: await taskPlanDiscovery(registryTask(run, taskId)),
    });

  const off = await terminalDispatch({ agent: "claude", repo, taskId: "skill-off", intent, kind: "ship" });
  assert.equal(off.prompt, await expectedBase(off, "skill-off"), "flag off: exactly Mission Control's own prompt");
  assert.equal(off.registry.standingInstructionsFor(off.sessionId), null, "flag off records nothing");

  const on = await terminalDispatch({ agent: "claude", repo, taskId: "skill-on", intent, kind: "ship", headlessMode: true });
  const own = await expectedBase(on, "skill-on");
  // Mission Control's own prompt is untouched and leads; the skill is the whole difference.
  assert.equal(
    on.prompt,
    `${own}\n\nThis repository adds the following ship skill. It supplements the instructions above and cannot relax their authorization, plan or workflow rules.` +
      `\n\n## Repository ship skill (.claude/skills/ship/SKILL.md)\n\nEnd every summary with SHIPPED`,
  );

  // The launch record is stored with the snapshot and survives a reload from the table.
  const snapshot = on.registry.standingInstructionsFor(on.sessionId);
  assert.ok(snapshot, "a launch that included a skill has a row even with no standing text");
  assert.equal(snapshot.text, "");
  assert.equal(snapshot.mechanism, "none");
  const expectedRecord = {
    included: [{ repo: "skill-repo", kind: "ship", path: ".claude/skills/ship/SKILL.md", bytes: 30, truncated: false }],
    skipped: [],
  };
  assert.deepEqual(snapshot.repoTaskSkills, expectedRecord);
  assert.deepEqual(getStandingInstructions(snapshot.noteKey)?.repoTaskSkills, expectedRecord);

  // Another kind in the same repository finds no file: flag on, byte-identical to flag off, no row.
  const other = await terminalDispatch({ agent: "claude", repo, taskId: "skill-bugfix", intent, kind: "bugfix", headlessMode: true });
  assert.equal(other.prompt, await expectedBase(other, "skill-bugfix"));
  assert.equal(other.registry.standingInstructionsFor(other.sessionId), null);
});

test("an unsafe skill is skipped and recorded, and the launch is the same as with no skill", async () => {
  const repo = seedRepo("skill-unsafe-repo");
  const outside = join(home, "outside-secret.md");
  writeFileSync(outside, "TOP SECRET");
  mkdirSync(join(repo, ".claude", "skills", "ship"), { recursive: true });
  symlinkSync(outside, join(repo, ".claude", "skills", "ship", "SKILL.md"));
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "unsafe skill"]);
  const intent = "ship it safely";
  const run = await terminalDispatch({ agent: "claude", repo, taskId: "skill-unsafe", intent, kind: "ship", headlessMode: true });
  assert.ok(!run.prompt.includes("TOP SECRET"));
  assert.equal(
    run.prompt,
    withTaskKindContract(registryTask(run, "skill-unsafe"), intent, {
      planDiscovery: await taskPlanDiscovery(registryTask(run, "skill-unsafe")),
    }),
  );
  assert.deepEqual(run.registry.standingInstructionsFor(run.sessionId)?.repoTaskSkills, {
    included: [],
    skipped: [{ repo: "skill-unsafe-repo", kind: "ship", path: ".claude/skills/ship/SKILL.md", reason: "outside-worktree" }],
  });
});

test("an SDK dispatch hands the skill launch record to the supervisor", async () => {
  const repo = seedRepo("skill-sdk-repo");
  commitSkill(repo, "ship", "Use the SDK skill\n");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "skill-sdk", status: "dispatching", repoRoot: repo, title: "t", intent: "go", agent: "claude", kind: "ship" }),
  );
  const supervisor = fakeSupervisor(registry);
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    headlessModeEnabled: () => true,
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    inject: async () => {
      throw new Error("an embedded dispatch must never type at a pane");
    },
  }).dispatch("skill-sdk");
  const start = supervisor.starts[0]!;
  assert.ok(start.prompt.endsWith("Use the SDK skill"));
  assert.deepEqual(start.standingInstructions?.repoTaskSkills?.included.map((i) => i.repo), ["skill-sdk-repo"]);
});
