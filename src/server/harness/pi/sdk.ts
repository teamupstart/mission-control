import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { SdkSendDisposition, ThinkingLevel } from "@shared/types.ts";
import { opensPullRequest, pullRequestUrlsIn } from "@shared/pr-command.mjs";
import { EventStream } from "../../sdk/event-stream.ts";
import type {
  SdkEvent,
  SdkLaunchOptions,
  SdkSessionHandle,
  SdkSpec,
  SdkTurn,
  SdkUsage,
} from "../types.ts";
import { defaultPiSdkDeps } from "./sdk-deps.ts";
import { PiSdkError, classifyPiFailure, redact } from "./sdk-errors.ts";
import type {
  PiAssistantSummary,
  PiImage,
  PiModelRef,
  PiRuntime,
  PiSdk,
  PiSdkDeps,
  PiSession,
  PiSessionEvent,
  PiStreamingBehavior,
  PiThinkingLevel,
} from "./sdk-types.ts";

// Pi, driven MANAGED - `@earendil-works/pi-coding-agent`'s own session runtime behind
// `SdkSpec`. The third driver, and the first one with no subprocess at all.
//
// ## What this module is allowed to know
//
// The Pi vocabulary stops at `sdk-types.ts`. Everything above speaks `SdkEvent`, and the
// READ path is untouched: Pi's `SessionManager` writes the same
// `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl` a pane-backed session writes, so
// `piTranscript.locate`, `piMessages` and `piPassiveRead` go on working with no arm of
// their own - and `pi --session <id>` reopens the very conversation this driver created,
// which is what makes "continue in terminal" a handoff rather than a fork.
//
// ## What it deliberately does NOT do (Phase 1)
//
// No Mission MCP (Pi has no MCP client), no multi-repository write grant (Pi declares
// `multiRepoDispatch: null`, so nothing may claim one), no permission modes, and no
// structured extension questions - Pi's `ExtensionUIContext` bridge is Phase 2. Each of
// those is REFUSED rather than silently dropped, because a launch that quietly ignores
// what it was handed is the card that looks dispatched and is running something else.
// See `docs/plans/pi-bedrock-models/phase-1-managed-pi-bedrock-runtime.md`.

/** What a card shows while Pi is between an LLM response and its next request. */
const ACTIVITY_RESPONDING = "responding";

/** Bytes of a tool argument that reach a card's activity line. */
const ACTIVITY_ARG_CAP = 80;

/** Image extensions Pi's providers accept, mapped to what a provider is told they are. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Split a Mission Control model id into the pair Pi's `ModelRuntime` asks for.
 *
 * EXACTLY ONCE, at the FIRST `/`, and the original string is never rewritten: Pi's catalog
 * emits ids whose model half contains slashes of its own (`openrouter/anthropic/claude…`),
 * so splitting on the last separator - or on every one - renames the model. Mission Control
 * stores, dispatches, and displays `amazon-bedrock/deepseek.v3.2` verbatim; this pair
 * exists only for the duration of one catalog lookup.
 *
 * Null for an id with no provider half at all, which Pi cannot resolve: its own catalog
 * always qualifies, so a bare id is a stored value from somewhere else and must fail
 * rather than be guessed at.
 */
export function splitPiModelId(id: string): PiModelRef | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) return null;
  return { provider: id.slice(0, at), id: id.slice(at + 1) };
}

/**
 * The app's effort level in Pi's vocabulary.
 *
 * `THINKING_LEVELS` is a strict subset of Pi's seven, so this is a widening rather than a
 * translation - and null stays null, meaning "let Pi's own configured default stand".
 * `off` and `minimal` can only ever arrive FROM Pi; nothing here can request them.
 */
export function piThinkingLevel(effort: ThinkingLevel | null): PiThinkingLevel | null {
  return effort;
}

/** A short, bounded description of what Pi is doing right now. */
export function toolActivity(toolName: string, command: string | null): string {
  if (!command) return toolName;
  const clipped = command.replace(/\s+/g, " ").trim();
  const shown =
    clipped.length > ACTIVITY_ARG_CAP ? `${clipped.slice(0, ACTIVITY_ARG_CAP - 1)}…` : clipped;
  return shown ? `${toolName}: ${shown}` : toolName;
}

