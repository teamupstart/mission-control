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
