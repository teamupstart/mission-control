import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { VOICE_HELLO_INTERVAL_MS, VOICE_LISTENER_PROTOCOL_VERSION, type VoiceListenerDirective, type VoiceListenerHello } from "../../src/shared/voice.ts";
import type { VoiceUtterance } from "../../src/shared/voice-routing.ts";

/** The same HTTP client can drive an in-process Hono app or a daemon on loopback. */
export class FakeVoiceListener {
  constructor(private readonly url: string, private readonly tokenFile: string,
    private readonly send: (url: string, init: RequestInit) => Promise<Response> = fetch) {}

  private request(path: string, body?: unknown) {
    return this.send(new URL(path, this.url).href, {
      headers: { "x-harness-token": readFileSync(this.tokenFile, "utf8").trim(), "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  }

  hello(overrides: Partial<VoiceListenerHello> = {}) {
    return this.request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION, backend: "fluidaudio",
      modelLoaded: true, microphone: "granted", primingAvailable: false, devices: [], ...overrides });
  }

  async poll(revision?: string): Promise<VoiceListenerDirective> {
    const response = await this.request("/voice/listener/directive" + (revision ? "?revision=" + encodeURIComponent(revision) : ""));
    if (!response.ok) throw new Error("Directive HTTP " + response.status);
    return await response.json() as VoiceListenerDirective;
  }

  utterance(text: string, words: VoiceUtterance["words"], revision: string) {
    return this.request("/voice/utterances?revision=" + encodeURIComponent(revision),
      { text, words, id: crypto.randomUUID(), capturedAt: Date.now(), backend: "fluidaudio" });
  }
}

// A supervisor test can launch this file with node --import tsx and the real
// three-variable contract. An IPC parent can observe the directives it applied.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { MISSION_VOICE_DAEMON_URL: url, MISSION_VOICE_TOKEN_FILE: file } = process.env;
  if (!url || !file) throw new Error("Missing voice listener connection settings");
  const fake = new FakeVoiceListener(url, file);
  const heartbeat = async () => {
    if (!(await fake.hello()).ok) throw new Error("Listener hello refused");
  };
  await heartbeat();
  const timer = setInterval(heartbeat, VOICE_HELLO_INTERVAL_MS);
  try {
    let revision: string | undefined;
    for (;;) {
      const directive = await fake.poll(revision);
      process.send?.(directive);
      revision = directive.revision;
    }
  } finally {
    clearInterval(timer);
  }
}
