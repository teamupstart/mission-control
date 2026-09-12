/**
 * A stand-in for Pi's SDK, so a managed Pi session is drivable end to end for free.
 *
 * Pi is the one harness whose managed runtime has NO subprocess: its SDK is imported into
 * the daemon. The `MISSION_PI_BIN` redirection that makes Claude and Codex free therefore
 * cannot reach it, and `MISSION_PI_SDK_MODULE` (see `harness/pi/sdk-deps.ts`) is the same
 * override at the only seam Pi has. This module is what that variable points at for every
 * daemon this suite starts - so there is no path from a browser spec to
 * `@earendil-works/pi-coding-agent`, to an AWS endpoint, or to the operator's `~/.pi`.
 *
 * It is not a mock of the driver. The REAL adapter is under test - the real event
 * normalization, the real turn accounting, the real controls, the real diagnostics - and
 * this supplies only what the vendor would: a session id, a JSONL transcript in Pi's own
 * format, and a stream of session events.
 *
 * The transcript matters as much as the events. Mission Control reads a Pi conversation off
 * `~/.pi/agent/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl` with `piToMessages`, on both
 * runtimes, so a fake that emitted events without writing the file would show a card with a
 * working session and an empty conversation - and the spec would be asserting on nothing.
 *
 * ## The guard rails
 *
 * Every one of these FAILS the launch rather than degrading, because a fixture that quietly
 * fell back is a suite that quietly starts costing money:
 *
 *  - `PI_CODING_AGENT_DIR` must point inside this daemon's disposable home, so nothing can
 *    read or write the operator's real Pi configuration;
 *  - `MC_E2E_RECORD_DIR` must exist, so what the driver asked for is inspectable;
 *  - `globalThis.fetch` is replaced with one that throws, so any code path in this process
 *    that tried to reach a provider through it fails loudly and immediately.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Pi's own cwd -> project-dir encoding, from `session-manager.js`. See `pi/transcript.ts`. */
function projectDir(sessionsDir, cwd) {
  return join(sessionsDir, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`fake-pi-sdk: ${name} is not set - refusing to run`);
  return value;
}

/**
 * A zero-padded, monotonically increasing sequence, so `recordsIn` - which sorts by FILE
 * NAME - hands a spec these records in the order they were written. A timestamp alone
 * cannot: two launches inside one millisecond sort by whatever suffix follows, and the
 * whole point of reading the last record is that it is the most recent one.
 */
let sequence = 0;
function record(name, body) {
  const dir = join(required("MC_E2E_RECORD_DIR"), "pi-sdk");
  mkdirSync(dir, { recursive: true });
  sequence += 1;
  writeFileSync(
    join(dir, `${name}-${String(process.hrtime.bigint()).padStart(24, "0")}-${sequence}.json`),
    JSON.stringify(body, null, 2),
  );
}

/**
 * One scripted Pi conversation: a session file it appends to, and events it emits.
 *
 * The turn shape mirrors what a real Pi turn produces, in the order a real one produces it,
 * because the driver's turn accounting is written against that order: `agent_start`, an
 * assistant message with usage, `agent_end`, and exactly one `agent_settled`.
 */
