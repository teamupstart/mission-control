import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Task, TaskKind } from "@shared/types.ts";
import {
  PRODUCT_ISSUE_CLIENT_ENV,
  type ProductIssueClient,
} from "@shared/product-issues.ts";
import { STATE_DIR, mcpServerPath } from "./config.ts";
import { agentSubprocessEnv, cleanupAgentSubprocessEnv } from "./agent-subprocess-env.ts";
import { SUBMIT_ENSEMBLE_RESULT_TOOL } from "./ensembles/submission-tool.ts";
import { PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL } from "./plans/tools.ts";
import { SUBMIT_SCOUT_ARTIFACTS_TOOL } from "./scouts/submission-tool.ts";
import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./workflows/evidence-tool.ts";
import { COMPLETE_RETRO_NO_CHANGE_TOOL } from "./retro-tool.ts";
import {
  PIPELINE_CALLER_CREDENTIAL_FILE_ENV,
  PIPELINE_CALLER_CREDENTIAL_TTL_MS,
} from "@shared/pipeline.ts";
import { executableChildEnv, locateExecutable } from "./executables/locator.ts";

// The one place that knows how to hand a LAUNCHING agent our own MCP server.
//
// There are two consumers and they speak different launch grammars - Claude takes a
// `--mcp-config` JSON file, Codex takes `-c mcp_servers.<name>.*` TOML overrides - but
// they are registering the SAME bundle, under the same name, through the same runtime,
// and the tool names an agent then calls are derived from that name. Two writers of that
// answer is two ways for a dispatched session to end up pointed at a stale path, an
// Electron binary with no `ELECTRON_RUN_AS_NODE`, or a server name whose tools no longer
// match the ones a prompt told the agent to call. So the resolution lives here once and
// each harness only renders it.
//
// Everything in this file is LAUNCH-scoped: it reaches sessions the dashboard dispatches
// and nothing else. Whatever `claude mcp add` / `codex mcp add` wrote into the machine's
// own config (see `src/main/integrations.ts`) is untouched, and a session an operator
// started themselves is untouched with it.

/** What the MCP server is registered as, and therefore the prefix its tools carry. */
export const MISSION_MCP_SERVER_NAME = "mission-control";

/**
 * Every tool the bundled server exposes (`src/mcp/server.ts`).
 *
 * A LIST rather than free text because the one thing a caller does with a tool name is
 * pre-approve it on the spawn argv, and a name that does not match what the server
 * registers pre-approves nothing at all - the agent still stops on a permission prompt,
 * which is precisely the failure the ask channel's `--allowed-tools` exists to prevent
 * and precisely the kind that shows up as "the agent just sat there". `mission-mcp.test.ts`
 * reads the server's own `registerTool` calls and fails if the two drift.
 */
export const MISSION_MCP_TOOLS = [
  "share_plan",
  PLAN_DECISIONS_TOOL,
  "request_review",
  PLAN_SCHEDULING_TOOL,
  "request_input",
  "report_product_issue",
  "report_status",
  // A bare literal rather than a constant, like its neighbours above: `mission-mcp.test.ts`
  // scrapes `registerTool("...")` out of the server and compares the two lists by value, and
  // `scripts/smoke-bundles.mjs` resolves any CONSTANT here through a hand-written name-to-module
  // map it would also have to be added to.
  "respond_to_file_comments",
  "adopt_pipeline_run",
  "report_pipeline_workspace",
  SUBMIT_ENSEMBLE_RESULT_TOOL,
  SUBMIT_SCOUT_ARTIFACTS_TOOL,
  SUBMIT_WORKFLOW_EVIDENCE_TOOL,
  COMPLETE_RETRO_NO_CHANGE_TOOL,
] as const;

export type MissionMcpTool = (typeof MISSION_MCP_TOOLS)[number];

/** The fully-qualified name, as an MCP client namespaces a server's tool. */
export function missionMcpToolName(tool: MissionMcpTool): string {
  return `mcp__${MISSION_MCP_SERVER_NAME}__${tool}`;
}

/**
 * What a launch REQUIRES of Mission MCP - stated as capabilities, never as argv.
 *
 * A caller says which of our tools the session it is launching has to be able to call;
 * this module decides what that costs in each harness's launch grammar. The alternative -
 * letting a caller hand down flags - would put the packaged-path, runtime and server-name
 * decisions back into every caller, which is the drift this module exists to remove.
 */
export interface MissionMcpRequirement {
  tools: readonly MissionMcpTool[];
}

