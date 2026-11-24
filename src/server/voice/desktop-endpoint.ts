import { createServer } from "node:https";
import { once } from "node:events";
import { randomUUID, X509Certificate } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { RequestListener } from "node:http";
import { checkToken } from "../auth.ts";
import { HOST } from "../../shared/harness-runtime.mjs";

const routes = new Set(["/events", "/api/voice/mute", "/voice/shell-report",
  "/voice/listener/hello", "/voice/listener/directive", "/voice/utterances"]);

export const DESKTOP_VOICE_DAEMON_STOPPING = Symbol("desktop voice daemon stopping");

/** Publish the public certificate only after binding. The private key dies with this server. */
export async function serveDesktopVoice(
  handle: RequestListener, file: string, signal: AbortSignal,
) {
  const { generate } = await import("selfsigned");
  const identity = await generate([{ name: "commonName", value: HOST }], {
    keyType: "ec", algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true, pathLenConstraint: 0 },
      { name: "keyUsage", digitalSignature: true, keyCertSign: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: HOST }] },
    ],
  });
  if (signal.aborted) return;
  const server = createServer({ key: identity.private, cert: identity.cert }, (req, res) => {
    const token = req.headers["x-harness-token"];
    if (typeof token !== "string" || !checkToken(token)) return void res.writeHead(403).end();
    if (!routes.has(req.url?.split("?", 1)[0] ?? "")) return void res.writeHead(404).end();
    handle(req, res);
  });
  const temp = file + "." + randomUUID();
  let published = false;
  function publish(value: object) {
    try {
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
  }
  function close() {
    server.close();
    server.closeAllConnections();
    if (!published) return;
    // A surviving shell can distinguish a daemon restart from an explicit flag-off.
    // The marker has no port or certificate and cannot authorize a connection.
    if (signal.reason === DESKTOP_VOICE_DAEMON_STOPPING) publish({ enabled: true });
    else rmSync(file, { force: true });
  }
  try {
    server.listen(0, HOST);
    await once(server, "listening");
    if (signal.aborted) { close(); return; }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing desktop voice port");
    const certificate = new X509Certificate(identity.cert).raw.toString("base64");
    publish({ port: address.port, certificate });
    published = true;
    signal.addEventListener("abort", close, { once: true });
    return server;
  } catch (error) {
    close();
    throw error;
  }
}