/** Per-turn usage from the assistant message that ended it, or null when Pi reported none. */
export function usageFrom(assistant: PiAssistantSummary | null): SdkUsage | null {
  if (!assistant?.usage) return null;
  const usage = assistant.usage;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning !== null ? { reasoningOutput: usage.reasoning } : {}),
    modelId: assistant.modelId,
    costUsd: usage.costUsd,
    // No `turnId` and no `models`, which is what keeps this OUT of the spend ledger. Those
    // two travel together or not at all (`SdkUsage`), and Pi mints no turn identity that
    // survives a restart - its session entries are renumbered per file, so a resumed
    // conversation would re-record turns it had already paid for. The flat view still
    // reaches the card's chip, which is exactly what a pane-backed Pi session shows today.
  };
}

/** Read one upload into the base64 Pi wants, or refuse it by name rather than silently. */
async function encodeImage(path: string, mediaType: string | null): Promise<PiImage> {
  const type = mediaType ?? IMAGE_MEDIA_TYPES[extname(path).toLowerCase()] ?? null;
  if (!type) throw new Error(`Pi cannot tell what kind of image ${path} is`);
  return { data: (await readFile(path)).toString("base64"), mimeType: type };
}

/**
 * One managed Pi session: one `AgentSessionRuntime`, one conversation at a time.
 *
 * Everything the supervisor can do to it is a method here; everything it learns arrives on
 * `events`. The conversation underneath is REPLACEABLE - `clearContext` swaps it - so
 * nothing in this class holds an `AgentSession`: it reaches `runtime.session` each time,
 * and re-subscribes through `onSessionReplaced`.
 */
class PiSdkSession implements SdkSessionHandle {
  private readonly out = new EventStream();
  private unsubscribe: () => void = () => {};
  private session: PiSession;
  private stopped = false;
  /** Set while `clearContext` is in flight, so the rebind knows the binding is a clear. */
  private clearing = false;
  /** The last `state` we published, so a stream of deltas does not become a stream of events. */
  private published: { state: "working" | "idle"; activity: string | null } | null = null;
  /** The newest finished assistant message, which is where a turn's usage and error live. */
  private lastAssistant: PiAssistantSummary | null = null;
  /** What Pi is doing, rebuilt as tools start and finish. */
  private activity: string | null = null;
  /** `agent_settled` count, so a delivery can tell whether ITS run produced a completion. */
  private settled = 0;
  /** Bash-shaped commands by tool call, kept until their result can be read for a PR url. */
  private readonly commands = new Map<string, string>();
  private modelId: string | null;

  constructor(
    private readonly runtime: PiRuntime,
    private config: { model: string | null; effort: ThinkingLevel | null },
  ) {
    this.session = runtime.session;
    this.modelId = this.session.modelId;
  }

  get events(): AsyncIterable<SdkEvent> {
    return this.out;
  }

  // ---- wiring, called only by `launch` -------------------------------------------------

  /**
   * Subscribe, and stay subscribed across the replacements a clear performs.
   *
   * Called BEFORE turn one is delivered, so no event of the session's first turn can be
   * emitted into a stream nobody is reading yet.
   */
  attach(): void {
    this.unsubscribe = this.session.subscribe((event) => this.onEvent(event));
    this.runtime.onSessionReplaced((session) => {
      this.unsubscribe();
      this.session = session;
      this.modelId = session.modelId;
      this.unsubscribe = session.subscribe((event) => this.onEvent(event));
      this.lastAssistant = null;
      this.activity = null;
      this.published = null;
      this.commands.clear();
      this.bind(this.clearing);
      this.clearing = false;
    });
  }

  /** Tell the daemon which Pi conversation this card is, and where its transcript is. */
  bind(cleared = false): void {
    this.out.emit({
      kind: "bound",
      agentSessionId: this.session.sessionId,
      // Reported rather than derived: Pi hands back the exact file it is about to write, so
      // `piTranscript` reads an embedded session's turns with no directory search at all.
      transcriptPath: this.session.sessionFile,
      modelId: this.modelId,
      // No subprocess exists. Pi's SDK runs inside the daemon, which is the one structural
      // difference from the other two drivers and the reason this is null rather than a pid
      // nobody could look up.
      pid: null,
      ...(cleared ? { cleared: true as const } : {}),
    });
    this.publish(this.session.idle ? "idle" : "working");
  }

