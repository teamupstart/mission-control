import { OPEN_TARGET_IDS, type OpenTargetId, type OpenTargetView } from "@shared/open-targets.ts";
import { run } from "../util/exec.ts";
import { locateCommandSync } from "../executables/locator.ts";
import { browserTarget } from "./browser.ts";
import type { OpenDeps, OpenTargetImpl } from "./types.ts";

// The registry of "Open in" implementations - the server half of the split
// `OPEN_TARGET_INFO` (@shared/open-targets.ts) makes: that record holds what the browser
// can answer about a target, and each implementation spreads its own info in and adds the
// one call that has to look at the machine.
//
// Reach a target through `openTargetViews` / `openFile` below, never by testing an id at
// a call site.

/**
 * Every target's implementation.
 *
 * `Record<OpenTargetId, …>` is the enforcement: an id appended to `OPEN_TARGET_IDS` does
 * not compile until something here can actually open a file with it. The alternative - a
 * lookup that returns undefined - is a row the menu offers and the daemon silently drops.
 */
export const OPEN_TARGETS: Record<OpenTargetId, OpenTargetImpl> = {
  browser: browserTarget,
};

export const defaultOpenDeps: OpenDeps = {
  run,
  platform: process.platform,
  env: process.env,
  installed: (bin) => locateCommandSync(bin) !== null,
  resolveBin: (bin) => locateCommandSync(bin)?.path ?? null,
};

/**
 * Resolve one target, mapping a thrown implementation into the refusal it should have
 * returned. A target that throws must not take the whole menu down with it - the other
 * rows are still perfectly answerable.
 */
async function resolveTarget(id: OpenTargetId, deps: OpenDeps) {
  try {
    return await OPEN_TARGETS[id].resolve(deps);
  } catch (error) {
    return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Every registered target with its availability on THIS machine - what the menu draws.
 *
 * Nothing is cached, for `binPresent`'s reason: an operator who installs a browser, or
 * changes their default one, should not have to restart the daemon to see the menu agree.
 * The cost is bounded by the number of registered targets and paid only when a files view
 * is opened, not on any tick.
 */
export async function openTargetViews(deps: OpenDeps = defaultOpenDeps): Promise<OpenTargetView[]> {
  return Promise.all(
    OPEN_TARGET_IDS.map(async (id): Promise<OpenTargetView> => {
      const target = OPEN_TARGETS[id];
      const resolved = await resolveTarget(id, deps);
      return {
        id: target.id,
        label: target.label,
        blurb: target.blurb,
        glyph: target.glyph,
        unavailable: resolved.ok ? null : resolved.reason,
        detail: resolved.ok ? resolved.launcher.detail : null,
      };
    }),
  );
}

export interface OpenFileOutcome {
  ok: boolean;
  label: string;
  detail: string | null;
  error?: string;
  /** HTTP status for the route: 409 when the machine cannot, 502 when the launch failed. */
  status: number;
}

/**
 * Hand one already-resolved absolute path to a target.
 *
 * The path is NOT validated here - `resolveSessionFilePath` (`session-files.ts`) has
 * already realpath'd it inside the session's checkout, which is the same containment every
 * read and save goes through. Keeping that in one place is deliberate: a second
 * "is this file allowed" check written here would be a second place to get it wrong.
 */
export async function openFile(
  id: OpenTargetId,
  file: string,
  deps: OpenDeps = defaultOpenDeps,
): Promise<OpenFileOutcome> {
  const target = OPEN_TARGETS[id];
  const resolved = await resolveTarget(id, deps);
  if (!resolved.ok) {
    return { ok: false, label: target.label, detail: null, error: resolved.reason, status: 409 };
  }
  const { bin, args } = resolved.launcher.command(file);
  const detail = resolved.launcher.detail;
  // Launchers hand the file to an already-running (or freshly started) application and
  // exit; they do not stay attached to it, so waiting for one is bounded and cheap.
  const result = await deps.run(bin, args, { timeoutMs: 15_000, env: deps.env });
  if (result.code === 0) return { ok: true, label: target.label, detail, status: 200 };
  if (result.outcomeUnknown) {
    // `run`'s narrowing flag, honoured: the child never reported its own exit, so the file
    // may well be open already. Saying "failed" would send the human to look for a bug in
    // a launch that worked, so this says what is actually known.
    return {
      ok: false,
      label: target.label,
      detail,
      error: `${bin} did not report back within 15s - ${detail ?? "the application"} may still be opening`,
      status: 504,
    };
  }
  return {
    ok: false,
    label: target.label,
    detail,
    error: result.stderr.trim() || `${bin} exited ${result.code}`,
    status: 502,
  };
}
