// The fake shaper's helper processes, shared with the tests that clean them up. Kept apart from
// fake-shaper.mjs, which runs as soon as it is imported.

/** Names a process as a fake-shaper helper; its pid file follows it in the argv. */
export const HELPER_MARKER = "shaping-fixture-helper";

/**
 * The argv of a helper recorded in `pidFile`. The helper runs until a `<pidFile>.stop` file
 * appears, then exits on its own: cleanup asks it to stop through that file and never signals a
 * pid, which by then the system may have given to an unrelated process.
 */
export function helperArgv(pidFile) {
  const script = [
    "const stop = process.argv[process.argv.length - 1] + '.stop';",
    "const { existsSync } = require('node:fs');",
    "setInterval(() => { if (existsSync(stop)) process.exit(0); }, 50);",
  ].join(" ");
  return ["-e", script, HELPER_MARKER, pidFile];
}

/** The file whose appearance stops the helper recorded in `pidFile`. */
export function helperStopFile(pidFile) {
  return `${pidFile}.stop`;
}
