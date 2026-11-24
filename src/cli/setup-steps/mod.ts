import { join } from "node:path";
import { MOD_NAME } from "../../mod/constants.ts";
import { findClaude, type ClaudeCli } from "../claude-cli.ts";
import { stageMod } from "../../server/mod-stage.ts";
import { MOD_PLUGIN_ID, checkModCallsAt, claudeCommand, readInstalledMod, recoveryCommands } from "./checks.ts";
import { resolveDeps, type SetupDeps } from "./context.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";

// Owner: P14. Finds `claude`, stages the built mod by rename, and installs it at user scope.
export const id = "mod" as const;
export const owner = "P14" as const;
export const implemented = true;

/** The phrases for a marketplace that is already registered, and nothing broader. */
const ALREADY_ADDED = /\balready (?:been )?(?:added|registered)\b|\bmarketplace\s+["'][^"'\n]+["']\s+already exists\b/i;
/** Words that qualify or contradict it ("already registered but unreadable"): the add did not succeed. */
const QUALIFIED = /\b(?:but|however|though|unless|except|unreadable|invalid|corrupt|malformed|cannot|can't|could not|couldn't|failed|failure|error|denied|locked|not)\b/i;

/** Only an unambiguous "already registered" is a no-op; anything qualified is a failed add. */
function isAlreadyAdded(text: string): boolean {
  return ALREADY_ADDED.test(text) && !QUALIFIED.test(text);
}

const failed = (message: string): SetupStepResult => ({ id, status: "failed", message });

/** A failed install: the cause and the two commands that finish it by hand. */
function installFailure(cause: string, stateDir: string, claude: string): SetupStepResult {
  const [add, install] = recoveryCommands(stateDir, claude);
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
  const bin = claudeCommand(claude);
  const modDir = join(deps.stateDir, "mod");

  let version: string;
  try {
    version = (
      await stageMod({
        source: deps.modSource,
        dest: modDir,
        // The copy must pass the same `mod-calls` check doctor runs, with `claude plugin validate`,
        // before it replaces anything: a build setup cannot certify never displaces a working one.
        validate: async (staging) => {
          const check = await checkModCallsAt(claude, deps, join(staging, MOD_NAME));
          if (check.status === "fail") throw new Error(check.message + ". " + (check.fix ?? ""));
          // The marketplace is what `marketplace add` reads; let claude refuse it now, not after the swap.
          const market = await deps.exec(claude.path, ["plugin", "validate", staging], { timeoutMs: 30_000 });
          if (market.code !== 0) throw new Error("`claude plugin validate` refused the marketplace: " + describe(market) + ". Rebuild with `npm run build`, then run `mctl setup`.");
        },
      })
    ).version;
  } catch (error) {
    return failed("could not stage the mod; the mod already installed was left as it was: " + (error instanceof Error ? error.message : String(error)));
  }

  const before = await readInstalledMod(claude, deps);
  if ("error" in before) return installFailure(before.error, deps.stateDir, bin);
  const installed = before.mod;
  if (installed && installed.enabled && installed.scope === "user" && installed.version === version) {
    return { id, status: "ok", message: "the mod " + version + " is already installed (claude " + claude.version + ")" };
  }

  // A marketplace that is already added is not an error; any other failure is, even one whose text
  // happens to contain the word "already" ("already locked", "already exists but is unreadable").
  const add = await deps.exec(claude.path, ["plugin", "marketplace", "add", modDir], { timeoutMs: 120_000 });
  if (add.code !== 0 && !isAlreadyAdded(add.stderr + add.stdout)) {
    return installFailure("`claude plugin marketplace add` failed: " + describe(add), deps.stateDir, bin);
  }
  // A stale or disabled user-scope install is replaced by uninstall and install, never `claude plugin
  // update`. An install at another scope is somebody else's and is left alone: the user-scope one is added beside it.
  if (installed && installed.scope === "user") {
    const gone = await claudeStep(claude, deps, ["plugin", "uninstall", MOD_PLUGIN_ID, "--scope", "user"]);
    if (gone) return installFailure(gone, deps.stateDir, bin);
  }
  const install = await claudeStep(claude, deps, ["plugin", "install", MOD_PLUGIN_ID, "--scope", "user"]);
  if (install) return installFailure(install, deps.stateDir, bin);

  // Re-read in a fresh `claude` invocation: the install must show the staged version.
  const after = await readInstalledMod(claude, deps);
  if ("error" in after) return installFailure(after.error, deps.stateDir, bin);
  if (!after.mod || !after.mod.enabled || after.mod.scope !== "user" || after.mod.version !== version) {
    // Name what differs, so a scope problem is not read as a version problem.
    const found = after.mod;
    const problems = found
      ? [
          ...(found.version === version ? [] : ["version " + found.version + " instead of the staged " + version]),
          ...(found.scope === "user" ? [] : [found.scope + " scope instead of user scope"]),
          ...(found.enabled ? [] : ["disabled"]),
        ]
      : ["no entry for the mod"];
    return installFailure("the install finished but `claude plugin list` shows " + problems.join(", "), deps.stateDir, bin);
  }
  const action = installed?.scope === "user" ? "replaced " + installed.version + " with" : "installed";
  return { id, status: "ok", message: action + " the mod " + version + " at user scope (claude " + claude.version + ")" };
}
