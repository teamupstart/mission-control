import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE_URL, readClientToken } from "@shared/harness-runtime.mjs";
import { FeatureFlagsConfigSchema, resolveFeatureFlags } from "@shared/feature-flags.ts";
import { HEADLESS_MODE_FLAG_ID } from "@shared/home-dispatch.ts";
import { findCommand, usageText } from "./commands/index.ts";
import { EXIT, type CommandContext } from "./types.ts";

export const FLAG_OFF_MESSAGE = "headless-mode is off: run mctl setup";
export const DAEMON_DOWN_MESSAGE = "Mission Control is not running: start the app, or run mctl setup --service";

export type FlagState = "on" | "off" | "unreachable";

/** Reads the flag from the daemon on every invocation. Never from `process.env`, never cached. */
export async function readHeadlessFlag(fetchFn: typeof fetch = fetch): Promise<FlagState> {
  try {
    const res = await fetchFn(BASE_URL + "/api/feature-flags", {
      headers: { "x-harness-token": readClientToken(), "x-mission-operation-surface": "cli" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "unreachable";
    const body = (await res.json()) as { config?: unknown };
    const config = FeatureFlagsConfigSchema.safeParse(body.config);
    if (!config.success) return "unreachable";
    return resolveFeatureFlags(config.data)[HEADLESS_MODE_FLAG_ID] === true ? "on" : "off";
  } catch {
    return "unreachable";
  }
}

export interface MainDeps {
  io?: Pick<CommandContext, "stdout" | "stderr" | "env">;
  readFlag?: () => Promise<FlagState>;
}

/** Runs one `mctl` invocation and returns its exit code. */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const io = deps.io ?? { stdout: process.stdout, stderr: process.stderr, env: process.env };
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    io.stdout.write(usageText());
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const spec = findCommand(name);
  if (!spec) {
    io.stderr.write(`mctl: unknown command ${name}\n${usageText()}`);
    return EXIT.usage;
  }
  if (spec.needsFlag) {
    const state = await (deps.readFlag ?? readHeadlessFlag)();
    if (state === "unreachable") {
      io.stderr.write(DAEMON_DOWN_MESSAGE + "\n");
      return EXIT.failed;
    }
    if (state === "off") {
      io.stderr.write(FLAG_OFF_MESSAGE + "\n");
      return EXIT.usage;
    }
  }
  const mod = await spec.load();
  return mod.run({ args, ...io });
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { process.stderr.write(`mctl: ${String(error)}\n`); process.exitCode = EXIT.failed; },
  );
}
