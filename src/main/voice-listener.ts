import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { tokenPath } from "../shared/harness-runtime.mjs";
import { logMain } from "./main-log.ts";
import type { ShellVoiceState } from "./voice-state.ts";

/** An exited helper is replaced only while the same verified model is still wanted. */
export class VoiceListener {
  private directory: string | null = null;
  private child: ChildProcess | null = null;
  private retry?: NodeJS.Timeout;
  private stopping?: NodeJS.Timeout;
  private restarts = 0;
  private exited: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly launch: (directory: string) => ChildProcess, private readonly log = logMain) {}

  update(state: ShellVoiceState, permitted: boolean): void {
    const directory = state.mode !== "off" && state.model.status === "ready" &&
      state.model.backend === "fluidaudio" && permitted ? state.model.directory : null;
    if (this.closed || directory === this.directory) return;
    this.directory = directory;
    this.restarts = 0;
    clearTimeout(this.retry);
    if (this.child) this.terminate();
    else this.start();
  }

  private start(): void {
    const directory = this.directory;
    if (!directory || this.closed) return;
    const child = this.launch(directory);
    this.child = child;
    const pid = child.pid ?? "none";
    this.log(`Voice listener launch pid=${pid} modelRevision=${JSON.stringify(basename(directory))}`);
    // close follows both a normal exit and a spawn error (including a missing binary).
    let spawnError: string | undefined;
    child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error.code ?? error.name; });
    this.exited = new Promise(resolve => child.once("close", (code, signal) => {
      this.log(`Voice listener close pid=${pid} code=${code ?? "none"} signal=${signal ?? "none"} requested=${!!this.stopping}` +
        (spawnError ? ` error=${spawnError}` : ""));
      clearTimeout(this.stopping);
      this.stopping = undefined;
      this.child = null;
      resolve();
      if (!this.directory || this.closed) return;
      if (directory !== this.directory) { this.start(); return; }
      const delayMs = Math.min(500 * ++this.restarts, 5000);
      this.log(`Voice listener retry pid=${pid} attempt=${this.restarts} delayMs=${delayMs}`);
      this.retry = setTimeout(() => this.start(), delayMs);
    }));
  }

  private terminate(): void {
    if (!this.child || this.stopping) return;
    const child = this.child;
    child.kill("SIGTERM");
    this.stopping = setTimeout(() => child.kill("SIGKILL"), 2000);
  }

  stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    this.terminate();
    return this.exited;
  }
}

export function nativeVoiceListener(executable: string, endpoint: () => { origin: string; certificate: string }): VoiceListener {
  // The supervisor waits for close before replacing its child, so only one helper uses this lease at a time.
  const owner = randomUUID();
  return new VoiceListener(directory => {
    const { origin, certificate } = endpoint();
    return spawn(executable, [], {
      stdio: "ignore",
      env: {
        ...process.env,
        MISSION_VOICE_DAEMON_URL: origin,
        MISSION_VOICE_DAEMON_CERT: certificate,
        MISSION_VOICE_SUPERVISOR_ID: owner,
        MISSION_VOICE_TOKEN_FILE: tokenPath(),
        MISSION_VOICE_MODEL_DIR: directory,
      },
    });
  });
}