/**
 * What each KIND has to be able to call, whatever its caller asked for.
 *
 * A scout has to be able to call `submit_scout_artifacts`, because that is the only way its
 * normal task contract can reach `done` - a scout launched without it would work to a finished
 * report and then have no way to hand it over, which is the same dead end an ensemble member without
 * `submit_ensemble_result` reaches. A plan has to be able to ask its human, because
 * `request_plan_decisions` is how the plan is shown for review AND how the phased follow-up is
 * offered, and to file tasks, because scheduling the phases is what taking that follow-up
 * means. In both cases the tools are named in the prompt the daemon composes, and a prompt
 * naming a tool the launch did not pre-approve produces an agent that stops on a permission
 * prompt - which reads as an agent that simply sat there.
 *
 * `Record<TaskKind, …>` rather than a chain of comparisons, matching `KIND_CONTRACT` in
 * `task-contract.ts`: a new kind does not compile until it has said what its launch needs,
 * including saying it needs nothing. `ship` is that empty case and it is not a placeholder -
 * it is the reason every existing dispatch's argv is unchanged.
 */
const KIND_MISSION_MCP_TOOLS: Record<TaskKind, readonly MissionMcpTool[]> = {
  ship: [],
  scout: [SUBMIT_SCOUT_ARTIFACTS_TOOL],
  plan: [PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL],
  pipeline: [],
  chat: [],
};

/**
 * The requirement a task's KIND imposes, unioned with whatever its caller asked for.
 *
 * Derived from the durable `Task.kind` here, once, rather than left to whichever caller
 * happened to dispatch it: the backlog autopilot, the manual launch, a schedule, and a retry
 * must all produce the same launch.
 *
 * A kind with no requirement of its own gets its caller's requirement back UNCHANGED - the
 * same object, `null` included - so every existing ship dispatch's argv stays byte-identical.
 */
export function kindMissionMcpRequirement(
  task: Pick<Task, "kind" | "workflowId">,
  requested: MissionMcpRequirement | null,
  workflowEvidence = false,
): MissionMcpRequirement | null {
  const required = KIND_MISSION_MCP_TOOLS[task.kind];
  if (required.length === 0 && !workflowEvidence) return requested;
  const tools = new Set<MissionMcpTool>(requested?.tools ?? []);
  for (const tool of required) tools.add(tool);
  if (workflowEvidence) tools.add(SUBMIT_WORKFLOW_EVIDENCE_TOOL);
  return { tools: [...tools] };
}

/**
 * One resolved way to launch the bundled MCP server: a runtime, its argv, and the env
 * that runtime needs.
 *
 * The daemon runs either under a real `node` (dev, `npm start`) or inside an Electron
 * `utilityProcess`, where `process.execPath` is the Electron binary and needs
 * `ELECTRON_RUN_AS_NODE=1` to behave like node. Same problem `integrations.ts` solves for
 * `claude mcp add`, solved the same way and for the same reason: the agent launches this
 * bundle as an EXTERNAL process, so it needs a concrete, absolute runtime rather than
 * whatever happens to be on the spawned shell's PATH.
 */
