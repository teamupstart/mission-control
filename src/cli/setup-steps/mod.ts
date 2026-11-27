import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MOD_NAME } from "../../mod/constants.ts";
import { findClaude, type ClaudeCli } from "../claude-cli.ts";
import { readModVersion, refuseCheckoutDestination, stageMod, withModLock } from "../../server/mod-stage.ts";
import { MOD_PLUGIN_ID, checkModCallsAt, claudeCommand, readInstalledMod, readModMarketplace, recoveryCommands } from "./checks.ts";
import { resolveDeps, type SetupDeps } from "./context.ts";
import type { DoctorCheck, SetupStepOptions, SetupStepResult } from "./types.ts";

// Owner: P14. Finds `claude`, stages the built mod by rename, and installs it at user scope.
export const id = "mod" as const;
export const owner = "P14" as const;
export const implemented = true;

/**
 * What a marketplace add that changes nothing prints, line for line and with nothing else: a
 * marketplace "already added", "already registered" or (named) "already exists". A whitelist, not a
 * list of bad words: any further text ("...; unable to read manifest", "... but is invalid") is not on
 * it, so such an add counts as the failure it may be.
 */
const ALREADY_ADDED_LINE = /^(?:[^\w\s]\s*)?(?:(?:the\s+)?marketplace\s+(?:["'][^"'\n]+["']\s+)?)?(?:is\s+)?already\s+(?:been\s+)?(?:added|registered|exists)\.?$/i;

function isAlreadyAdded(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => ALREADY_ADDED_LINE.test(l));
}

/** The files that make up a mod build, compared byte for byte to tell whether staging would change anything. */
const BUILD_FILES = [
  join(".claude-plugin", "marketplace.json"),
  join(MOD_NAME, ".claude-plugin", "plugin.json"),
  join(MOD_NAME, "hooks", "hooks.json"),
  join(MOD_NAME, "hooks", "register.js"),
  join(MOD_NAME, "hooks", "mod-calls.json"),
  join(MOD_NAME, "types", "index.d.ts"),
];

/**
 * Whether the published mod is already exactly this build. Then staging would copy, validate and swap
 * the same bytes back in, and the swap's moment with no mod at the published path would be paid for
 * nothing. Any difference, or any file that cannot be read, means stage as usual.
 */
