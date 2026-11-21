// Bundled by smoke with the daemon's build flags, then loaded outside node_modules.
import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultPiSdkDeps } from "../../src/server/harness/pi/sdk-deps.ts";
export { defaultPiSdkDeps };

export async function verifyBundledOAuth(directory: string): Promise<void> {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("OAuth bundle probe must never use the network"); };
  try {
    await defaultPiSdkDeps.load();
    const credential = { type: "oauth" as const, access: "synthetic-access", refresh: "synthetic-refresh",
      expires: Date.now() + 3_600_000 };
    const runtime = await ModelRuntime.create({
      modelsPath: null, modelsStorePath: `${directory}/models-cache.json`, refreshOnCreate: false,
      credentials: {
        async read() { return credential; },
        async list() { return ["openai-codex", "anthropic"].map((providerId) => ({ providerId, type: "oauth" as const })); },
        async modify(_id, fn) { return await fn(credential); },
        async delete() { throw new Error("probe cannot delete credentials"); },
      },
    });
    for (const provider of ["openai-codex", "anthropic"]) {
      const result = await runtime.getAuth(provider, { env: {} });
      assert.equal(result?.auth.apiKey, credential.access, `${provider} derives OAuth request auth inside the bundle`);
    }
  } finally {
    globalThis.fetch = fetch;
  }
}