export interface MissionMcpDescriptor {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface MissionMcpRuntime {
  command: string;
  env: NodeJS.ProcessEnv;
}

type LocateNodeRuntime = () => Promise<{ path: string; env: NodeJS.ProcessEnv } | null>;

export async function resolveMissionMcpRuntime(
  execPath: string,
  locateNode: LocateNodeRuntime = async () => await locateExecutable("node"),
): Promise<MissionMcpRuntime> {
  if (/^node(\.exe)?$/.test(basename(execPath))) return { command: execPath, env: {} };
  const found = await locateNode();
  if (found) return { command: found.path, env: found.env };
  return { command: execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Resolved once per daemon lifetime - it cannot change while we run, and it may shell out. */
let cachedRuntime: MissionMcpRuntime | undefined;

async function resolveRuntime(): Promise<MissionMcpRuntime> {
  if (cachedRuntime) return cachedRuntime;
  return (cachedRuntime = await resolveMissionMcpRuntime(process.execPath));
}

/**
 * The dashboard client that owns this daemon launch, before the MCP server becomes a
 * separate Node process and loses Electron's version marker.
 */
export function missionMcpProductIssueClient(
  electronVersion: string | undefined,
): ProductIssueClient {
  return electronVersion ? "electron" : "browser";
}

/**
 * How to launch our MCP server on this machine, or NULL when it cannot be launched at all.
 *
 * Null means the bundle is not on disk (`npm run build` never ran, or a packaged build
 * resolved somewhere unexpected). It is returned rather than thrown because every caller's
 * correct response is to leave the launch alone: a dispatched session without our MCP
 * server is the status quo, whereas a dispatch that FAILS because a bundle is missing is a
 * session that would otherwise have launched fine. Callers say out loud what the absence
 * costs them - the sentences differ per harness - so this stays quiet.
 *
 * `mcpServerPath()` is the one resolver, and it lives in `config.ts` for the packaged-build
 * reason documented there; do not re-derive the path here.
 */
export async function missionMcpDescriptor(
  cwd?: string,
  stateHome?: string,
): Promise<MissionMcpDescriptor | null> {
  const server = mcpServerPath();
  if (!existsSync(server)) return null;
  const runtime = await resolveRuntime();
  return {
    serverName: MISSION_MCP_SERVER_NAME,
    command: runtime.command,
    args: [server],
    // Codex treats an explicit `mcp_servers.<name>.env` table as the MCP process's whole
    // routing environment. Publish the loopback port and bearer explicitly, but point normal
    // state resolution at a disposable home. The MCP child can reach the daemon without
    // learning or opening the directory that contains its database.
    env: {
      ...agentSubprocessEnv(runtime.env, { loopbackAccess: true, cwd, stateHome }),
      [PRODUCT_ISSUE_CLIENT_ENV]: missionMcpProductIssueClient(process.versions.electron),
    },
  };
}

/** Mint the bearer capability known only to one managed Pipeline host's MCP child. */
export function newPipelineCallerCredential(): string {
  return randomBytes(32).toString("base64url");
}

/** Clone one registration with the identity and capability issued to a managed Pipeline host. */
export function missionMcpDescriptorForPipelineTask(
  descriptor: MissionMcpDescriptor | null,
  callerCredential: string,
  launchStateHome?: string,
): MissionMcpDescriptor | null {
  if (!descriptor) return null;
  const stateHome = launchStateHome ?? descriptor.env.MISSION_HOME;
  if (!stateHome) throw new Error("managed Pipeline MCP registration has no private state home");
  const credentialPath = join(
    stateHome,
    `pipeline-caller-${randomBytes(12).toString("hex")}.json`,
  );
  writeFileSync(
    credentialPath,
    JSON.stringify({
      credential: callerCredential,
      expiresAt: Date.now() + PIPELINE_CALLER_CREDENTIAL_TTL_MS,
    }),
    { mode: 0o600, flag: "wx" },
  );
  return {
    ...descriptor,
    args: [...descriptor.args],
    env: {
      ...descriptor.env,
      [PIPELINE_CALLER_CREDENTIAL_FILE_ENV]: credentialPath,
    },
  };
}

// ---- does the resolved bundle actually PUBLISH what a launch declares? ----------------
//
// Every other guard in this file, in `dispatcher.ts` and in `tasks.ts` asks whether the
// bundle EXISTS. None of them asks what is inside it, and that gap is a live failure rather
// than a theoretical one:
//
//   The daemon runs from SOURCE under `tsx watch`, but hands every dispatched agent a BUILD
//   artifact - `mcpServerPath()` resolves `dist/mcp/server.mjs`. `build:mcp` runs only under
//   `npm run build` and `dist/` is gitignored, so the bundle goes stale BY DESIGN and a
//   `git pull` never refreshes it. Observed on an operator's machine: a `dist/mcp/server.mjs`
//   built 2026-08-06 containing zero occurrences of `submit_scout_artifacts`, which landed in
//   source 2026-08-12. The other seven tools were present. Live agents were running those
//   bytes.
//
// The consequence is the worst shape a bug can take here. A scout's prompt tells it to call
// `submit_scout_artifacts` and its normal completion cannot reach `done` until it does, but the
// tool is simply absent from the toolbox it was handed - so the agent works to a finished report and
// then has nowhere to put it. No error, no warning, no red test. `MISSION_MCP_TOOLS` cannot
// see it either: that list is a CLIENT-side pre-approval, never read by the server, which is
// exactly the hazard `scouts/submission-tool.ts` already names - "a launch that pre-approves
// a tool the server never registered pre-approves nothing at all". The two drift tests in
// `mission-mcp.test.ts` regex-scrape `registerTool(` out of SOURCE, so they agree with the
// source and learn nothing about the bytes on disk.
//
// So this asks the only question that settles it: it runs a real MCP `initialize` +
// `tools/list` against the bundle we are about to register and reads back the names the
// RUNNING SERVER publishes. That is the same answer the agent's own MCP client will get,
// obtained the same way, before the agent spawns instead of an hour into its task.
//
// ---- why not resolve the MCP server from SOURCE under `tsx watch`? -------------------
//
// It was considered, because it would delete this entire failure class in dev, and REJECTED.
// Three reasons, in order of weight:
//
// 1. It does not fix the failure class, only its dev instance. A packaged install can carry a
//    stale or partial `dist/` too - an interrupted `npm run build`, an `electron-builder` copy
//    that raced, a `dist/` restored from an older archive - and source resolution has nothing
//    to say about any of them. A guard that reads the running bundle's own `tools/list` covers
//    every cause at once, including the ones nobody has thought of yet.
// 2. It would make dev the ONE configuration that never runs the artifact we ship.
//    `scripts/smoke-bundles.mjs` exists because a bundle can fail in ways its source cannot -
//    the `jsonc-parser` UMD/dynamic-require defect that crash-looped a packaged app 18,052
//    times while every gate stayed green. Point the dev daemon at `src/mcp/server.ts` and the
//    first person to observe any future bundling defect in this server is an operator running
//    a packaged build.
// 3. The agent, not the daemon, spawns this server, once per session, and keeps it for the
//    life of that session. A registration pointing at TypeScript makes a live agent's toolbox
//    depend on a source file being loadable at whatever instant its client happens to start -
//    so a half-saved edit takes the tools away from a session mid-task, for a reason no
//    operator would ever connect to the file they just saved. A built bundle is immutable
//    between builds, which is precisely the property a launch-scoped registration wants.
//
// The residue - that an operator who has not rebuilt cannot dispatch a scout - is intended.
// It is a loud, immediate, actionable refusal naming `npm run build`, in place of a task that
// silently cannot finish.

/** Long enough for a cold ESM load of a ~740KB bundle on a slow machine, bounded so a bundle that hangs cannot hang a dispatch. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** A runaway `nextCursor` loop is a broken server, not a big toolbox. */
const MAX_TOOL_PAGES = 20;

/**
 * The most stdout we will hold while still waiting for a newline.
 *
 * MCP's stdio framing is line-delimited JSON, so an unterminated line is the only part of the
 * stream that accumulates - and a bundle in a log loop can produce one as fast as the pipe
 * allows. The 15-second timeout bounds how long we listen; it does nothing about how many bytes
 * arrive in that time, which is a daemon-sized heap on a machine whose control plane this is.
 * Measured rather than guessed: this server's real `tools/list` is 9,082 bytes for eight tools,
 * so a megabyte is about a hundredfold headroom.
 */
const MAX_STDOUT_FRAME_BYTES = 1_048_576;

/**
 * How long a probed bundle gets to honour `SIGTERM` before it is killed outright.
 *
 * `SIGTERM` is a request, and a bundle broken enough to need this guard is exactly the kind
 * that ignores one. Long enough for a healthy server to close its stdio and exit; short enough
 * that a wedged one cannot outlive the dispatch that probed it.
 */
const KILL_GRACE_MS = 2_000;

/**
 * The protocol version this probe speaks.
 *
 * A server supporting a different revision answers with ITS version rather than an error (the
 * spec requires that), and we do not care what it picks - `tools/list` is in every revision.
 */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** What a real `tools/list` said, or why we could not get one. */
type PublishedTools =
  | { ok: true; tools: ReadonlySet<string> }
  | { ok: false; reason: string };

/**
 * The handshake result for ONE bundle, keyed by that bundle's identity on disk.
 *
 * Cached beside `cachedRuntime` and for its reason: this shells out, and a dispatch must not
 * pay for it. An unchanged bundle handshakes exactly once, and every later dispatch reads the
 * answer for free - measured at 104ms for the first and 0ms across the next fifty.
 *
 * ---- a DELIBERATE revision of the requirement, decided rather than drifted into ----
 *
 * This change was specified as "cache the result once per daemon lifetime ... so this costs one
 * handshake, not one per dispatch". Keying by path + mtime + size instead means a REBUILD costs
 * one more handshake, which is a literal departure from that wording. It was put to the human
 * who set the requirement and kept on their decision; it is recorded here so the next reader
 * finds a choice rather than a bug.
 *
 * What the wording would have cost, and why the intent survives the change: `npm run build`
 * does not touch `src/`, so it does NOT restart a `tsx watch` daemon. A cache held for the
 * daemon's lifetime therefore outlives the bundle it describes, and it does so in both
 * directions:
 *
 *   - A cached REFUSAL survives the rebuild that fixed it. The operator does exactly the right
 *     thing, is refused again, and nothing tells them a daemon restart is the missing step.
 *   - A cached SUCCESS survives a rebuild that BROKE the bundle - an older branch checked out
 *     and rebuilt, say - so launches are admitted against a server that no longer publishes the
 *     tool. That is the silent scout deadlock this entire module exists to remove, reintroduced
 *     by its own cache.
 *
 * The requirement's stated purpose - "not one per dispatch" - is fully met either way; the cost
 * of the difference is one 104ms handshake per build. The second failure above is not a
 * usability wrinkle but a correctness hole, and no amount of caching should be able to make the
 * guard answer for a file that is no longer there.
 */
let cachedPublished: { key: string; answer: Promise<PublishedTools> } | undefined;

/** What makes one build of the bundle distinguishable from the next. */
function bundleIdentity(path: string): string {
  try {
    const s = statSync(path);
    return `${path}:${s.mtimeMs}:${s.size}`;
  } catch {
    // Unreadable is its own identity - the handshake below will fail and say why.
    return `${path}:missing`;
  }
}

/** When the bundle was last written, or null when it cannot be read. */
function bundleWrittenAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * That the child said something on stderr, and NEVER a word of what it said.
 *
 * `reason` does not stay in this process. A dispatch persists it as the task's `error` - into
 * SQLite, onto the task card, into whatever a human copies out of it - and the startup check
 * prints it to the daemon log. The bundle we probe inherits this daemon's whole environment
 * and reads a harness token and a scout submission credential of its own, so a server that
 * logged any of that on its way down would have had it copied straight through into durable,
 * user-visible state by a probe that exists to make dispatch SAFER.
 *
 * Child output is untrusted for this purpose, and no redaction pass is trustworthy enough to
 * make it safe - a denylist cannot know the shape of every secret a future dependency might
 * print. So the content is dropped at the boundary rather than filtered after it.
 *
 * The byte count survives because it is the one thing a reader actually needs from stderr
 * here: it separates "the bundle died silently" from "the bundle explained itself and we are
 * not repeating it", which points at reproducing the spawn by hand. Every one of these
 * failures has the same fix anyway, and `reason` already names it.
 */
function saidOnStderr(bytes: number): string {
  return bytes > 0 ? ` (it wrote ${bytes} bytes to stderr, not repeated here)` : "";
}

/**
 * Speak MCP to the bundle and return the tool names it publishes.
 *
 * Hand-rolled rather than driven through `@modelcontextprotocol/sdk`'s client: the whole point
 * is to exercise the bundle the way an arbitrary MCP client will, and the one thing we must not
 * do is prove the bundle works by using the same library that produced it. It is also two
 * requests over newline-delimited JSON, which is the entirety of MCP's stdio framing.
 *
 * Never throws. Every failure - a runtime that will not start, a server that dies on load, a
 * malformed answer, a hang - comes back as `{ ok: false, reason }` so the caller decides what a
 * launch does about it.
 */
async function handshake(descriptor: MissionMcpDescriptor): Promise<PublishedTools> {
  return await new Promise<PublishedTools>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(descriptor.command, descriptor.args, {
        stdio: ["pipe", "pipe", "pipe"],
        // The descriptor's env is an OVERLAY on the inherited environment, which is how
        // Claude and Codex both apply an `env` block. Probing with a bare `descriptor.env`
        // would strip PATH and HOME and fail for a reason the real launch never hits.
        env: { ...executableChildEnv(), ...descriptor.env },
      });
    } catch (err) {
      resolve({ ok: false, reason: `it could not be started (${errText(err)})` });
      return;
    }

    const found = new Set<string>();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    // The UNTERMINATED remainder of stdout, never the whole stream: complete lines are parsed
    // and dropped as they arrive, so this only grows while a line is still missing its newline.
    let pending = "";
    // A COUNT, never the bytes. See `saidOnStderr` for why none of it is kept.
    let stderrBytes = 0;
    let pages = 0;
    let listId = 2;

    /**
     * Stop listening to the child, then make sure it is actually gone.
     *
     * `SIGTERM` is a REQUEST, and the bundles this probe exists to catch are exactly the ones
     * least likely to honour it - a server wedged in a loop, or one that traps the signal, sails
     * straight past it. Sending it and resolving would leave a process alive with our stdio
     * listeners still attached, burning CPU and holding this closure open, and every rebuilt
     * bundle identity we probed afterwards would add another one. A guard against a broken
     * bundle must not be a way for a broken bundle to accumulate daemons' worth of children.
     *
     * Detach BEFORE signalling: once the answer is decided nothing the child says can change
     * it, and a survivor must not go on filling buffers we already stopped reading. An error
     * sink stays attached through the destroy, because `destroy()` and a racing EPIPE both emit
     * `error`, and an `error` with no listener is an uncaught exception - the daemon-killing
     * shape this file already had to close once.
     *
     * Then SIGTERM, and SIGKILL after a grace period if it is still there. The grace timer is
     * `unref`'d so a slow death can never hold the daemon's event loop open, and the child is
     * `unref`'d for the same reason.
     */
    const reap = (): void => {
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        stream?.removeAllListeners("data");
        stream?.on("error", () => {});
        stream?.destroy();
      }
      pending = "";
      // Already exited: `kill` would be a no-op, and there is nothing to escalate against.
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      grace.unref?.();
      child.unref();
    };

    const finish = (answer: PublishedTools): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // The probe owns this process and nothing else may inherit it.
      reap();
      resolve(answer);
    };

