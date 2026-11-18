/**
 * Which terminal app macOS hands a shell to, as the operator chose it.
 *
 * There is no "default terminal" setting in System Settings. The one an operator can set is
 * the LaunchServices shell handler for `public.unix-executable` - what iTerm2's "Make iTerm2
 * Default Term" writes - and it is how Finder decides where a `.command` file opens. Read here
 * so a picker that has to choose a terminal before the operator does can start on the one
 * they already chose for their whole machine, rather than on whichever this registry lists
 * first.
 *
 * Read-only, and every miss reads as "no preference": no entry is what an untouched machine
 * has (Terminal.app, which Mission Control cannot drive), and an unreadable plist is no
 * reason to refuse a launch. The same preference file `open-targets/browser.ts` reads for the
 * default browser.
 */

import { homedir } from "node:os";
import path from "node:path";
import { EMULATOR_IDS, type EmulatorId } from "@shared/terminal.ts";
import type { RunResult } from "../util/exec.ts";
import type { TerminalEmulator } from "./types.ts";

const LAUNCH_SERVICES_PLIST =
  "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist";

/** The UTI a terminal claims to become the macOS default terminal. */
const SHELL_CONTENT_TYPE = "public.unix-executable";

interface LaunchServicesHandler {
  LSHandlerContentType?: unknown;
  LSHandlerRoleShell?: unknown;
  LSHandlerRoleAll?: unknown;
}

/** The bundle id LaunchServices runs `public.unix-executable` with, from `LSHandlers` JSON. */
export function shellHandlerBundle(json: string): string | null {
  let handlers: unknown;
  try {
    handlers = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(handlers)) return null;
  for (const handler of handlers as LaunchServicesHandler[]) {
    if (typeof handler?.LSHandlerContentType !== "string") continue;
    if (handler.LSHandlerContentType.toLowerCase() !== SHELL_CONTENT_TYPE) continue;
    const bundle = handler.LSHandlerRoleShell ?? handler.LSHandlerRoleAll;
    if (typeof bundle === "string" && bundle) return bundle;
  }
  return null;
}

/** The registered emulator whose macOS bundle id is `bundle`, matched case-insensitively. */
export function emulatorForBundle(
  emulators: Partial<Record<EmulatorId, Pick<TerminalEmulator, "macBundleId">>>,
  bundle: string | null,
): EmulatorId | null {
  if (!bundle) return null;
  const wanted = bundle.toLowerCase();
  return EMULATOR_IDS.find((id) => emulators[id]?.macBundleId?.toLowerCase() === wanted) ?? null;
}

export interface SystemDefaultTerminalDeps {
  platform: NodeJS.Platform;
  home: string;
  run(bin: string, args: string[], opts: { timeoutMs: number }): Promise<RunResult>;
  emulators: Partial<Record<EmulatorId, Pick<TerminalEmulator, "macBundleId">>>;
}

/** The emulator macOS treats as the default terminal, or null when it is none of ours. */
export async function systemDefaultEmulator(deps: SystemDefaultTerminalDeps): Promise<EmulatorId | null> {
  if (deps.platform !== "darwin") return null;
  const plist = path.join(deps.home || homedir(), LAUNCH_SERVICES_PLIST);
  const result = await deps.run("plutil", ["-extract", "LSHandlers", "json", "-o", "-", plist], { timeoutMs: 4000 });
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
  return emulatorForBundle(deps.emulators, shellHandlerBundle(result.stdout));
}
