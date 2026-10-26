import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BINARY_REPO, MAX_BINARY_ASSET_BYTES, type BinaryAsset } from "../shared/binary-distribution.mjs";

/** gh owns native authentication and strips credentials on cross-host redirects.
 * Only canonical asset IDs reach it; no downloaded URL or token enters argv. */
export async function downloadBinaryAsset(options: {
  command: string; env: NodeJS.ProcessEnv; asset: BinaryAsset; path: string;
  signal: AbortSignal; onBytes(received: number, total: number): void; timeoutMs?: number;
}): Promise<void> {
  const {asset, signal} = options;
  if (!/^[1-9]\d{0,31}$/.test(asset.id) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_BINARY_ASSET_BYTES) throw new Error("Invalid canonical asset");
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {...options.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1"};
  delete env.GH_DEBUG; delete env.DEBUG;
  const child = spawn(options.command, ["api", "--hostname", "github.com", `repos/${BINARY_REPO}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"], {env, stdio: ["ignore", "pipe", "pipe"]});
  const completion = new Promise<boolean>(done => {child.once("error", () => done(false)); child.once("close", code => done(code === 0));});
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length); });
  let timedOut = false;
  const stop = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", stop, {once: true});
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 15 * 60_000);
  const hash = createHash("sha256");
  let received = 0;
  let lastProgress = 0;
  try {
    options.onBytes(0, asset.bytes);
    await pipeline(child.stdout, new Transform({transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > asset.bytes) return done(new Error("Downloaded asset exceeds its declared size"));
      hash.update(chunk);
      if (Date.now() - lastProgress >= 100 || received === asset.bytes) { options.onBytes(received, asset.bytes); lastProgress = Date.now(); }
      done(null, chunk);
    }}), createWriteStream(options.path, {flags: "wx", mode: 0o600}), {signal});
    const succeeded = await completion;
    signal.throwIfAborted();
    if (timedOut) throw new Error("Binary download timed out. Check again to retry.");
    if (!succeeded) {
      if (/HTTP 404/.test(stderr)) throw new Error("The accepted binary asset expired or is unavailable. Check for a new offer.");
      if (/HTTP 401|authenticat|gh auth login/i.test(stderr)) throw new Error("GitHub CLI is not authenticated. Run gh auth login, then check again.");
      if (/rate limit|HTTP 429/i.test(stderr)) throw new Error("GitHub rate limited the binary download. Check again later.");
      throw new Error("The binary download failed. Check GitHub access and try again.");
    }
    if (received !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error("The binary download was truncated or failed its SHA-256 check. The installed app is unchanged.");
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", stop);
    if (child.exitCode === null) stop();
    await completion;
  }
}