  /** Turn one, awaited to its acceptance boundary so a refused intent fails the launch. */
  async seed(prompt: string): Promise<void> {
    await this.deliver({ text: prompt }, "steer");
  }

  // ---- delivery ------------------------------------------------------------------------

  /**
   * Deliver a turn, and say what Pi did with it.
   *
   * `steered` rather than `queued` when a turn is already running, because that is what Pi
   * does with the message: a steer joins the ACTIVE agent run and produces no second
   * completion, so calling it a queue would leave the supervisor holding a reservation for
   * an `agent_settled` that never comes. The same is true of Pi's `followUp`, which is why
   * this driver does not use it - both join one run, and steering is the one an operator
   * pressing Send on a busy session means.
   */
  async send(turn: SdkTurn): Promise<SdkSendDisposition> {
    this.requireLive();
    return (await this.deliver(turn, "steer")) === "steered" ? "steered" : "started";
  }

  /**
   * Start a turn only while Pi is positively idle - and deliver NOTHING otherwise.
   *
   * The behaviour is deliberately withheld rather than sent, which is the whole difference
   * from `send`. Pi reads `streamingBehavior` only when it is already streaming, so omitting
   * it makes Pi REFUSE a message that arrives into a running turn instead of queueing it -
   * and refusing is the only safe answer here: this path backs Mission Control's editable
   * outbox, which keeps the row and retries on the next confirmed idle. A driver that
   * steered the message and then reported "not delivered" would have the agent read it
   * twice.
   *
   * The pre-check is an optimization; the refusal is the guarantee.
   */
  async sendIfIdle(turn: SdkTurn): Promise<"started" | null> {
    this.requireLive();
    if (!this.session.idle) return null;
    return (await this.deliver(turn, null)) === "refused-busy" ? null : "started";
  }

  /**
   * Hand text to Pi and resolve when Pi has ACCEPTED it - not when the turn ends.
   *
   * `prompt()` resolves only when the whole turn has finished, which is far too late for a
   * caller that has to know whether the harness took the message; Pi's `preflightResult`
   * is the exact moment it did, and a preflight refusal is followed by the rejection
   * itself. That is the ack `injectPrompt` never had: no settle window, no placeholder to
   * read back, and a rejection that is positive evidence nothing landed.
   *
   * Returns whether the message STEERED a running turn, read inside the preflight callback.
   * Pi has already queued the steer by the time it fires and has not yet started the run in
   * the idle case, so the session's own streaming flag distinguishes them exactly - a check
   * before the call could be overtaken by a turn starting in between.
   */
  private async deliver(
    turn: SdkTurn,
    whenBusy: PiStreamingBehavior | null,
  ): Promise<"started" | "steered" | "refused-busy"> {
    const images = turn.images?.length
      ? await Promise.all(turn.images.map((image) => encodeImage(image.path, image.mediaType)))
      : undefined;
    const session = this.session;
    const before = this.settled;
    let steered = false;
    let accepted = false;
    let refusedBusy = false;
    await new Promise<void>((resolve, reject) => {
      const running = session
        .prompt(turn.text, {
          // Sent unconditionally on the `send` path, and harmless when Pi is idle: Pi reads
          // it only inside its own streaming branch, so passing it removes the window where a
          // turn starts between our reading of `idle` and Pi's own - which Pi answers by
          // throwing. Withheld on the `sendIfIdle` path, where that throw is the point.
          ...(whenBusy ? { streamingBehavior: whenBusy } : {}),
          ...(images ? { images } : {}),
          preflightResult: (ok) => {
            if (!ok) return;
            accepted = true;
            steered = session.streaming;
            resolve();
          },
        })
        .then(
          () => {
            // A prompt that was accepted and STARTED a run has, by the time it resolves,
            // already emitted its `agent_settled`. One that has not is a turn that ran
            // nothing - Pi dispatches a registered extension command and returns - and the
            // supervisor is holding a completion reservation for it. Retire that here rather
            // than leaving the card working for ever over a command that already finished.
            if (accepted && !steered && this.settled === before) this.completeTurn();
          },
          (err) => {
            if (!accepted) {
              // A preflight refusal while Pi is STREAMING is the withheld-behaviour refusal
              // above and nothing else: Pi's credential and model checks live in the branch
              // it takes when idle, so a busy session has only one way to say no. Reported as
              // "not delivered" rather than as an error, because that is what it is - and it
              // is what leaves the outbox row intact for the next confirmed idle.
              if (whenBusy === null && session.streaming) {
                refusedBusy = true;
                resolve();
                return;
              }
              reject(classifyPiFailure(err, this.providerOfRecord()));
              return;
            }
            // Accepted and then failed: the turn is Pi's now, and its own `agent_settled`
            // has already retired the reservation. Surface it where an operator can see it.
            this.note(classifyPiFailure(err, this.providerOfRecord()).message);
          },
        );
      void running;
    });
    if (refusedBusy) return "refused-busy";
    return steered ? "steered" : "started";
  }