class FakeSession {
  constructor(cwd, sessionsDir, options = {}) {
    this.cwd = cwd;
    this.sessionId = options.sessionId ?? randomUUID();
    this.modelId = options.modelId ?? null;
    this.listeners = new Set();
    this.idle = true;
    this.streaming = false;
    this.thinkingLevel = options.thinkingLevel ?? null;
    /** Resolves the in-flight prompt, so an abort can end the turn the way Pi does. */
    this.finish = null;
    this.turns = 0;
    const dir = projectDir(sessionsDir, cwd);
    mkdirSync(dir, { recursive: true });
    this.sessionFile =
      options.sessionFile ??
      join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${this.sessionId}.jsonl`);
    if (!existsSync(this.sessionFile)) {
      this.append({
        type: "session",
        version: 3,
        id: this.sessionId,
        timestamp: new Date().toISOString(),
        cwd,
      });
    }
  }

  append(entry) {
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
  }

  /** One conversation turn, in the record shape `piToMessages` reads back. */
  writeMessage(role, text, extra = {}) {
    this.append({
      type: "message",
      id: randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role, content: [{ type: "text", text }], ...extra },
    });
  }

  async bindExtensions(ui) { this.ui = ui; }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  /**
   * Take a turn.
   *
   * `preflightResult(true)` fires BEFORE the run starts, exactly as Pi's does - which is
   * what lets the driver tell an idle start from a steer without a race. A steer joins the
   * running turn and produces no second completion, which is the whole reason the driver
   * reports it as `steered`.
   */
  prompt(text, options) {
    const steering = this.streaming;
    if (steering && !options.streamingBehavior) {
      // Pi's own refusal when a message arrives into a running turn with no behaviour to
      // queue it by. Nothing is queued, which is what `sendIfIdle` relies on.
      options.preflightResult(false);
      return Promise.reject(
        new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        ),
      );
    }
    if (steering) {
      options.preflightResult(true);
      this.writeMessage("user", text);
      // Delivered into the running turn: the answer arrives with that turn's own reply.
      this.steered = text;
      return Promise.resolve();
    }
    options.preflightResult(true);
    this.streaming = true;
    this.idle = false;
    this.writeMessage("user", text);
    return new Promise((resolve) => {
      this.finish = resolve;
      void this.run(text);
    });
  }

  /**
   * The scripted turn.
   *
   * A prompt containing `SLOWLY` never settles on its own, which is what gives the
   * interrupt case something real to stop; everything else answers on the next tick so a
   * spec spends no wall clock.
   */
  async run(text) {
    const generation = ++this.turns;
    const current = () => generation === this.turns && this.streaming;
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start" });
    if (text.includes("PI_QUESTIONS")) {
      const selected = await this.ui.select("Choose a region", ["West", "East"]);
      if (!current()) return;
      const confirmed = await this.ui.confirm("Apply selection?", "Use the selected test region.");
      if (!current()) return;
      const input = await this.ui.input("Deployment name", "name or empty");
      if (!current()) return;
      const edited = await this.ui.editor("Release notes", "First line\nSecond line");
      if (!current()) return;
      record("answers", { selected, confirmed, input, edited });
    }
    if (text.includes("PI_TIMEOUT")) {
      await this.ui.select("Repeated question", ["Continue"], { timeout: 1500 });
      if (!current()) return;
      await this.ui.select("Repeated question", ["Continue"]);
      if (!current()) return;
    }
    if (text.includes("PI_BLOCK")) await this.ui.input("Blocking extension question");
    if (!current()) return;
    if (text.includes("PI_CREATE_PR")) {
      this.emit({ type: "tool_execution_start", toolCallId: "pr", toolName: "bash", command: "gh pr create", opensPullRequest: true });
      this.emit({ type: "tool_execution_end", toolCallId: "pr", toolName: "bash", isError: false, prUrls: ["https://github.com/test/pi-fixture/pull/975"] });
    }
    const slow = /SLOWLY/.test(text);
    if (slow) {
      this.partialReply = /PARTIAL/.test(text) ? "Pi response before interruption" : "";
      this.emit({
        type: "tool_execution_start",
        toolCallId: "slow-1",
        toolName: "bash",
        args: { command: "sleep 600" },
      });
    }
    if (text.includes("PI_UNSUPPORTED")) {
      this.ui.unsupported("custom");
      this.ui.unsupported("setWidget");
      // Repeated use after the host's diagnostic throttle must remain reportable.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!current()) return;
      this.ui.unsupported("setWidget");
    }
    if (slow) return;
    setTimeout(() => this.settleWith(text), 5);
  }

  settleWith(text, aborted = false) {
    const reply = aborted
      ? this.partialReply ?? ""
      : `pi answered: ${[text, this.steered].filter(Boolean).join(" + ")}`;
    this.steered = undefined;
    this.partialReply = undefined;
    const usage = {
      input: 120,
      output: 24,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 144,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    };
    this.writeMessage("assistant", reply, {
      model: this.modelId?.split("/").slice(1).join("/") ?? "fake",
      provider: this.modelId?.split("/")[0] ?? "fake",
      stopReason: aborted ? "aborted" : "stop",
      usage,
    });
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: this.modelId?.split("/")[0] ?? "fake",
        model: this.modelId?.split("/").slice(1).join("/") ?? "fake",
        stopReason: aborted ? "aborted" : "stop",
        usage,
      },
    });
    this.emit({ type: "agent_end", messages: [], willRetry: false });
    this.streaming = false;
    this.idle = true;
    const finish = this.finish;
    this.finish = null;
    this.emit({ type: "agent_settled" });
    finish?.();
  }

  async abort() {
    if (!this.streaming) return;
    this.turns += 1;
    this.emit({
      type: "tool_execution_end",
      toolCallId: "slow-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "aborted" }] },
      isError: true,
    });
    this.settleWith("", true);
  }

  async setModel(model) {
    this.modelId = `${model.provider}/${model.id}`;
    record("set-model", { model });
  }

  setThinkingLevel(level) {
    this.thinkingLevel = level;
    this.emit({ type: "thinking_level_changed", level });
    record("set-thinking", { level });
  }
}

/** Pi's runtime: it owns the CURRENT session, and a clear replaces it. */
class FakeRuntime {
  constructor(session, sessionsDir) {
    this.session = session;
    this.sessionsDir = sessionsDir;
    this.replaced = null;
    this.disposed = false;
  }

  onSessionReplaced(handler) {
    this.replaced = handler;
  }

  async newSession() {
    await this.session.abort();
    this.session = new FakeSession(this.session.cwd, this.sessionsDir, {
      modelId: this.session.modelId,
    });
    record("new-session", { sessionId: this.session.sessionId });
    await this.replaced?.(this.session);
  }

  async dispose() {
    this.disposed = true;
    record("dispose", { sessionId: this.session.sessionId });
  }
}

/** Every session file this fixture has written, so a resume can find one by exact id. */
function findSessionFile(sessionsDir, cwd, sessionId) {
  const dir = projectDir(sessionsDir, cwd);
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find((name) => name.endsWith(`_${sessionId}.jsonl`));
  return match ? join(dir, match) : null;
}

export async function createPiSdk() {
  const agentDir = required("PI_CODING_AGENT_DIR");
  const home = required("MISSION_HOME");
  if (!agentDir.startsWith(home)) {
    throw new Error(
      `fake-pi-sdk: PI_CODING_AGENT_DIR (${agentDir}) is outside this daemon's disposable home - refusing to touch a real Pi configuration`,
    );
  }
  // Any provider call in this process is a bug in the fixture, not a slow test. Fail on it.
  globalThis.fetch = () => {
    throw new Error("fake-pi-sdk: a managed Pi session attempted a network request");
  };
  const sessionsDir = join(agentDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const models = JSON.parse(readFileSync(process.env.MC_E2E_PI_SDK_MODELS, "utf8"));

  return {
    agentDir: () => agentDir,
    // Nothing in the seeded workspace carries project-local Pi resources, so no trust
    // decision is needed and none is invented. The resolved policy result is recorded at
    // resource loading, which is what a spec reads to prove the decision was made at all.
    hasTrustRequiringProjectResources: (cwd) => process.env.MC_E2E_PI_TRUST === "1" || existsSync(join(cwd, ".pi")),
    projectTrust: (cwd) => {
      const path = join(agentDir, "fake-trust.json");
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8"))[cwd] ?? null : null;
    },
    setProjectTrust: (cwd, trusted) => {
      const path = join(agentDir, "fake-trust.json");
      const values = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      writeFileSync(path, JSON.stringify({ ...values, [cwd]: trusted }));
      record("trust", { cwd, trusted });
    },
    async findSessionFile(cwd, sessionId) {
      return findSessionFile(sessionsDir, cwd, sessionId);
    },
    async createRuntime(options) {
      const trusted = typeof options.projectTrust === "function"
        ? await options.projectTrust() : options.projectTrust;
      options.signal?.throwIfAborted();
      record("project-resources", { loaded: trusted });
      record("create-runtime", {
        cwd: options.cwd,
        sessionPath: options.sessionPath,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        trusted,
        // The isolation this driver has to apply itself, since Pi runs in-process: a
        // MISSION_HOME here that equals the daemon's own would be the leak.
        toolStateHome: options.toolEnv.MISSION_HOME ?? null,
      });
      const id = options.model ? `${options.model.provider}/${options.model.id}` : null;
      if (id && !models.includes(id)) {
        const error = new Error(`Pi does not offer the model ${id}`);
        error.piKind = "model-unavailable";
        throw error;
      }
      const session = new FakeSession(options.cwd, sessionsDir, {
        modelId: id,
        thinkingLevel: options.thinkingLevel,
        ...(options.sessionPath
          ? {
              sessionFile: options.sessionPath,
              sessionId: /_([0-9a-f-]{36})\.jsonl$/.exec(options.sessionPath)?.[1],
            }
          : {}),
      });
      return new FakeRuntime(session, sessionsDir);
    },
  };
}
