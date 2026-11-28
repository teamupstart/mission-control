import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VOICE_TEST_MODEL, type VoiceModelFile } from "../../src/shared/voice-models.ts";
import { systemTempDir } from "../temp-root.mjs";

class ModelIntegrityError extends Error {}

async function verify(path: string, file: VoiceModelFile) {
  if ((await stat(path)).size !== file.bytes) throw new ModelIntegrityError("Wrong size: " + file.path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== file.sha256) throw new ModelIntegrityError("Wrong digest: " + file.path);
}

export async function ensureCachedModelFile(root: string, file: VoiceModelFile, download: boolean): Promise<boolean> {
  const path = join(root, file.path);
  try {
    await verify(path, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!download) return false;
    } else if (!download || !(error instanceof ModelIntegrityError)) {
      throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID();
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(file.path + ": HTTP " + response.status);
        }
        const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
        await pipeline(body, createWriteStream(temp, { flags: "wx" }));
        await verify(temp, file);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await rm(temp, { force: true });
      }
    }
    await rename(temp, path);
    return true;
  } finally {
    await rm(temp, { force: true });
  }
}

export async function voiceTestModel(download: boolean): Promise<string | null> {
  const root = resolve(process.env.MISSION_VOICE_TEST_MODEL_DIR || join(systemTempDir(), "mission-voice-test-model", VOICE_TEST_MODEL.revision));
  for (const file of VOICE_TEST_MODEL.files) {
    if (!await ensureCachedModelFile(root, file, download)) return null;
  }
  return root;
}