  // ---- controls ------------------------------------------------------------------------

  async interrupt(): Promise<void> {
    // Nothing running is not a failure: Escape into an idle pane is a no-op too, and a
    // caller interrupting a session that just finished must not see an error for being late.
    if (this.stopped || this.session.idle) return;
    await this.session.abort();
  }

  /**
   * Pi has no permission modes at all (`permissionModes: null`), so there is nothing to
   * change and nothing to lie about. Null is the answer, not a stub.
   */
  setPermissionMode: null = null;

  setEffort = async (effort: ThinkingLevel): Promise<void> => {
    this.requireLive();
    this.session.setThinkingLevel(effort);
    this.config = { ...this.config, effort };
  };

  setModel = async (model: string): Promise<void> => {
    this.requireLive();
    const ref = splitPiModelId(model);
    if (!ref) throw new PiSdkError("model-unavailable", `"${model}" is not a Pi model id`);
    await this.session.setModel(ref);
    this.config = { ...this.config, model };
    this.modelId = this.session.modelId ?? model;
  };

  /**
   * Clear the conversation: a NEW Pi session in the same checkout, on the same card.
   *
   * The consequence is the one `/new` already has in a pane - Pi mints a new session id and
   * a new JSONL file - and it reaches the dashboard through the same door: `bound` re-fires
   * with `cleared`, and the registry's rebind moves the note, queue, goal and work episode
   * onto the new key. Pi aborts the running turn itself as part of the replacement, which
   * is what a `/clear` on a pane costs too.
   */
  clearContext = async (): Promise<void> => {
    this.requireLive();
    this.clearing = true;
    try {
      await this.runtime.newSession();
    } catch (err) {
      throw classifyPiFailure(err, this.providerOfRecord());
    } finally {
      // Cleared here as well as in the rebind, so a replacement that never arrived cannot
      // leave the NEXT ordinary binding claiming to be a clear - which would have the
      // registry move the note, queue and work episode off a conversation nobody replaced.
      this.clearing = false;
    }
  };

  /** No driver-answerable requests exist in Phase 1 - Pi's extension UI arrives in Phase 2. */
  async answer(): Promise<void> {
    throw new Error("this Pi session has no pending request to answer");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    try {
      // Aborted BEFORE disposal, because `dispose` does not: it emits Pi's shutdown event
      // and drops the session, leaving a turn that is still streaming to spend tokens
      // against a conversation nobody is looking at any more.
      await this.session.abort();
    } catch (err) {
      console.warn(`[sdk] pi could not abort before shutdown:`, err);
    }
    try {
      await this.runtime.dispose();
    } catch (err) {
      console.error(`[sdk] pi disposal failed:`, err);
    }
    this.out.emit({ kind: "exited", reason: "the session was stopped", resumable: true });
    this.out.end();
  }

  // ---- event normalization -------------------------------------------------------------