    const send = (msg: unknown): void => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch (err) {
        finish({ ok: false, reason: `its stdin closed mid-handshake (${errText(err)})` });
      }
    };

    const requestTools = (cursor?: string): void => {
      pages += 1;
      send({
        jsonrpc: "2.0",
        id: listId,
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      });
    };

    const onMessage = (msg: Record<string, unknown>): void => {
      const error = msg.error as { message?: string } | undefined;
      const result = msg.result as
        | { tools?: unknown; nextCursor?: unknown }
        | undefined;
      if (msg.id === 1) {
        if (error) {
          finish({ ok: false, reason: `it refused initialize (${error.message ?? "no message"})` });
          return;
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        requestTools();
        return;
      }
      if (msg.id !== listId) return; // A notification, or an answer we did not ask for.
      if (error) {
        finish({ ok: false, reason: `it refused tools/list (${error.message ?? "no message"})` });
        return;
      }
      if (!Array.isArray(result?.tools)) {
        finish({ ok: false, reason: "its tools/list answer carried no tool array" });
        return;
      }
      for (const tool of result.tools) {
        const name = (tool as { name?: unknown } | null)?.name;
        if (typeof name === "string") found.add(name);
      }
      // Paginated on purpose. The SDK answers in one page today, but a server that grows a
      // cursor would otherwise start reporting its later tools as missing - a false refusal,
      // which is the one failure this guard must never invent.
      const cursor = result.nextCursor;
      if (typeof cursor === "string" && cursor !== "" && pages < MAX_TOOL_PAGES) {
        listId += 1;
        requestTools(cursor);
        return;
      }
      finish({ ok: true, tools: found });
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        reason:
          `it did not answer initialize + tools/list within ${HANDSHAKE_TIMEOUT_MS}ms` +
          saidOnStderr(stderrBytes),
      });
    }, HANDSHAKE_TIMEOUT_MS);
    // Never hold the daemon's event loop open on a probe.
    timer.unref?.();

    child.on("error", (err) => {
      finish({ ok: false, reason: `it could not be started (${errText(err)})` });
    });
    // A bundle that dies on load - the exact `jsonc-parser` shape this repo has already
    // shipped once - closes its stdin under our first write, and an EPIPE on a stream with no
    // `error` listener is an UNCAUGHT exception, which would take the daemon down. A probe
    // whose whole job is to make a stale bundle safe must not be a new way to crash on one.
    child.stdin?.on("error", (err) => {
      finish({ ok: false, reason: `its stdin closed mid-handshake (${errText(err)})` });
    });
    child.on("exit", (code, signal) => {
      finish({
        ok: false,
        reason:
          `it exited (code ${code}, signal ${signal}) during the handshake` +
          saidOnStderr(stderrBytes),
      });
    });
    // Counted and discarded chunk by chunk. Holding it would be both a leak (see
    // `saidOnStderr`) and a way for a bundle stuck in a log loop to grow the daemon's heap for
    // the whole timeout - the clock bounds how long we listen, never how much arrives.
    child.stderr?.on("data", (d: Buffer | string) => {
      stderrBytes += typeof d === "string" ? Buffer.byteLength(d, "utf8") : d.length;
    });
    child.stdout?.on("data", (d) => {
      pending += String(d);
      // A single line that never ends is the one thing that can grow without limit here, and a
      // broken or hostile bundle can produce one as fast as the pipe allows. Refuse it at a
      // bound instead: the real `tools/list` for this server's eight tools measures 9,082
      // bytes, so a megabyte is roughly a hundredfold headroom - far past any honest answer,
      // and far below anything that troubles the daemon.
      if (pending.length > MAX_STDOUT_FRAME_BYTES) {
        finish({
          ok: false,
          reason:
            `it wrote more than ${MAX_STDOUT_FRAME_BYTES} bytes of stdout with no newline, ` +
            `so it is not speaking MCP's line-delimited JSON`,
        });
        pending = "";
        return;
      }
      for (;;) {
        const nl = pending.indexOf("\n");
        if (nl === -1) break;
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // Tolerate a banner or a stray log line on stdout.
        }
        onMessage(msg);
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mission-control-launch-guard", version: "1" },
      },
    });
  });
}

