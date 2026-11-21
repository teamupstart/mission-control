import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { killGroup, releaseStdio } from "./command.ts";

/** The SDK's own stdio framing: one JSON-RPC message per line, read through a bounded buffer. */
export type StdioFraming = typeof import("@modelcontextprotocol/sdk/shared/stdio.js");

/** How long a server is given to exit after its stdin ends, and again after SIGTERM. */
const CLOSE_GRACE_MS = 2_000;

export interface GroupStdioParams {
  command: string;
  args: readonly string[];
  /** The child's whole environment: nothing is added beneath it. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The largest message the read buffer holds, beyond which it fails with the SDK's overflow error. */
  maxBufferSize: number;
}

/**
 * A client transport for a local MCP server over stdio. It frames messages exactly as the SDK's
 * `StdioClientTransport` does, with the SDK's `ReadBuffer` and `serializeMessage`, and differs in
 * how the server is started and stopped: as a `command` shaper is, in a process group of its own.
 *
 * The SDK's transport spawns the server in the daemon's own group and, on close, signals only that
 * one process, so a helper the server started outlived every dry run that timed out or was
 * cancelled, and repeated runs accumulated them. Here closing ends stdin, waits, sends SIGTERM to
 * the whole group, waits again, and then sends SIGKILL to whatever is left of it, so the server and
 * every helper in its group stop together. A server that exits on its own has its group reaped
 * the same way. A helper that leaves the group on purpose (`setsid`) is out of reach, exactly as it
 * is for a `command` shaper.
 *
 * The environment is the one given and nothing else: the SDK's transport adds inherited defaults
 * beneath it, which every diagnostic would then have to be redacted against as well.
 */
export class GroupStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** The server's stderr, there before `start`, so nothing it writes early is missed. */
  readonly stderr = new PassThrough();
  private child: ChildProcess | undefined;
  private exited = false;
  private closing: Promise<void> | null = null;
  private readonly readBuffer: ReadBuffer;

  constructor(private readonly params: GroupStdioParams, private readonly framing: StdioFraming) {
    this.readBuffer = new framing.ReadBuffer({ maxBufferSize: params.maxBufferSize });
  }

  /** The server's pid, which is also its process group's id, once started. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    if (this.child) return Promise.reject(new Error("The stdio transport was already started."));
    // The path the executable locator resolved before this transport was built, never a bare name.
    const executable = this.params.command;
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...this.params.args], {
        cwd: this.params.cwd,
        env: this.params.env,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on("spawn", () => resolve());
      child.on("close", () => {
        this.exited = true;
        // Whatever the server left running in its group goes with it, as it does for a `command`.
        killGroup(child);
        releaseStdio(child);
        this.readBuffer.clear();
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          this.readMessages();
        } catch (error) {
          // An overflowing line: the SDK's own error, which the caller recognises.
          this.onerror?.(error as Error);
          void this.close().catch(() => {});
        }
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
      child.stderr?.pipe(this.stderr);
    });
  }

  /** Every complete message in the buffer, in order; a line that is not one is reported and skipped. */
  private readMessages(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.exited || this.closing) return Promise.reject(new Error("Not connected"));
    const json = this.framing.serializeMessage(message);
    return new Promise((resolve) => {
      if (stdin.write(json)) resolve();
      else stdin.once("drain", () => resolve());
    });
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>((done) => {
      if (this.exited) done();
      else child.once("close", () => done());
    });
    const settle = () => Promise.race([closed, new Promise<void>((done) => setTimeout(done, CLOSE_GRACE_MS).unref())]);
    try { child.stdin?.end(); } catch { /* Already closed. */ }
    await settle();
    if (!this.exited) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch { /* Already gone. */ }
      }
      await settle();
    }
    // The group last, whatever happened above: a helper that ignored SIGTERM, or one still running
    // after the server exited, is stopped here. Harmless on an empty group.
    killGroup(child);
    releaseStdio(child);
    this.readBuffer.clear();
  }
}
