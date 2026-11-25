import { connect, createServer, type Socket } from "node:net";

// A byte-for-byte tunnel, like SSM or ssh -L: no HTTP header rewriting and only one port.
export async function forward(baseURL: string) {
  const target = new URL(baseURL);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing tunnel address");
  const disconnect = () => { for (const socket of sockets) socket.destroy(); };
  return {
    port: address.port,
    disconnect,
    stop: async () => {
      disconnect();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