/** The published tool names for the bundle we would register right now, handshaking at most once per build. */
async function publishedTools(descriptor: MissionMcpDescriptor): Promise<PublishedTools> {
  const key = bundleIdentity(descriptor.args[0] ?? "");
  if (cachedPublished?.key === key) return await cachedPublished.answer;
  const answer = handshake(descriptor);
  cachedPublished = { key, answer };
  return await answer;
}

/** Whether the bundle a launch is about to register can actually serve what that launch declares. */
export type MissionMcpToolCheck = { ok: true } | { ok: false; reason: string };

/**
 * Assert that every tool a launch DECLARES is one the resolved bundle actually publishes.
 *
 * Called before the agent spawns, so the answer can still change the outcome. The failure it
 * prevents is not a crash but a deadlock: a scout that cannot call `submit_scout_artifacts`
 * has no way to reach `done`, and an ensemble member that cannot call `submit_ensemble_result`
 * runs to completion and then cannot signal it is ready. Both look like an agent that simply
 * stopped.
 *
 * A bundle we cannot interrogate at all fails exactly like a bundle missing the tool, and that
 * is not caution - a server that will not complete a handshake for US will not complete one for
 * the agent's MCP client either, so the tool is just as absent. The two cases carry different
 * sentences because they have different fixes.
 *
 * `reason` is written to be pasted into a task's error and understood without reading this file.
 */
