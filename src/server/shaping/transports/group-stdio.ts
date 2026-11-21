import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { EXIT_DRAIN_MS, killGroup, releaseStdio } from "./command.ts";

/** The SDK's own stdio framing: one JSON-RPC message per line. */
export type StdioFraming = typeof import("@modelcontextprotocol/sdk/shared/stdio.js");

/**
 * One message on stdout over the cap. The wording is the SDK read buffer's, which the transport's
 * caller already recognises.
 */
export class StdioMessageCapError extends Error {
  constructor(maxBytes: number) {
    super(`ReadBuffer exceeded maximum size of ${maxBytes} bytes`);
    this.name = "StdioMessageCapError";
  }
}

/**
 * The server stopped reading its stdin: a write failed because the pipe is closed. No request can
 * reach it any more, so the connection is lost, though the server may still be running.
 */
export class StdinClosedError extends Error {
  constructor(cause: unknown) {
    super("The MCP server stopped reading its stdin, so no request can reach it.", { cause });
    this.name = "StdinClosedError";
  }
}

/** How long a server is given to exit after its stdin ends, and again after SIGTERM. */
const CLOSE_GRACE_MS = 2_000;

export interface GroupStdioParams {
  command: string;
  args: readonly string[];
  /** The child's whole environment: nothing is added beneath it. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The largest one message may be, in bytes, its line ending aside. */
  maxBufferSize: number;
}

/**
 * A client transport for a local MCP server over stdio. It frames messages as the SDK's
 * `StdioClientTransport` does, one JSON-RPC message per line, parsed and written with the SDK's
 * `deserializeMessage` and `serializeMessage`, and differs in how the server is started and
 * stopped: as a `command` shaper is, in a process group of its own. Its cap applies to each
 * message, as the cap does over streamable HTTP. The SDK's read buffer caps everything it holds
 * at once, so a chunk that ends one near-limit message and starts the next failed two valid
 * messages, or not, depending on where the pipe happened to split them.
 *
 * The SDK's transport spawns the server in the daemon's own group and, on close, signals only that
 * one process, so a helper the server started outlived every dry run that timed out or was
 * cancelled, and repeated runs accumulated them. Here closing ends stdin, waits, sends SIGTERM to
 * the whole group, waits again, and then sends SIGKILL to whatever is left of it, so the server and
 * every helper in its group stop together. A server that exits on its own has its group reaped
 * the same way, and is seen to have exited when it exits: Node holds a child's `close` until every
 * copy of its pipes is closed, and a helper that inherited them can hold them open indefinitely,
 * so the exit is taken from `exit`, its pipes get the `command` transport's bounded drain to deliver
 * what the server wrote, and then the connection is closed and the group stopped. A helper that leaves the group on purpose (`setsid`) is out of reach, exactly as it
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
  /** Settled once the server is gone and its group stopped, by its pipes closing or its drain ending. */
  private finished = false;
  private onFinished: Array<() => void> = [];
  /** The unfinished line, in the chunks it arrived in, and its length in bytes. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly params: GroupStdioParams, private readonly framing: StdioFraming) {}

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
      child.on("exit", () => {
        this.exited = true;
        // The pipes deliver what is left of the server's output, for a bounded time only: a helper
        // that inherited them would otherwise keep the connection looking live until a timeout.
        setTimeout(() => this.finish(child), EXIT_DRAIN_MS).unref();
      });
      child.on("close", () => {
        this.exited = true;
        this.finish(child);
      });
      child.stdin?.on("error", (error) => this.onerror?.(new StdinClosedError(error)));
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.readLines(chunk);
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

  /** The server is gone: whatever it left running in its group goes with it, as for a `command`. */
  private finish(child: ChildProcess): void {
    if (this.finished) return;
    this.finished = true;
    killGroup(child);
    releaseStdio(child);
    this.pending = [];
    this.pendingBytes = 0;
    for (const done of this.onFinished.splice(0)) done();
    this.onclose?.();
  }

  /**
   * Every line `chunk` completes, delivered in order, and the rest kept for the next chunk. Each
   * message is held to the cap on its own: a complete line over it, or an unfinished one already
   * past it, fails with `StdioMessageCapError`; two messages that each fit always pass.
   */
  private readLines(chunk: Buffer): void {
    const max = this.params.maxBufferSize;
    let start = 0;
    for (let newline = chunk.indexOf(0x0a, start); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline);
      if (this.pendingBytes + piece.length > max) throw new StdioMessageCapError(max);
      const line = this.pending.length > 0 ? Buffer.concat([...this.pending, piece]) : piece;
      this.pending = [];
      this.pendingBytes = 0;
      start = newline + 1;
      this.deliver(line);
      if (this.finished) return;
    }
    const rest = chunk.subarray(start);
    if (rest.length === 0) return;
    if (this.pendingBytes + rest.length > max) throw new StdioMessageCapError(max);
    this.pending.push(rest);
    this.pendingBytes += rest.length;
  }

  /** One complete line: a message, or, when it is not one, an error reported and the line skipped. */
  private deliver(line: Buffer): void {
    let message: JSONRPCMessage;
    try {
      message = this.framing.deserializeMessage(line.toString("utf8").replace(/\r$/, ""));
    } catch (error) {
      this.onerror?.(error as Error);
      return;
    }
    this.onmessage?.(message);
  }

  /**
   * Settled by the write's own callback, on success or on error. Waiting for `drain` instead would
   * wait forever for a server that closed its stdin and kept running: the pipe breaks, and no
   * `drain` follows. A broken pipe rejects the send and reports the lost connection.
   */
  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.exited || this.closing || stdin.destroyed) return Promise.reject(new Error("Not connected"));
    const json = this.framing.serializeMessage(message);
    return new Promise((resolve, reject) => {
      stdin.write(json, (error) => {
        if (!error) { resolve(); return; }
        const closed = new StdinClosedError(error);
        this.onerror?.(closed);
        reject(closed);
      });
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
      if (this.finished) done();
      else this.onFinished.push(done);
    });
    const settle = () => Promise.race([closed, new Promise<void>((done) => setTimeout(done, CLOSE_GRACE_MS).unref())]);
    try { child.stdin?.end(); } catch { /* Already closed. */ }
    await settle();
    // SIGTERM only to a server that has not exited: until then its pid is still its group's id.
    if (!this.finished && !this.exited) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch { /* Already gone. */ }
      }
      await settle();
    }
    // The group is killed in one place, `finish`, and only once. A server that already finished
    // had its group stopped then; signalling the same number again, perhaps long after, could reach
    // an unrelated group that was given the id since.
    this.finish(child);
  }
}
