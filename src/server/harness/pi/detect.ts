import type { DetectSpec } from "../types.ts";

/**
 * Pi (`@earendil-works/pi-coding-agent`) on the process table.
 *
 * pi's `cli.js` sets `process.title = "pi"` before it dispatches, so a live session shows on
 * `ps` as literally `pi` (argv0 basename `pi`) - it matches `commands` directly, like a native
 * binary, rather than needing the argv signature Codex's node shim does. The `--mode rpc`
 * control surface sets `process.title = "pi-rpc"`, which does not match and so is not drawn.
 *
 * The signatures are a defensive fallback for a launch snapshotted before `process.title`
 * lands (or a bare `node .../cli.js`); they carry the same accepted, transient false-positive
 * as Codex's package-name signature (an `npm i -g @earendil-works/pi-coding-agent` line).
 *
 * `background` is empty: pi has no daemon and no MCP-server role to exclude - it has no MCP
 * client at all, and extends itself with in-process extensions rather than side processes.
 * Its management subcommands (`config`, `update`, `install`, `list`) are NOT declared here
 * and cannot be - `process.title` has already rewritten the command to `pi`, so they are
 * invisible to a subcommand match. They are short-lived and rare, so the phantom-card risk is
 * low; `BackgroundSpec` is the wrong tool for them regardless, since they are foreground
 * commands rather than background roles.
 */
export const piDetect: DetectSpec = {
  commands: ["pi"],
  argvSignatures: ["pi-coding-agent/dist/cli.js", "@earendil-works/pi-coding-agent"],
  background: { subcommands: [], flags: [] },
};