export async function verifyMissionMcpTools(
  required: readonly MissionMcpTool[],
  /**
   * The exact registration to interrogate, when the caller is holding one.
   *
   * An embedded launch hands the supervisor a descriptor it already resolved, and verifying a
   * SECOND resolution of it would be checking a different object than the one the session gets.
   * A terminal launch has no such handle - its registration was rendered into argv inside
   * `askChannelArgs` / `prepareCodexLaunch` - so it omits this and we resolve the same way
   * those two do, which is the only reading that matches what was actually registered.
   */
  launched?: MissionMcpDescriptor | null,
): Promise<MissionMcpToolCheck> {
  // An empty requirement is not a weak check, it is the absence of one: a dispatch that
  // declares no Mission tools is the status quo this must not touch, so it never spawns
  // anything and never fails a launch that would have worked.
  if (required.length === 0) return { ok: true };
  const ownsDescriptor = launched == null;
  const descriptor = launched ?? (await missionMcpDescriptor());
  try {
    if (!descriptor) {
      return {
        ok: false,
        reason: `Mission Control's MCP server is not built at ${mcpServerPath()} - run: npm run build`,
      };
    }
    const published = await publishedTools(descriptor);
    if (!published.ok) {
      return {
        ok: false,
        reason:
          `Mission Control's MCP server at ${descriptor.args[0]} could not be interrogated: ` +
          `${published.reason}. Rebuild it with: npm run build`,
      };
    }
    const missing = required.filter((tool) => !published.tools.has(tool));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      reason:
        `Mission Control's MCP server at ${descriptor.args[0]} does not publish ` +
        `${missing.join(", ")} (it publishes ${[...published.tools].sort().join(", ") || "nothing"}). ` +
        `The built bundle is stale - it is only rebuilt by \`npm run build\`, which a git pull does ` +
        `not do. Run: npm run build`,
    };
  } finally {
    if (ownsDescriptor) cleanupAgentSubprocessEnv(descriptor?.env);
  }
}

