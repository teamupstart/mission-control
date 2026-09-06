import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface FakeHerdrSocket {
  path: string;
  requests: HerdrRequest[];
  readonly connectionCount: number;
  close(): Promise<void>;
}

export async function fakeHerdrSocket(
  handle: (request: HerdrRequest, socket: Socket) => void,
): Promise<FakeHerdrSocket> {
  const dir = mkdtempSync(join(tmpdir(), "mission-herdr-socket-"));
  const path = join(dir, "herdr.sock");
  const requests: HerdrRequest[] = [];
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const server: Server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line) as HerdrRequest;
        requests.push(request);
        handle(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    path,
    requests,
    get connectionCount() { return connectionCount; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function reply(socket: Socket, id: string, result: unknown): void {
  socket.write(`${JSON.stringify({ id, result })}\n`);
}

export function refuse(socket: Socket, id: string, message: string): void {
  socket.write(`${JSON.stringify({ id, error: { code: "refused", message } })}\n`);
}
