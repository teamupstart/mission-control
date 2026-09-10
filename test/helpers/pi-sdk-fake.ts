import type { SdkEvent } from "../../src/server/harness/types.ts";
import type {
  PiImage,
  PiRuntime,
  PiRuntimeOptions,
  PiSdk,
  PiSdkDeps,
  PiSession,
  PiSessionEvent,
  PiModelRef,
  PiStreamingBehavior,
  PiThinkingLevel,
} from "../../src/server/harness/pi/sdk-types.ts";

// A scripted Pi, so the REAL adapter can be driven with no Pi installed.
//
// This is the whole point of `sdk-types.ts` being a narrow projection rather than the
// vendor's own surface: everything below stands in for `@earendil-works/pi-coding-agent`
// while `sdk.ts` - the event normalization, the turn accounting, the controls, the
// diagnostics - is the shipped code, unmodified. Nothing here reads a credential, opens a
// session file, or spends a token, and there is no path from these objects to one.
//
// The ORDERING inside `prompt` is copied from Pi rather than invented: Pi calls
// `preflightResult(true)` and only then enters its agent run, so a session that was idle is
// still reporting `streaming: false` at the moment the callback fires, and one that was busy
// has already queued the steer and reports `true`. That is the exact distinction the driver
// reads to tell "started" from "steered", so a fake that set the flag a line earlier would
// make the adapter's own test agree with a bug.

/** One turn handed to the fake, and the two ways a test can end it. */
export interface FakeDelivery {
  text: string;
  images: readonly PiImage[];
  behavior: PiStreamingBehavior | undefined;
  /** Whether Pi took this into a running turn rather than starting one. */
  steered: boolean;
  /** Resolve `prompt()`, as Pi does when the turn it started has fully unwound. */
  settle(): void;
  /** Reject `prompt()` after acceptance, as a provider failure mid-turn does. */
  fail(error: Error): void;
}

export class FakePiSession implements PiSession {
  sessionFile: string | null;
  modelId: string | null;
  idle = true;
  streaming = false;
  readonly deliveries: FakeDelivery[] = [];
  readonly thinkingLevels: PiThinkingLevel[] = [];
  readonly modelChanges: PiModelRef[] = [];
  aborts = 0;
  /** Set to make the NEXT prompt fail its preflight, the way a missing credential does. */
  refusal: Error | null = null;
  /** Set to make the next `setModel` reject, as Pi does for an unauthorized provider. */
  modelRefusal: Error | null = null;
  private readonly listeners = new Set<(event: PiSessionEvent) => void>();

  constructor(
    readonly sessionId: string,
    options: { sessionFile?: string | null; modelId?: string | null } = {},
  ) {
    this.sessionFile =
      "sessionFile" in options
        ? (options.sessionFile ?? null)
        : `/fake/.pi/agent/sessions/--repo--/ts_${sessionId}.jsonl`;
    this.modelId = options.modelId ?? "amazon-bedrock/deepseek.v3.2";
  }

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many listeners are attached - a clear must not leave the old one behind. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  emit(...events: PiSessionEvent[]): void {
    // A COPY per event: a listener that unsubscribes while it is being dispatched to would
    // otherwise mutate the set mid-iteration, which is exactly what a clear does.
    for (const event of events) {
      const current = Array.from(this.listeners);
      for (const listener of current) listener(event);
    }
  }

  prompt(
    text: string,
    options: {
      streamingBehavior?: PiStreamingBehavior;
      images?: readonly PiImage[];
      preflightResult(accepted: boolean): void;
    },
  ): Promise<void> {
    const steered = this.streaming;
    return new Promise<void>((resolve, reject) => {
      this.deliveries.push({
        text,
        images: options.images ?? [],
        behavior: options.streamingBehavior,
        steered,
        settle: resolve,
        fail: reject,
      });
      const refusal = this.refusal;
      if (refusal) {
        this.refusal = null;
        options.preflightResult(false);
        reject(refusal);
        return;
      }
      // Pi's own refusal when a message arrives into a running turn with no behaviour to
      // queue it by. Nothing is queued, which is the whole reason `sendIfIdle` withholds it.
      if (steered && !options.streamingBehavior) {
        this.deliveries.pop();
        options.preflightResult(false);
        reject(
          new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          ),
        );
        return;
      }
      options.preflightResult(true);
      if (steered) {
        // Pi's streaming branch returns as soon as the message is queued.
        resolve();
        return;
      }
      this.streaming = true;
      this.idle = false;
    });
  }

  /** End the current run the way Pi does: settle the prompt, then go quiet. */
  finish(): void {
    this.streaming = false;
    this.idle = true;
    const open = this.deliveries.filter((delivery) => !delivery.steered);
    open.at(-1)?.settle();
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  async setModel(model: PiModelRef): Promise<void> {
    const refusal = this.modelRefusal;
    if (refusal) {
      this.modelRefusal = null;
      throw refusal;
    }
    this.modelChanges.push(model);
    this.modelId = `${model.provider}/${model.id}`;
  }

  setThinkingLevel(level: PiThinkingLevel): void {
    this.thinkingLevels.push(level);
  }
}