/**
 * The same question asked of an agent that is ALREADY RUNNING, which is a different question.
 *
 * `verifyMissionMcpTools` interrogates the bundle on disk, and for a launch that is the right
 * reading - the agent is about to spawn and its MCP client will load exactly that file. For an
 * assignment it is NOT: the target session started earlier and its MCP server is a child it
 * spawned back then, holding whatever the file contained at that moment. Rebuild the bundle
 * afterwards and the file on disk answers beautifully while the running child still cannot call
 * the tool - so a probe of the file would wave through an assignment that resets the agent's
 * checkout for a task it still cannot submit. That is the exact failure this whole change
 * exists to prevent, reintroduced one path over.
 *
 * We cannot interrogate that child; nothing here can. What we CAN establish is whether the file
 * we are allowed to interrogate is the same file it loaded, and mtime against the session's
 * start settles it: a bundle written before the agent started is the bundle the agent is
 * running, so the handshake speaks for the child. A bundle written after it is a different
 * build, and the honest answer is that this session has to be restarted to pick it up.
 *
 * An unknown `startedAt` cannot order the two. That falls back to the disk check rather than
 * refusing: a backend that could not report a process start is not evidence of a stale bundle,
 * and grounding every assignment on one would trade a rare, narrow hole for a broken workflow.
 * It is the status quo that shipped before this guard existed, and strictly better than it.
 */
export async function verifyMissionMcpToolsForRunningSession(
  required: readonly MissionMcpTool[],
  /** Process start for a terminal session, registration time for an SDK one. */
  startedAt: number | null,
  launched?: MissionMcpDescriptor | null,
): Promise<MissionMcpToolCheck> {
  if (required.length === 0) return { ok: true };
  const ownsDescriptor = launched == null;
  const descriptor = launched ?? (await missionMcpDescriptor());
  try {
    const written = descriptor ? bundleWrittenAt(descriptor.args[0] ?? "") : null;
    if (descriptor && written !== null && startedAt !== null && written > startedAt) {
      return {
        ok: false,
        reason:
          `Mission Control's MCP server at ${descriptor.args[0]} was rebuilt after this agent ` +
          `started, so the agent is still running the previous build and this cannot establish ` +
          `which tools it actually has. Restart the session so it picks up the current bundle`,
      };
    }
    return await verifyMissionMcpTools(required, descriptor);
  } finally {
    if (ownsDescriptor) cleanupAgentSubprocessEnv(descriptor?.env);
  }
}

/**
 * Every tool this build's SOURCE says should exist, checked against the running bundle - the
 * daemon's own startup signal.
 *
 * Distinct from `verifyMissionMcpTools` in what it asks: that one asks whether ONE launch can
 * go ahead, this one asks whether the operator's machine is in a state where scouts and
 * ensembles will work at all, and says so at boot instead of at the first dispatch that trips
 * over it. It also warms the cache, so that first dispatch pays nothing.
 *
 * A CONTENT check rather than the obvious mtime comparison of the bundle against `src/mcp/` and
 * `src/shared/`. Mtime was tried on paper and rejected: `src/shared/` changes on almost every
 * commit in this repo, so a bundle that is behind by one irrelevant shared-module edit would
 * warn identically to one missing a tool, on nearly every dev iteration - and a warning that
 * fires constantly is a warning nobody reads by the time it is true. This asks the question the
 * operator actually cares about, and answers it with no false alarms and nothing to tune. It is
 * also silent by construction on a packaged install, where there is no `src/` to compare against
 * and the bundle is published by the same step that built it.
 */
