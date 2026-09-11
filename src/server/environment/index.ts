import { readdir, open } from "node:fs/promises";
import { homedir } from "node:os";

import {
  ENVIRONMENT_CHECK_IDS,
  type EnvironmentCheckId,
  type EnvironmentCheckView,
} from "@shared/environment-checks.ts";

import { piExtensionCheck } from "./pi-extension.ts";
import { claudeHookScriptCheck } from "./claude-hooks.ts";
import { upstartclawSetupCheck } from "./upstartclaw.ts";
import type {
  EnvironmentCheckImpl,
  EnvironmentCheckResult,
  EnvironmentDeps,
  FileRead,
} from "./types.ts";

// The registry of environment checks - the server half of the split
// `ENVIRONMENT_CHECK_INFO` (@shared/environment-checks.ts) makes: that record holds what the
// browser can say about a check, and each implementation spreads its own info in and adds
// the one call that has to read the machine.
//
// Reach a check through `environmentCheckViews`, never by testing an id at a call site.
// That rule is what keeps the product generic: the dispatch form folds over this list and
// renders whatever warnings come back, so an organisation-specific fact lives in exactly one
// file under this directory and nowhere else in the codebase.

/**
 * Every check's implementation.
 *
 * `Record<EnvironmentCheckId, …>` is the enforcement: an id appended to
 * `ENVIRONMENT_CHECK_IDS` does not compile until something here can actually answer it. The
 * alternative - a lookup returning undefined - is a check the wire shape promises and the
 * daemon silently drops.
 */
export const ENVIRONMENT_CHECKS: Record<EnvironmentCheckId, EnvironmentCheckImpl> = {
  "upstartclaw-core-setup": upstartclawSetupCheck,
  "mission-hook-script": claudeHookScriptCheck,
  "pi-extension": piExtensionCheck,
};

/**
 * How much of any checked file is ever read.
 *
 * The bound exists so a file that is unexpectedly huge - a log someone redirected over a
 * state file, a binary - costs one bounded read instead of its whole size. It is NOT sized to
 * the smallest thing read: a state file holds one word, but Claude Code's install record is
 * JSON that grows about 400 bytes per installed plugin, and a check that has to prove a plugin
 * is installed must not miss its entry because it sat past the window. 64 KB covers roughly
 * 160 installed plugins, which is more than the whole marketplace offers, and costs a single
 * page-sized read on a surface that runs when a dispatch form opens.
 */
const MAX_READ_BYTES = 64 * 1024;

/** ENOENT, or a missing parent directory: both mean "there is no such file". */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `EnvironmentDeps.readText` in production. */
async function readText(path: string): Promise<FileRead> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return { ok: false, missing: isMissing(error), reason: reasonOf(error) };
  }
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_READ_BYTES, 0);
    return {
      ok: true,
      // A checked file is arbitrary bytes, so this can land mid-character and decode the last
      // one as U+FFFD. Harmless for every use here - the values that mean anything are ASCII
      // words, and a check that cannot recognise a value classifies it rather than trusting it.
      text: buf.subarray(0, bytesRead).toString("utf8"),
      // A full buffer may or may not be a truncated file; reporting it as truncated makes any
      // size a check derives a floor rather than a claim, which is the safe direction.
      truncated: bytesRead === MAX_READ_BYTES,
    };
  } catch (error) {
    // Opened but unreadable - a directory where a file was expected, a permission that
    // allows open and not read. `missing: false`: something IS there, and a check that
    // treated this as absence would report the wrong state.
    return { ok: false, missing: false, reason: reasonOf(error) };
  } finally {
    await handle.close();
  }
}

/** `EnvironmentDeps.subdirectories` in production. See the interface for why `[]` on error. */
async function subdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * What the daemon lends a check on this machine.
 *
 * A function rather than a constant so `homedir()` is read per request along with
 * everything else - nothing about this surface is captured at boot. See
 * `environmentCheckViews` for why that matters.
 */
export function defaultEnvironmentDeps(): EnvironmentDeps {
  return { homeDir: homedir(), readText, subdirectories };
}

/**
 * Run one check, mapping a thrown implementation into the warning it should have returned.
 *
 * A check that throws must not take the list down with it - the other checks are still
 * perfectly answerable - and it must not fall silent either: silence is the claim "this
 * machine is fine", which a check that crashed has not earned. So the failure becomes its
 * own note, naming itself as the fault rather than the operator's setup.
 */
async function runCheck(
  impl: EnvironmentCheckImpl,
  deps: EnvironmentDeps,
): Promise<EnvironmentCheckResult> {
  try {
    return await impl.check(deps);
  } catch (error) {
    return {
      warning: `This check could not run: ${reasonOf(error)}. That is a Mission Control fault rather than anything about your machine, and it does not affect dispatch.`,
      detail: null,
    };
  }
}

/**
 * Every registered check against THIS machine - what the dispatch form draws.
 *
 * Nothing is cached, for `openTargetViews`' reason and one sharper one. An operator who
 * fixes what a warning names - runs the setup, finishes the sign-in - must see the note go
 * away without restarting the daemon, and the daemon that boots before they do would
 * otherwise have answered from a snapshot of a machine they have since repaired. The cost is
 * a handful of `stat`-sized reads, paid when a dispatch form opens and on no tick at all;
 * `skillDrift` re-reads the disk on every poll for the same reason.
 */
export async function environmentCheckViews(
  deps: EnvironmentDeps = defaultEnvironmentDeps(),
): Promise<EnvironmentCheckView[]> {
  return Promise.all(
    ENVIRONMENT_CHECK_IDS.map(async (id): Promise<EnvironmentCheckView> => {
      const impl = ENVIRONMENT_CHECKS[id];
      const result = await runCheck(impl, deps);
      return {
        id: impl.id,
        label: impl.label,
        warning: result.warning,
        detail: result.warning === null ? null : result.detail,
      };
    }),
  );
}
