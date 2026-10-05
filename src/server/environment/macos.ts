import type { run } from "../util/exec.ts";

// Bounded readers for two facts macOS keeps about a managed Mac.
//
// Both are pure over the injected `run`, never throw, and answer `null` for every failure -
// a missing tool, a non-zero exit, a timeout, an overflow, output in a shape they do not
// recognize. `null` is "this could not be read", and every caller treats it as the absence of
// the fact rather than as a reason to guess.
//
// Neither reads a file directly. Both questions have an Apple tool that answers them, and the
// tool is the authority: `profiles` reports the enrollment macOS is acting on now, and
// `plutil -extract` reads one key out of a property list in any of its encodings.

export interface MacosReaderDeps {
  run: typeof run;
}

/** The device management enrollment macOS reports for this Mac. */
export interface MdmEnrollment {
  /** True when `MDM enrollment:` begins with `Yes`, which covers `Yes (User Approved)`. */
  enrolled: boolean;
  /** The `MDM server:` line's value, or null when the line is absent or empty. */
  serverUrl: string | null;
}

/** `profiles status` prints a line or two; anything near this bound is not that output. */
const PROFILES_MAX_BUFFER = 16 * 1024;
/** The same bound the environment checks put on any file they read. */
const PLIST_MAX_BUFFER = 64 * 1024;
/** Measured at about 30 ms. Two seconds is a hang, not a slow answer. */
const READ_TIMEOUT_MS = 2000;

/**
 * Read this Mac's current device management enrollment.
 *
 * Both facts come from ONE `profiles status -type enrollment` answer, so they describe the
 * same enrollment. Measured output on an enrolled Mac:
 *
 *   Enrolled via DEP: No
 *   MDM enrollment: Yes (User Approved)
 *   MDM server: https://example.jamfcloud.com/mdm/ServerURL
 *
 * An output with no `MDM enrollment:` line at all, or one whose value is neither Yes nor No, is
 * unrecognized and answers null, rather than being read as "not enrolled": the reader does not
 * know what it was shown.
 */
export async function readMdmEnrollment(deps: MacosReaderDeps): Promise<MdmEnrollment | null> {
  let result;
  try {
    result = await deps.run("profiles", ["status", "-type", "enrollment"], {
      timeoutMs: READ_TIMEOUT_MS,
      maxBuffer: PROFILES_MAX_BUFFER,
    });
  } catch {
    return null;
  }
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
  const enrollment = lineValue(result.stdout, "MDM enrollment");
  if (enrollment === null) return null;
  // Only an explicit Yes or No is an answer. An empty or unfamiliar value - a new macOS
  // wording, a truncated line - is unread, not "not enrolled": reading it as No would withdraw
  // a managed Mac's settings on a fact nobody established.
  const enrolled = /^yes\b/i.test(enrollment) ? true : /^no\b/i.test(enrollment) ? false : null;
  if (enrolled === null) return null;
  const server = lineValue(result.stdout, "MDM server");
  return {
    enrolled,
    serverUrl: server === null || server.length === 0 ? null : server,
  };
}

/**
 * Read one value out of a property list.
 *
 * `-extract` rather than `-convert`: only the requested subtree is converted, so a date or a
 * data blob elsewhere in the file - which JSON cannot represent - cannot fail the read.
 * Detection never calls this; it exists for the managed-settings reader that follows it.
 */
export async function readPlistValue(
  path: string,
  keyPath: string,
  deps: MacosReaderDeps,
): Promise<unknown> {
  let result;
  try {
    result = await deps.run("plutil", ["-extract", keyPath, "json", "-o", "-", path], {
      timeoutMs: READ_TIMEOUT_MS,
      maxBuffer: PLIST_MAX_BUFFER,
    });
  } catch {
    return null;
  }
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

/** The trimmed value after `<label>:` on its own line, or null when no such line exists. */
function lineValue(output: string, label: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(`${label.toLowerCase()}:`)) continue;
    return trimmed.slice(label.length + 1).trim();
  }
  return null;
}