async function publishedIsCurrent(source: string, published: string): Promise<boolean> {
  // A file both sides lack is the same; one that only a side has, or cannot be read, is a difference.
  const read = (path: string) => readFile(path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  try {
    for (const file of BUILD_FILES) {
      const [a, b] = await Promise.all([read(join(source, file)), read(join(published, file))]);
      if (a === null || b === null ? a !== b : !a.equals(b)) return false;
    }
    // A build always has its plugin manifest; two folders lacking it are not a mod to skip over.
    return (await read(join(source, MOD_NAME, ".claude-plugin", "plugin.json"))) !== null;
  } catch {
    return false;
  }
}

const failed = (message: string): SetupStepResult => ({ id, status: "failed", message });

/** A failed install: the cause and the two commands that finish it by hand. */
function installFailure(cause: string, stateDir: string, claude: string, replacing = false): SetupStepResult {
  const [add, install] = recoveryCommands(stateDir, claude);
  // A plain install does not replace an installed build, so replacing one starts with the uninstall.
  const steps = replacing ? ["" + claude + " plugin uninstall " + MOD_PLUGIN_ID + " --scope user", add, install] : [add, install];
  return failed(cause + "\nTo finish by hand, run:\n  " + steps.join("\n  "));
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

  // Staging and the `claude plugin` calls after it are one sequence on one shared state: a second
  // `mctl setup` waits for this one, rather than acting on the same stale listing and undoing it.
  try {
    // Refused before the lock is taken: the lock is a folder beside the destination.
    await refuseCheckoutDestination(modDir, deps.home);
    return await withModLock(modDir, () => installLocked(claude, bin, deps, modDir));
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

async function installLocked(claude: ClaudeCli, bin: string, deps: SetupDeps, modDir: string): Promise<SetupStepResult> {
  // A registration that points somewhere else is refused before anything is staged: a refusal is a no-op.
  const marketplace = await readModMarketplace(claude, deps);
  if ("error" in marketplace) return failed(marketplace.error);
  if (marketplace.path !== null && marketplace.path !== modDir) {
    return failed(`The mission-control marketplace points to ${marketplace.path}, not ${modDir}. Remove it before running setup.`);
  }

  let version: string;
  // The verdict on the copy about to be published. It is kept for the closing doctor step only once
  // the publish has succeeded: until then the published mod may still be the old build, or absent.
  let certified: DoctorCheck | null = null;
  try {
    if (await publishedIsCurrent(deps.modSource, modDir)) {
      // Already published and certified when it was staged: nothing to copy, validate or swap.
      version = await readModVersion(modDir);
    } else version = (
      await stageMod({
        source: deps.modSource,
        dest: modDir,
        locked: true,
        home: deps.home,
        // The copy must pass the same `mod-calls` check doctor runs, with `claude plugin validate`,
        // before it replaces anything: a build setup cannot certify never displaces a working one.
        validate: async (staging) => {
          const check = await checkModCallsAt(claude, deps, join(staging, MOD_NAME));
          if (check.status === "fail") throw new Error(check.message + ". " + (check.fix ?? ""));
          certified = check;
          // The marketplace is what `marketplace add` reads; let claude refuse it now, not after the swap.
          const market = await deps.exec(claude.path, ["plugin", "validate", staging], { timeoutMs: 30_000 });
          if (market.code !== 0) throw new Error("`claude plugin validate` refused the marketplace: " + describe(market) + ". Rebuild with `npm run build`, then run `mctl setup`.");
        },
      })
    ).version;
  } catch (error) {
    return failed("could not stage the mod; the mod already installed was left as it was: " + (error instanceof Error ? error.message : String(error)));
  }

  if (deps.runCache && certified) deps.runCache.modCalls = certified;
  const before = await readInstalledMod(claude, deps);
  if ("error" in before) return installFailure(before.error, deps.stateDir, bin);
  const installed = before.mod;
  const replacing = installed?.scope === "user";
  if (marketplace.path === modDir && installed && installed.enabled && installed.scope === "user" && installed.version === version) {
    // Right version, right scope, but it did not load: installing the same build again would not change
    // that, so say so rather than print "installed" and let the closing check contradict it.
    if (installed.errors.length > 0) {
      return failed("the mod " + version + " is installed at user scope but failed to load: " + installed.errors.join("; ") + ". Installing the same build again would not change that; fix the error, then run `mctl setup`.");
    }
    if (deps.runCache) deps.runCache.installed = before;
    return { id, status: "ok", message: "the mod " + version + " is already installed (claude " + claude.version + ")" };
  }

  // A marketplace that is already added is not an error; any other failure is, even one whose text
  // happens to contain the word "already" ("already locked", "already exists but is unreadable").
  const add = await deps.exec(claude.path, ["plugin", "marketplace", "add", modDir], { timeoutMs: 120_000 });
  if (add.code !== 0 && !isAlreadyAdded(add.stderr + add.stdout)) {
    return installFailure("`claude plugin marketplace add` failed: " + describe(add), deps.stateDir, bin, replacing);
  }
  const registered = await readModMarketplace(claude, deps);
  if ("error" in registered || registered.path !== modDir) {
    const detail = "error" in registered ? registered.error : `the registered marketplace source is ${registered.path ?? "missing"}, not ${modDir}`;
    return installFailure(detail, deps.stateDir, bin, replacing);
  }
  // A stale or disabled user-scope install is replaced by uninstall and install, never `claude plugin
  // update`. An install at another scope is somebody else's and is left alone: the user-scope one is added beside it.
  if (installed && installed.scope === "user") {
    const gone = await claudeStep(claude, deps, ["plugin", "uninstall", MOD_PLUGIN_ID, "--scope", "user"]);
    if (gone) return installFailure(gone, deps.stateDir, bin, true);
  }
  let install = await claudeStep(claude, deps, ["plugin", "install", MOD_PLUGIN_ID, "--scope", "user"]);
  if (install) install = await claudeStep(claude, deps, ["plugin", "install", MOD_PLUGIN_ID, "--scope", "user"]);
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
  if (deps.runCache) deps.runCache.installed = after;
  const action = installed?.scope === "user" ? "replaced " + installed.version + " with" : "installed";
  return { id, status: "ok", message: action + " the mod " + version + " at user scope (claude " + claude.version + ")" };
}
