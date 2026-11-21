// The fake shaper's helper processes, shared with the tests that clean them up. Kept apart from
// fake-shaper.mjs, which runs as soon as it is imported.

/** Names a process as a fake-shaper helper; its pid file follows it in the argv. */
export const HELPER_MARKER = "shaping-fixture-helper";

/** How long a helper runs at most, whatever else happens: far longer than any test that uses one. */
export const HELPER_LIFETIME_MS = 5 * 60_000;

/**
 * The argv of a helper recorded in `pidFile`, an absolute path. The helper runs until a
 * `<pidFile>.stop` file appears, then exits on its own: cleanup asks it to stop through that file
 * and never signals a pid, which by then the system may have given to an unrelated process. It
 * also exits once the directory holding `pidFile` is gone, so a teardown that removes that
 * directory before the helper saw its stop file, or without writing one, still ends it; and in any
 * case after `HELPER_LIFETIME_MS`, should its test's process die before any cleanup ran.
 */
export function helperArgv(pidFile) {
  const script = [
    "const pidFile = process.argv[process.argv.length - 1];",
    "const { existsSync } = require('node:fs');",
    "const { dirname } = require('node:path');",
    `const ends = Date.now() + ${HELPER_LIFETIME_MS};`,
    "setInterval(() => {",
    "  if (existsSync(pidFile + '.stop') || !existsSync(dirname(pidFile)) || Date.now() > ends) process.exit(0);",
    "}, 50);",
  ].join(" ");
  return ["-e", script, HELPER_MARKER, pidFile];
}

/** The file whose appearance stops the helper recorded in `pidFile`. */
export function helperStopFile(pidFile) {
  return `${pidFile}.stop`;
}
