import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { MacListenerSupervisor, type VoiceSigner } from "../server/voice/macos-supervisor.ts";
import { SupervisorStartRefused, type SupervisorReporter } from "../server/voice/supervisor-auth.ts";
import { stateDir, tokenPath } from "../shared/harness-runtime.mjs";
import { VOICE_SPEECH_STOP_UNCONFIRMED } from "../shared/voice.ts";
import { logMain } from "./main-log.ts";
import type { ShellVoiceState } from "./voice-state-schema.ts";

/** An exited helper is replaced only while the same verified model is still wanted. */
export class VoiceListener {
  private directory: string | null = null;
  private child: ChildProcess | null = null;
  private retry?: NodeJS.Timeout;
  private stopping?: NodeJS.Timeout;
  private restarts = 0;
  private exited: Promise<void> = Promise.resolve();
  private closed = false;

  private launching?: Promise<void>;
  private unconfirmed = false;
  private replacement = 0;

  constructor(private readonly launch: (directory: string) => ChildProcess | Promise<ChildProcess>, private readonly log = logMain,
    private readonly supervisor?: MacListenerSupervisor) {}

  reconnect() { this.supervisor?.reconnect(); }

  get pid() { return this.child?.pid ?? -1; }

  update(state: ShellVoiceState, permitted: boolean): void {
    const directory = state.mode !== "off" && state.model.status === "ready" &&
      state.model.backend === "fluidaudio" && permitted ? state.model.directory : null;
    const unconfirmed = state.capabilities?.listener?.code === VOICE_SPEECH_STOP_UNCONFIRMED;
    if (!this.closed && unconfirmed && !this.unconfirmed) {
      this.replacement++;
      this.terminate();
    }
    this.unconfirmed = unconfirmed;
    if (this.closed || directory === this.directory) return;
    this.directory = directory;
    this.restarts = 0;
    clearTimeout(this.retry);
    if (this.child) this.terminate();
    else this.start();
  }

  private start(): void {
    const directory = this.directory;
    if (!directory || this.closed || this.launching) return;
    const replacement = this.replacement;
    const result = this.launch(directory);
    if (result instanceof Promise) {
      this.launching = result.then(child => {
        this.launching = undefined;
        this.observe(child, directory);
        if (this.closed || this.directory !== directory || replacement !== this.replacement) this.terminate();
      }, () => {
        this.launching = undefined;
        this.scheduleRetry();
      });
    } else this.observe(result, directory);
  }

  private scheduleRetry(pid: number | "none" = "none") {
    if (this.closed || !this.directory) return;
    const delayMs = Math.min(500 * ++this.restarts, 5000);
    this.log(`Voice listener retry pid=${pid} attempt=${this.restarts} delayMs=${delayMs}`);
    this.retry = setTimeout(() => this.start(), delayMs);
  }

  private observe(child: ChildProcess, directory: string) {
    this.child = child;
    const pid = child.pid ?? "none";
    this.log(`Voice listener launch pid=${pid} modelRevision=${JSON.stringify(basename(directory))}`);
    // close follows both a normal exit and a spawn error (including a missing binary).
    let spawnError: string | undefined;
    child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error.code ?? error.name; });
    this.exited = new Promise(resolve => {
      const close = (code: number | null, signal: string | null) => {
        this.log(`Voice listener close pid=${pid} code=${code ?? "none"} signal=${signal ?? "none"} requested=${!!this.stopping}` +
          (spawnError ? ` error=${spawnError}` : ""));
        clearTimeout(this.stopping);
        this.stopping = undefined;
        this.child = null;
        resolve();
        if (!this.directory || this.closed) return;
        if (directory !== this.directory) { this.start(); return; }
        this.scheduleRetry(pid);
      };
      if (child.exitCode != null || child.signalCode != null) close(child.exitCode, child.signalCode);
      else child.once("close", close);
    });
  }

  private terminate(): void {
    if (!this.child || this.stopping) return;
    const child = this.child;
    child.kill("SIGTERM");
    this.stopping = setTimeout(() => child.kill("SIGKILL"), 2000);
  }

  async stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    this.terminate();
    await this.launching;
    await this.exited;
    await this.supervisor?.close();
  }
}

export function nativeVoiceListener(executable: string, endpoint: () => { origin: string; certificate: string }, signer?: VoiceSigner, report?: SupervisorReporter): VoiceListener {
  // The supervisor waits for close before replacing its child, so only one helper uses this lease at a time.
  const owner = randomUUID();
  const supervisor = signer && report ? new MacListenerSupervisor(stateDir(), "shell", signer, executable, report) : undefined;
  return new VoiceListener(directory => {
    const { origin, certificate } = endpoint();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MISSION_VOICE_DAEMON_URL: origin,
      MISSION_VOICE_DAEMON_CERT: certificate,
      MISSION_VOICE_SUPERVISOR_ID: owner,
      MISSION_VOICE_TOKEN_FILE: tokenPath(),
      MISSION_VOICE_MODEL_DIR: directory,
    };
    delete env.MISSION_VOICE_LISTENER_INSTANCE;
    const captureOnly = () => spawn(executable, [], {stdio: "ignore", env});
    if (!supervisor) return captureOnly();
    return supervisor.start(env).catch(error => {
      // An adopted daemon may trust a different launch service. Its definitive
      // refusal occurred before spawn. Keep the existing capture-only lease.
      if (error instanceof SupervisorStartRefused) return captureOnly();
      throw error;
    });
  }, logMain, supervisor);
}