export async function reportMissionMcpDrift(): Promise<void> {
  const check = await verifyMissionMcpTools(MISSION_MCP_TOOLS);
  if (check.ok) return;
  console.warn(
    `[mission-control] ${check.reason}\n` +
      `[mission-control]   Until then, dispatching a scout or an ensemble member that needs a ` +
      `missing tool is REFUSED rather than left to deadlock.`,
  );
}

// ---- Claude: a launch-scoped `--mcp-config` file -------------------------------------

/**
 * The subdirectory holding the one file the spawn argv points at.
 *
 * Still spelled `ask-channel` after the serialization moved here, and deliberately: this
 * path is what an installed copy's `--mcp-config` already points at, and renaming it would
 * orphan that file on every machine rather than migrate it. The file is Claude's launch
 * grammar; its CONTENT is this module's.
 */
const CONFIG_DIR = join(STATE_DIR, "ask-channel");
const CONFIG_PATH = join(CONFIG_DIR, "mcp.json");

/** The paths the argv points at - for tests and for anyone debugging a dispatched session. */
export const missionMcpPaths = { dir: CONFIG_DIR, config: CONFIG_PATH };

/** The exact bytes of Claude's launch-scoped MCP config for this descriptor. */
export function missionMcpConfigJson(descriptor: MissionMcpDescriptor): string {
  return JSON.stringify(
    {
      mcpServers: {
        [descriptor.serverName]: {
          command: descriptor.command,
          args: descriptor.args,
          env: descriptor.env,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Write `file` only when its content would change, and ATOMICALLY when it does.
 *
 * The skip is an optimisation; the atomicity is not. This path is what the spawn argv
 * points at, so a plain `writeFileSync` over it can be read half-written by a `claude` that
 * a concurrent dispatch started moments earlier. A truncated `mcp.json` means no
 * `request_input` while `--disallowed-tools` still applies - arm B exactly, the one state
 * the ask channel exists to prevent. Temp file in the SAME directory (so the rename cannot
 * cross a filesystem) then `renameSync`, which is atomic: a reader sees the old file or the
 * new one.
 */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // Missing or unreadable: fall through and write it.
  }
  // Unique per writer, so two dispatches racing cannot share a temp file and interleave.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort - the throw below is what the caller acts on.
    }
    throw err;
  }
}

/**
 * Serialize the descriptor to Claude's config file and return the argv that points at it.
 *
 * Throws on a filesystem failure rather than returning a half-registration: the caller
 * (`askChannelArgs`) turns that into "no ask channel at all", which is the only safe
 * direction - see its own doc comment.
 */
export function claudeMissionMcpArgs(descriptor: MissionMcpDescriptor): string[] {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeIfChanged(CONFIG_PATH, missionMcpConfigJson(descriptor));
  return ["--mcp-config", CONFIG_PATH];
}

// ---- Codex: launch-scoped `-c mcp_servers.*` TOML overrides ---------------------------

/**
 * One TOML value, encoded so Codex's config parser reads back exactly the string we meant.
 *
 * `JSON.stringify` IS a TOML basic-string encoder for the characters an absolute path can
 * carry: TOML basic strings use the same `\"`, `\\` and `\uXXXX` escapes JSON does. The
 * same trick is already load-bearing one file over in `codexHookOverride`.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Register our MCP server on ONE Codex launch, as three `-c` overrides.
 *
 * Launch-scoped for the same reason Codex's hooks are (see `prepareCodexLaunch`): we only
 * reconfigure sessions WE start. Whatever `codex mcp add` wrote into `~/.codex/config.toml`
 * is untouched, and this composes with it rather than replacing it - a dotted `-c` override
 * merges into the loaded config, so an operator's other servers survive.
 *
 * All three keys together or none. A `command` with no `args` points Codex at a runtime
 * with nothing to run, and a registration missing its `env` launches an Electron binary
 * that is not in node mode - both are servers that appear registered, fail to start, and
 * leave the agent believing a tool exists that it can never call. `env` is emitted even
 * when empty, because an empty inline table is a statement ("this runtime needs nothing")
 * rather than an omission.
 *
 * Probed against codex-cli 0.145.0: `codex mcp list --json` with exactly these overrides
 * reports the server with the command, args and env round-tripped byte-for-byte, including
 * paths carrying spaces and single quotes, and including `env={}`.
 */
export function codexMissionMcpArgs(descriptor: MissionMcpDescriptor): string[] {
  const key = `mcp_servers.${descriptor.serverName}`;
  const args = descriptor.args.map(tomlString).join(",");
  const env = Object.entries(descriptor.env)
    .map(([name, value]) => `${tomlString(name)}=${tomlString(value)}`)
    .join(",");
  return [
    "-c", `${key}.command=${tomlString(descriptor.command)}`,
    "-c", `${key}.args=[${args}]`,
    "-c", `${key}.env={${env}}`,
  ];
}
