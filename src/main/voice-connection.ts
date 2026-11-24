import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { Agent, fetch, Headers, type RequestInit } from "undici";
import { z } from "zod";
import { desktopVoiceEndpointPath, HOST, readToken } from "../shared/harness-runtime.mjs";

const Endpoint = z.object({ port: z.number().int().min(1).max(65535), certificate: z.string().min(1) });

/** Trust comes from the operator's state directory, never from the process answering a port. */
export function desktopVoiceConnection() {
  try {
    const { port, certificate } = Endpoint.parse(JSON.parse(readFileSync(desktopVoiceEndpointPath(), "utf8")));
    const pin = new X509Certificate(Buffer.from(certificate, "base64"));
    const origin = `https://${HOST}:${port}`;
    const dispatcher = new Agent({ connect: {
      ca: pin.toString(), rejectUnauthorized: true,
      checkServerIdentity: (_host, peer) => peer.raw.equals(pin.raw) ? undefined : new Error("Unexpected desktop voice certificate"),
    } });
    function request(path: string, options: RequestInit = {}) {
      const headers = new Headers(options.headers);
      headers.set("x-harness-token", readToken());
      return fetch(origin + path, { ...options, headers, dispatcher, redirect: "error" });
    }
    return {
      origin, certificate, request,
      async postStatus(path: string, body: object, signal: AbortSignal) {
        try {
          const response = await request(path, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
          });
          await response.body?.cancel();
          return { ok: response.ok, status: response.status };
        } catch {
          return undefined;
        }
      },
      close: () => { void dispatcher.destroy(); },
    };
  } catch {
    // Voice may be disabled, or the daemon may still be starting.
    return undefined;
  }
}
