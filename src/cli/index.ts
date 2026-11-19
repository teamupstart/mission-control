import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE_URL, readClientToken } from "@shared/harness-runtime.mjs";
import { FeatureFlagsConfigSchema, resolveFeatureFlags } from "@shared/feature-flags.ts";
import { HEADLESS_MODE_FLAG_ID } from "@shared/home-dispatch.ts";
import { findCommand, usageText } from "./commands/index.ts";
import { EXIT, type CommandContext } from "./types.ts";

export const FLAG_OFF_MESSAGE = "headless-mode is off: run mctl setup";
export const DAEMON_DOWN_MESSAGE = "Mission Control is not running: start the app, or run mctl setup --service";

/**
 * `unreachable`: no answer at all. `{ error }`: the daemon answered, but not with the flag (a 5xx,
 * or a 401 from a stale token), which is not the same trouble and must not read as "not running".
 */
export type FlagState = "on" | "off" | "unreachable" | { error: string };

export const daemonErrorMessage = (detail: string): string => "mctl: Mission Control answered with an error: " + detail;

/** Reads the flag from the daemon on every invocation. Never from `process.env`, never cached. */
export async function readHeadlessFlag(fetchFn: typeof fetch = fetch): Promise<FlagState> {
  try {
    const res = await fetchFn(BASE_URL + "/api/feature-flags", {
      headers: { "x-harness-token": readClientToken(), "x-mission-operation-surface": "cli" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const stale = res.status === 401 || res.status === 403 ? " (the client token may be stale: restart Mission Control)" : "";
      return { error: "HTTP " + res.status + stale };
    }
    // The daemon answered, so a body that is not JSON is its error, not a missing daemon.
    let body: { config?: unknown };
    try {
      body = (await res.json()) as { config?: unknown };
    } catch {
      return { error: "the feature-flag answer it sent was not valid JSON" };
    }
    // The real route always sends `{ config }`; the schema's defaults must not turn a missing one into "off".
    if (typeof body !== "object" || body === null || !("config" in body)) {
      return { error: "the feature-flag config it sent could not be read" };
    }
    const config = FeatureFlagsConfigSchema.safeParse(body.config);
    if (!config.success) return { error: "the feature-flag config it sent could not be read" };
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
    if (typeof state === "object") {
      io.stderr.write(daemonErrorMessage(state.error) + "\n");
      return EXIT.failed;
    }
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
