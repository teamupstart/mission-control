import { join } from "node:path";
import { findClaude, type ClaudeCli } from "../claude-cli.ts";
import { stageMod } from "../../server/mod-stage.ts";
import { MOD_PLUGIN_ID, readInstalledMod, recoveryCommands } from "./checks.ts";
import { resolveDeps, type SetupDeps } from "./context.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";

// Owner: P14. Finds `claude`, stages the built mod by rename, and installs it at user scope.
export const id = "mod" as const;
export const owner = "P14" as const;
export const implemented = true;

const failed = (message: string): SetupStepResult => ({ id, status: "failed", message });

/** A failed install: the cause and the two commands that finish it by hand. */
function installFailure(cause: string, stateDir: string): SetupStepResult {
  const [add, install] = recoveryCommands(stateDir);
  return failed(cause + "\nTo finish by hand, run:\n  " + add + "\n  " + install);
}

function describe(result: { code: number; stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || "exit " + result.code;
}

async function claudeStep(claude: ClaudeCli, deps: SetupDeps, args: string[]): Promise<string | null> {
  const result = await deps.exec(claude.path, args, { timeoutMs: 120_000 });
  return result.code === 0 ? null : "`claude " + args.slice(0, 2).join(" ") + "` failed: " + describe(result);
}

export async function run(options: SetupStepOptions): Promise<SetupStepResult> {
  const deps = resolveDeps(options.deps);
  const found = await findClaude({ env: deps.env, exec: deps.exec, home: deps.home });
  if (!found.claude) {
    const why = found.rejected.length > 0 ? " (" + found.rejected.join("; ") + ")" : "";
    return failed("the claude CLI was not found" + why + ". Install Claude Code or set MISSION_CLAUDE_BIN, then run `mctl setup` again; the mod was not installed.");
  }
  const claude = found.claude;
  const modDir = join(deps.stateDir, "mod");

  let version: string;
  try {
    version = (await stageMod({ source: deps.modSource, dest: modDir })).version;
  } catch (error) {
    return failed("could not stage the mod: " + (error instanceof Error ? error.message : String(error)));
  }

  const before = await readInstalledMod(claude, deps);
  if ("error" in before) return installFailure(before.error, deps.stateDir);
  const installed = before.mod;
  if (installed && installed.enabled && installed.scope === "user" && installed.version === version) {
    return { id, status: "ok", message: "the mod " + version + " is already installed (claude " + claude.version + ")" };
  }

  // A marketplace that is already added is not an error.
  const add = await deps.exec(claude.path, ["plugin", "marketplace", "add", modDir], { timeoutMs: 120_000 });
  if (add.code !== 0 && !/already/i.test(add.stderr + add.stdout)) {
    return installFailure("`claude plugin marketplace add` failed: " + describe(add), deps.stateDir);
  }
  // A stale or disabled user-scope install is replaced by uninstall and install, never `claude plugin
  // update`. An install at another scope is somebody else's and is left alone: the user-scope one is added beside it.
  if (installed && installed.scope === "user") {
    const gone = await claudeStep(claude, deps, ["plugin", "uninstall", MOD_PLUGIN_ID, "--scope", "user"]);
    if (gone) return installFailure(gone, deps.stateDir);
  }
  const install = await claudeStep(claude, deps, ["plugin", "install", MOD_PLUGIN_ID, "--scope", "user"]);
  if (install) return installFailure(install, deps.stateDir);

  // Re-read in a fresh `claude` invocation: the install must show the staged version.
  const after = await readInstalledMod(claude, deps);
  if ("error" in after) return installFailure(after.error, deps.stateDir);
  if (!after.mod || !after.mod.enabled || after.mod.scope !== "user" || after.mod.version !== version) {
    const seen = after.mod ? after.mod.version + (after.mod.enabled ? "" : ", disabled") + (after.mod.scope === "user" ? "" : ", " + after.mod.scope + " scope") : "nothing";
    return installFailure("the install finished but `claude plugin list` shows " + seen + ", not " + version, deps.stateDir);
  }
  const action = installed?.scope === "user" ? "replaced " + installed.version + " with" : "installed";
  return { id, status: "ok", message: action + " the mod " + version + " at user scope (claude " + claude.version + ")" };
}
