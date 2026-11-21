/**
 * The hooks module (spec 7.10): a thin adapter from the engine's `$` and events to the pure
 * functions in `flows/` and `pane/`, both of which take a `ModHost`. P2 lands the shell only:
 * it registers no hook, so an installed skeleton does nothing. P8 owns this file afterward, and
 * P11 and P12 each add one registration line for their flows and panes.
 *
 * It is a function declaration because `claude plugin validate` reads the hooks module's source
 * and wants `register` declared at the top of the file. The engine's `Register` type comes from
 * the `claude-code` types the engine writes at load, which are not in this repository, so the
 * parameters are opaque here.
 */
export function register(_on: unknown, _options: unknown): void {}

// The pane and the flows are exported so the built `hooks/register.js` carries them: a later
// phase's registration lines call them, and the build keeps whatever the entry point reaches.
export { renderPane, PANE_TABS } from "./pane/index.ts";
export { runDispatchCommand, runDispatchFlow, runStartDispatchTool } from "./flows/index.ts";
