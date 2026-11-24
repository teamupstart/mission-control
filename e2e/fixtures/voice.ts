import type { VoiceUtterance } from "../../src/shared/voice-routing.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VOICE_LISTENER_PROTOCOL_VERSION,
  type VoiceListenerHello,
} from "../../src/shared/voice.ts";
import type { VoiceModelManifest } from "../../src/shared/voice-models.ts";

interface VoiceDaemon {
  home: string;
  baseURL: string;
}

/**
 * Voice fixtures (contract B of the voice plan): a stand-in listener, so a spec reaches the mode
 * `listening` on any platform with no microphone, model or macOS.
 *
 * Specs speak to the daemon as a listener would, under the daemon's own token, and never start
 * a recognizer.
 */

/** How often the stand-in sends a hello: well inside the daemon's 30 second lapse. */
const HELLO_EVERY_MS = 3000;

/** The hello the stand-in sends: a loaded model and a granted microphone. */
export const LISTENER_HELLO: VoiceListenerHello = {
  backend: "sherpa-onnx",
  version: VOICE_LISTENER_PROTOCOL_VERSION,
  devices: [{ id: "built-in", name: "Built-in microphone", builtIn: true }],
  modelLoaded: true,
  microphone: "granted",
};

export function voiceToken(daemon: VoiceDaemon): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/** Send one hello. Resolves to the daemon's HTTP status. */
export async function sendHello(daemon: VoiceDaemon, hello: Partial<VoiceListenerHello> = {}): Promise<number> {
  const response = await fetch(`${daemon.baseURL}/voice/listener/hello`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": voiceToken(daemon) },
    body: JSON.stringify({ ...LISTENER_HELLO, ...hello }),
  });
  await response.body?.cancel();
  return response.status;
}

export interface Listener {
  /** Stop sending hellos. The daemon reads `unavailable` once the last one lapses. */
  stop(): void;
}

/**
 * Be a listener: send a hello now and every few seconds until stopped. A hello refused while
 * the `voice` flag is off (404) is not an error, so a spec may start this before it turns voice
 * on. Stop it in the test's teardown.
 */
export async function beListener(daemon: VoiceDaemon, hello: Partial<VoiceListenerHello> = {}): Promise<Listener> {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try { await sendHello(daemon, hello); }
    catch { /* the daemon is stopping; the next tick, if any, tries again */ }
  };
  await tick();
  const timer = setInterval(() => void tick(), HELLO_EVERY_MS);
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function postUtterance(daemon: VoiceDaemon, utterance: VoiceUtterance): Promise<Response> {
  const listener = await beListener(daemon, { backend: utterance.backend });
  try {
    return await fetch(`${daemon.baseURL}/voice/utterances`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": voiceToken(daemon) },
      body: JSON.stringify(utterance),
    });
  } finally {
    listener.stop();
  }
}

const lastCapturePost = new Map<string, Promise<Response>>();

/** Post in capture order so a cancel or pick cannot overtake the utterance it acts on. */
export async function say(daemon: VoiceDaemon, text: string, options: Partial<Omit<VoiceUtterance, "text">> = {}): Promise<Response> {
  const utterance = {
    id: crypto.randomUUID(), text, capturedAt: Date.now(), backend: LISTENER_HELLO.backend,
    words: text.trim().split(/\s+/).map((word, i) => ({ text: word, startMs: 100 * i, endMs: 100 * (i + 1) })),
    ...options,
  };
  const post = () => postUtterance(daemon, utterance);
  const previous = lastCapturePost.get(daemon.baseURL);
  const current = previous ? previous.then(post, post) : post();
  lastCapturePost.set(daemon.baseURL, current);
  try {
    return await current;
  } finally {
    if (lastCapturePost.get(daemon.baseURL) === current) lastCapturePost.delete(daemon.baseURL);
  }
}

// ---- a speech model a spec can download ----

const MODEL_REPOSITORY = "fixture/parakeet-e2e";
const MODEL_COMMIT = "e2e0".padEnd(40, "0");

/** How a fixture file is served: whole, with its last byte flipped, or held half-way. */
export type ModelFileBehavior = "ok" | "corrupt" | "hold";