  private onEvent(event: PiSessionEvent): void {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.activity = null;
        this.publish("working");
        return;
      case "message_start":
        this.activity = ACTIVITY_RESPONDING;
        this.publish("working");
        return;
      case "message_end":
        // The FINAL of a stream whose deltas this driver never republished: Pi emits a
        // `message_update` per token, and one `state` event each would be a firehose that
        // says nothing a card can show. The final is where the turn's usage, its model and
        // its provider error actually live.
        if (event.assistant) this.lastAssistant = event.assistant;
        return;
      case "turn_end":
        this.activity = null;
        this.publish("working");
        return;
      case "tool_execution_start":
        if (event.command) this.commands.set(event.toolCallId, event.command);
        this.activity = toolActivity(event.toolName, event.command);
        this.publish("working");
        return;
      case "tool_execution_update":
        this.publish("working");
        return;
      case "tool_execution_end":
        this.notePullRequests(event.toolCallId, event.output);
        this.commands.delete(event.toolCallId);
        this.activity = null;
        this.publish("working");
        return;
      case "compaction_start":
        this.activity = `compacting context (${event.reason})`;
        this.publish("working");
        return;
      case "compaction_end":
        this.activity = null;
        if (event.errorMessage) this.note(`compaction failed: ${event.errorMessage}`);
        else this.publish("working");
        return;
      case "auto_retry_start":
        this.activity = `retrying (attempt ${event.attempt} of ${event.maxAttempts}): ${event.errorMessage}`;
        this.publish("working");
        return;
      case "auto_retry_end":
        this.activity = null;
        this.publish("working");
        return;
      case "agent_end":
        // A run that will retry is still the SAME turn. Only `agent_settled` ends one, which
        // is why the completion below hangs off that event and not this one - counting
        // `agent_end` would report a finished turn every time a provider hiccuped.
        if (!event.willRetry) this.activity = null;
        this.publish("working");
        return;
      case "agent_settled":
        this.settled += 1;
        this.completeTurn();
        return;
      case "thinking_level_changed":
        // Read back off the transcript by `piPassiveRead`, which is the one reader of a
        // session's effort. Republishing it here would be a second source for one fact.
        return;
    }
  }

  /**
   * One turn is over: report its usage, then let the card go idle.
   *
   * Exactly one of these per accepted turn, and the ordering is load-bearing - the
   * supervisor retires its completion reservation on `turn_done` and defers the idle
   * transition while any remain, so an idle emitted first would show a parked card with
   * work still outstanding.
   */
  private completeTurn(): void {
    const failure = this.lastAssistant?.errorMessage ?? null;
    if (this.lastAssistant?.modelId) this.modelId = this.lastAssistant.modelId;
    this.out.emit({ kind: "turn_done", usage: usageFrom(this.lastAssistant) });
    this.activity = failure
      ? classifyPiFailure(new Error(failure), this.providerOfRecord()).message
      : null;
    this.lastAssistant = null;
    this.publish("idle");
  }

  /** Publish a state only when it says something the last one did not. */
  private publish(state: "working" | "idle"): void {
    const next = { state, activity: this.activity };
    if (this.published && this.published.state === next.state && this.published.activity === next.activity) {
      return;
    }
    this.published = next;
    this.out.emit({ kind: "state", state, activity: this.activity });
  }

  /** Put an explanation on the card without pretending the session ended. */
  private note(message: string): void {
    this.activity = redact(message);
    this.publish(this.session.idle ? "idle" : "working");
  }

  /**
   * `gh pr create` observed on the tool stream - authorship evidence, not a url sniff.
   *
   * Both halves are required, exactly as they are for the other two drivers: the COMMAND
   * says the agent opened a pull request, and the OUTPUT says which ones. Prose that quotes
   * the command carries no url, and a `gh pr view` that prints one was never a create.
   */
  private notePullRequests(toolCallId: string, output: string | null): void {
    const command = this.commands.get(toolCallId);
    if (!command || !output || !opensPullRequest(command)) return;
    const urls = pullRequestUrlsIn(output);
    if (urls.length > 0) this.out.emit({ kind: "pr_created", urls });
  }

  /** The provider a diagnostic should name, from the id this session is actually running. */
  private providerOfRecord(): string | null {
    const id = this.modelId ?? this.config.model;
    return id ? (splitPiModelId(id)?.provider ?? null) : null;
  }

  private requireLive(): void {
    if (this.stopped) throw new Error("this Pi session's driver has stopped");
  }
}

/**
 * Pi's managed driver.
 *
 * `deps` is the vendor seam - a test hands in a scripted `PiSdk` and drives this exact
 * code with no Pi installed, no credential read and no model spent. Production takes the
 * default, which is the only module that imports the package.
 */
