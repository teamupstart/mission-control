import { fileURLToPath } from "node:url";


export const ELECTRON_GUI_SANDBOX_ERROR =
  "Electron GUI fixtures cannot run inside Codex's macOS Seatbelt sandbox. " +
  "Rerun `npm run test:electron` with scoped outside-sandbox approval, or run " +
  "the full `npm test` suite outside the sandbox.";

/**
 * A macOS GUI process needs LaunchServices and WindowServer Mach services that Codex's
 * Seatbelt profile deliberately withholds. Electron otherwise aborts in
 * _RegisterApplication and macOS writes a misleading application crash report before any
 * fixture code runs.
 */
export function assertElectronGuiLaunchAllowed(
  platform = process.platform,
  sandbox = process.env.CODEX_SANDBOX,
): void {
  if (platform === "darwin" && sandbox === "seatbelt") {
    throw new Error(ELECTRON_GUI_SANDBOX_ERROR);
  }
}

/** The launcher that serializes Electron GUI startup; see `electron-startup-slot.mjs`. */
export const ELECTRON_GUI_LAUNCHER = fileURLToPath(new URL("./electron-gui-launch.mjs", import.meta.url));

/**
 * The command for an `execFileSync` Electron GUI launch, routed through the startup launcher:
 * `execFileSync(...electronGuiCommand(electron, args), options)`. Concurrent GUI startups on
 * macOS can hang inside `ElectronMain`; the launcher lets one start at a time and passes
 * output, exit status and a timeout's SIGTERM straight through.
 */
export function electronGuiCommand(electron: string, args: readonly string[]): [string, string[]] {
  return [process.execPath, [ELECTRON_GUI_LAUNCHER, electron, ...args]];
}
