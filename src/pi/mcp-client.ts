import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface McpResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Same bounds as the daemon's mission-mcp probe. Calls deliberately have no deadline:
 * request_input belongs to the human's clock, and cancellation belongs to Pi's signal. */
export class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = "";
  private closed = false;
  private readonly maxFrame: number;
  private readonly killGrace: number;

  constructor(path: string, options: { cwd?: string; env?: NodeJS.ProcessEnv; maxFrame?: number; killGrace?: number } = {}) {
    this.maxFrame = options.maxFrame ?? 1_048_576;
    this.killGrace = options.killGrace ?? 2_000;
    this.child = spawn(process.execPath, [path], { cwd: options.cwd, env: options.env, stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.resume(); // Drain without putting protocol diagnostics into Pi's TUI.
    this.child.stdout.on("error", () => this.close());
    this.child.stderr.on("error", () => this.close());
    this.child.stdin.on("error", () => this.close());
    this.child.on("error", () => this.close());
    this.child.on("exit", () => this.close());
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxFrame) { this.close(); return; }
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.error) pending.reject(new Error(message.error.message ?? "MCP request failed"));
        else pending.resolve(message.result);
      } catch { this.close(); return; }
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrame) this.close();
  }

  private send(message: unknown): void {
    if (this.closed) throw new Error("Mission Control MCP connection is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Mission Control MCP connection is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Mission Control tool cancelled"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        try { this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Pi turn aborted" } }); } catch { /* already closed */ }
        reject(new Error("Mission Control tool cancelled"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  async tools(timeout = 15_000): Promise<McpTool[]> {
    const timer = setTimeout(() => this.close(), timeout);
    try {
      await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mission-control-pi", version: "1" } });
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await this.request("tools/list", cursor ? { cursor } : {}) as { tools: McpTool[]; nextCursor?: string };
        if (!Array.isArray(result.tools)) throw new Error("Invalid MCP tool list");
        for (const tool of result.tools) {
          if (typeof tool.name !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object") throw new Error("Invalid MCP tool");
          tools.push(tool);
        }
        cursor = result.nextCursor;
        if (!cursor) return tools;
      }
      throw new Error("Mission Control tool list exceeded 20 pages");
    } catch (error) { this.close(); throw error; }
    finally { clearTimeout(timer); }
  }

  async call(name: string, args: unknown, signal?: AbortSignal): Promise<McpResult> {
    return await this.request("tools/call", { name, arguments: args }, signal) as McpResult;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Mission Control MCP connection closed"));
    }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const timer = setTimeout(() => this.child.kill("SIGKILL"), this.killGrace);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
    this.child.kill("SIGTERM");
  }
}