export function piSdkSpec(deps: PiSdkDeps = defaultPiSdkDeps): SdkSpec {
  return {
    async launch(opts: SdkLaunchOptions): Promise<SdkSessionHandle> {
      // REFUSED rather than dropped. Both are capabilities Pi does not have and nothing
      // declares it does (`mcp: null`, `multiRepoDispatch: null`), so arriving here means a
      // caller composed a launch this harness cannot honour - and a session that silently
      // ran without its MCP bundle, or without write access to half the repositories its
      // intent names, is exactly the card that looks dispatched and is running something
      // else.
      if (opts.mcp) {
        throw new PiSdkError(
          "provider-error",
          "Pi has no MCP client, so a managed Pi session cannot register Mission Control's MCP server",
        );
      }
      if (opts.extraDirs.length > 0) {
        throw new PiSdkError(
          "provider-error",
          "Pi has no measured multi-repository write grant, so a managed Pi session cannot take secondary worktrees",
        );
      }
      const sdk = await deps.load();
      const ref = opts.model ? splitPiModelId(opts.model) : null;
      if (opts.model && !ref) {
        throw new PiSdkError(
          "model-unavailable",
          `"${opts.model}" is not a provider-qualified Pi model id`,
        );
      }
      // Pi's OWN durable decision, consumed without prompting. Phase 1 has no surface to
      // ask on, so an undecided or refused checkout runs WITHOUT its project-local
      // executable resources rather than silently trusting a repository for having been
      // attached to Mission Control. Global Pi configuration and the built-in coding tools
      // are unaffected. Phase 2 is where the question gets asked.
      const trusted = sdk.hasTrustRequiringProjectResources(opts.cwd)
        ? sdk.projectTrust(opts.cwd) === true
        : true;
      const sessionPath = opts.resume ? await resumeTarget(sdk, opts.cwd, opts.resume) : null;
      let runtime: PiRuntime;
      try {
        runtime = await sdk.createRuntime({
          cwd: opts.cwd,
          sessionPath,
          model: ref,
          thinkingLevel: piThinkingLevel(opts.effort),
          trusted,
          // Pi declares an out-of-band channel on this runtime, so the dispatcher has left
          // the block OUT of turn one and put it here. A driver that dropped it would
          // deliver the operator's rules nowhere at all.
          appendSystemPrompt: opts.standingInstructions ? [opts.standingInstructions] : [],
          toolEnv: deps.toolEnv(opts.cwd, opts.stateHome),
        });
      } catch (err) {
        throw classifyPiFailure(err, ref?.provider ?? null);
      }
      const session = new PiSdkSession(runtime, { model: opts.model, effort: opts.effort });
      // Subscribed and bound BEFORE turn one, so nothing the first turn emits is lost and
      // the card has an identity before it has activity.
      session.attach();
      session.bind();
      try {
        // `standingInstructions` rode the system-prompt append above, so turn one is just
        // the intent. `standingInstructionsPrompt` is the caller's fallback and is only
        // reached when there is no intent at all - a resume, where the conversation being
        // reopened already carries both.
        const first = opts.prompt || opts.standingInstructionsPrompt;
        if (first) await session.seed(first);
      } catch (err) {
        // Nothing above this line is durable yet - no row, no card, no SSE frame - so the
        // only thing to unwind is the runtime this launch created.
        await session.stop().catch(() => {});
        throw err;
      }
      return session;
    },
  };
}

/**
 * The exact stored conversation, or an explicit failure.
 *
 * Never a look-alike: a missing session file means the conversation this card is about is
 * gone, and starting a fresh one under the old Mission Control id would give the operator a
 * card whose note, goal and work episode all belong to a conversation that no longer
 * exists. `SdkSpec.launch` rejects rather than degrades, and this is the resume half of it.
 */
async function resumeTarget(sdk: PiSdk, cwd: string, sessionId: string): Promise<string> {
  let path: string | null;
  try {
    path = await sdk.findSessionFile(cwd, sessionId);
  } catch (err) {
    throw new PiSdkError(
      "resume-unavailable",
      `Pi could not read its session store for ${cwd} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (!path) {
    throw new PiSdkError(
      "resume-unavailable",
      `Pi no longer holds the session ${sessionId} for ${cwd}`,
    );
  }
  return path;
}

/** The shipped driver. See `HARNESSES.pi.sdk`. */
export const piSdk: SdkSpec = piSdkSpec();