export interface ModelServer {
  /** `MISSION_VOICE_MODEL_BASE_URL` and `MISSION_VOICE_MODEL_MANIFEST` for the daemon. */
  env: Record<string, string>;
  manifest: VoiceModelManifest;
  /** The large file, which carries the visible progress. */
  largeFile: string;
  /** A small file, the one a spec corrupts. */
  smallFile: string;
  /** Serve `file` (a manifest `path`) this way from now on. */
  serve(file: string, behavior: ModelFileBehavior): void;
  release(): void;
  /** Every file requested, as manifest paths, in order. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * A stand-in for Hugging Face: three small model files, a manifest pinning them the way the real
 * one pins Parakeet, and a server the daemon is pointed at. No spec downloads the real model.
 *
 * The daemon reads both variables at launch, so start this before the daemon (as a fixture the
 * `daemonEnv` option depends on) and keep it for the test's life.
 */
export async function startModelServer(): Promise<ModelServer> {
  const files = [
    { file: "Encoder.mlmodelc/weights/weight.bin", body: randomBytes(4 * 1024 * 1024) },
    { file: "Encoder.mlmodelc/coremldata.bin", body: randomBytes(600) },
    { file: "parakeet_vocab.json", body: randomBytes(18 * 1024) },
  ];
  const pathOf = (file: string) => `parakeet-e2e/${file}`;
  const behavior = new Map<string, ModelFileBehavior>();
  const held: Array<() => void> = [];
  const requests: string[] = [];
  const open = new Set<ServerResponse>();
  const prefix = `/${MODEL_REPOSITORY}/resolve/${MODEL_COMMIT}/`;
  const server = createServer((request, response) => {
    const file = (request.url ?? "").startsWith(prefix) ? request.url!.slice(prefix.length) : "";
    const entry = files.find((candidate) => candidate.file === file);
    if (!entry) {
      response.writeHead(404).end();
      return;
    }
    requests.push(pathOf(file));
    open.add(response);
    response.on("close", () => open.delete(response));
    const how = behavior.get(pathOf(file)) ?? "ok";
    if (how === "corrupt") {
      const bad = Buffer.from(entry.body);
      bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
      response.writeHead(200, { "content-length": bad.length }).end(bad);
      return;
    }
    response.writeHead(200, { "content-length": entry.body.length });
    if (how === "hold") {
      const half = Math.floor(entry.body.length / 2);
      response.write(entry.body.subarray(0, half));
      held.push(() => { if (!response.destroyed) response.end(entry.body.subarray(half)); });
      return;
    }
    response.end(entry.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manifest: VoiceModelManifest = {
    revision: "parakeet-e2e-fixture",
    label: "Parakeet fixture",
    sources: [{ repository: MODEL_REPOSITORY, commit: MODEL_COMMIT, license: "CC-BY-4.0", basedOn: "fixture/parakeet" }],
    files: files.map((entry) => ({
      path: pathOf(entry.file),
      url: `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_COMMIT}/${entry.file}`,
      bytes: entry.body.length,
      sha256: createHash("sha256").update(entry.body).digest("hex"),
    })),
  };
  const dir = mkdtempSync(join(tmpdir(), "mission-e2e-voice-model-"));
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ fluidaudio: manifest, "sherpa-onnx": manifest }));
  return {
    env: { MISSION_VOICE_MODEL_BASE_URL: origin, MISSION_VOICE_MODEL_MANIFEST: manifestPath },
    manifest,
    largeFile: pathOf(files[0]!.file),
    smallFile: pathOf(files[2]!.file),
    serve: (file, how) => { behavior.set(file, how); },
    release: () => { for (const finish of held.splice(0)) finish(); },
    requests,
    close: async () => {
      for (const finish of held.splice(0)) finish();
      for (const response of open) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- a stand-in for the two decision-model providers (Phase 4) ----

/** One request a decision provider received. */
export interface DecisionRequest {
  path: string;
  /** The bearer key it carried. A spec asserts which key reached which provider. */
  key: string | null;
  model: unknown;
}

export interface DecisionServer {
  /** `MISSION_VOICE_OPENAI_DECISIONS_URL` and `MISSION_VOICE_JEV_URL` for the daemon. */
  env: Record<string, string>;
  requests: DecisionRequest[];
  close(): Promise<void>;
}

/**
 * Answer as OpenAI Decisions (`POST /v1/decisions`) and Jev (`POST /v1/systemone`) do, in their
 * documented reply shapes, so a spec drives the decision-model rung with no real provider. A
 * split question is answered "split" when the speech turns to the second name with a comma
 * ("…, and Alice, review the PR"), else "mention"; any other question is answered with its first
 * choice at a confidence below every floor, which the daemon reads as "not sure".
 */
export async function startDecisionServer(): Promise<DecisionServer> {
  const requests: DecisionRequest[] = [];
  const verdict = (instructions: string, input: string | undefined): { choice: string; confidence: number } => {
    const second = /Later it names (.+?)\. Decide/.exec(instructions)?.[1];
    const speech = /^Speech a person said to a team of AI agents: (".*")$/m.exec(input ?? "")?.[1];
    if (!second || !speech) return { choice: "not sure", confidence: 0.4 };
    const text = JSON.parse(speech) as string;
    const split = new RegExp(`[,.;]\\s*(?:and\\s+|then\\s+)?${second},`).test(text);
    return { choice: split ? "split" : "mention", confidence: 0.99 };
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        model?: unknown;
        input?: string;
        state?: string;
        questions?: { name?: string; instructions: string }[] | Record<string, { instructions: string }>;
      };
      const auth = request.headers.authorization ?? null;
      requests.push({ path: request.url ?? "", key: auth?.replace(/^Bearer /, "") ?? null, model: body.model });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/decisions" && Array.isArray(body.questions)) {
        response.end(JSON.stringify({
          answers: body.questions.map((question) => ({ type: "choice", name: question.name ?? null, ...verdict(question.instructions, body.input), probabilities: [] })),
          model: body.model,
          usage: { input_tokens: 1, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1 },
        }));
        return;
      }
      if (request.url === "/v1/systemone" && body.questions && !Array.isArray(body.questions)) {
        response.end(JSON.stringify({
          model: body.model,
          answers: Object.fromEntries(Object.entries(body.questions).map(([name, question]) =>
            [name, { type: "choice", ...verdict(question.instructions, body.state), probabilities: {} }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    env: { MISSION_VOICE_OPENAI_DECISIONS_URL: origin, MISSION_VOICE_JEV_URL: origin },
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