export class FakePiRuntime implements PiRuntime {
  session: FakePiSession;
  disposals = 0;
  newSessions = 0;
  /** Set to make `newSession` reject, as a model that disappeared mid-session does. */
  newSessionError: Error | null = null;
  private replaced: ((session: PiSession) => void) | null = null;

  constructor(session: FakePiSession) {
    this.session = session;
  }

  onSessionReplaced(handler: (session: PiSession) => void): void {
    this.replaced = handler;
  }

  async newSession(): Promise<void> {
    if (this.newSessionError) throw this.newSessionError;
    this.newSessions += 1;
    this.session = new FakePiSession(`replacement-${this.newSessions}`, {
      modelId: this.session.modelId,
    });
    this.replaced?.(this.session);
  }

  async dispose(): Promise<void> {
    this.disposals += 1;
  }
}

export class FakePiSdk implements PiSdk {
  agentDirPath = "/fake/.pi/agent";
  /** Whether the checkout holds project-local resources Pi gates behind trust. */
  trustRequiring = false;
  /** Pi's durable decision: true, false, or null for undecided. */
  trust: boolean | null = null;
  /** Pi session id -> its file, as Pi's own listing would answer. */
  readonly sessions = new Map<string, string>();
  /** Every `createRuntime` call, so a test can read what the launch resolved. */
  readonly created: PiRuntimeOptions[] = [];
  /** Set to make `createRuntime` reject - a signed-out provider, an unknown model. */
  createError: Error | null = null;
  /** Set to make the session listing throw, as an unreadable session store does. */
  listError: Error | null = null;
  runtime: FakePiRuntime;

  constructor(session = new FakePiSession("pi-session-1")) {
    this.runtime = new FakePiRuntime(session);
  }

  agentDir(): string {
    return this.agentDirPath;
  }

  hasTrustRequiringProjectResources(): boolean {
    return this.trustRequiring;
  }

  projectTrust(): boolean | null {
    return this.trust;
  }

  async findSessionFile(_cwd: string, sessionId: string): Promise<string | null> {
    if (this.listError) throw this.listError;
    return this.sessions.get(sessionId) ?? null;
  }

  async createRuntime(options: PiRuntimeOptions): Promise<PiRuntime> {
    this.created.push(options);
    if (this.createError) throw this.createError;
    return this.runtime;
  }
}

/** Every environment variable the fake reports for Pi's in-process shell tools. */
export const FAKE_TOOL_ENV = { MISSION_HOME: "/tmp/disposable-state", PATH: "/usr/bin" };

/** The seam the driver takes in production, pointed at the fake above. */
export function fakePiSdkDeps(sdk: FakePiSdk): PiSdkDeps & { toolEnvCalls: string[][] } {
  const toolEnvCalls: string[][] = [];
  return {
    toolEnvCalls,
    async load() {
      return sdk;
    },
    toolEnv(cwd, stateHome) {
      toolEnvCalls.push([cwd, stateHome]);
      return { ...FAKE_TOOL_ENV };
    },
  };
}

/**
 * Drain a handle's events into an array that keeps filling in the background.
 *
 * The supervisor pumps the stream exactly like this, so a test that read it any other way
 * would be asserting on a delivery order nothing in production produces.
 */
export function collect(handle: { events: AsyncIterable<SdkEvent> }): {
  events: SdkEvent[];
  done: Promise<void>;
} {
  const events: SdkEvent[] = [];
  const done = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  return { events, done };
}

/**
 * Let the event stream catch up.
 *
 * A MACROTASK rather than a fixed number of microtask ticks: `EventStream`'s consumer is an
 * async generator, so every queued event costs several microtask hops and a counted loop
 * quietly stops draining once a turn emits more events than the count. That failure reads
 * as "the driver emitted nothing", which is the assertion these tests exist to make.
 */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * One event of a known kind, or a failure naming what arrived instead.
 *
 * `assert.equal(event?.kind, "bound")` reads like a narrowing and is not one - `assert.equal`
 * carries no assertion signature, so every field read after it is unchecked by the compiler
 * and a renamed field would sail through as `undefined === undefined`. This does the
 * narrowing for real, so the assertions that follow are type-checked against the variant
 * they claim to be about.
 */
export function eventOfKind<K extends SdkEvent["kind"]>(
  event: SdkEvent | undefined,
  kind: K,
): Extract<SdkEvent, { kind: K }> {
  if (!event) throw new Error(`expected a ${kind} event, but the stream had none`);
  if (event.kind !== kind) throw new Error(`expected a ${kind} event, got ${event.kind}`);
  return event as Extract<SdkEvent, { kind: K }>;
}

/** The launch options a dispatch composes, with only the interesting fields named. */
export function launchOptions(
  over: Partial<import("../../src/server/harness/types.ts").SdkLaunchOptions> = {},
): import("../../src/server/harness/types.ts").SdkLaunchOptions {
  return {
    cwd: "/repo",
    stateHome: "/tmp/disposable-state",
    prompt: "do the thing",
    model: "amazon-bedrock/deepseek.v3.2",
    effort: null,
    permissionMode: null,
    mcp: null,
    extraDirs: [],
    standingInstructions: "",
    standingInstructionsPrompt: "",
    resume: null,
    ...over,
  };
}
