import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { applyEdits, modify, parse } from "jsonc-parser";

/**
 * The one line of cmux configuration Mission Control cannot work without, and writing it.
 *
 * cmux ships `automation.socketControlMode: "cmuxOnly"`, which admits only processes started
 * inside cmux. The daemon is not one, so with the default every call it makes is answered
 * `Access denied - only processes started inside cmux can connect` - `ping`, `tree`,
 * `capabilities`, and `reload-config` alike. Nothing the adapter does can talk cmux into
 * admitting it; the file is the only lever, which is why this exists at all and why Setup
 * offers to pull it rather than printing an instruction.
 *
 * cmux applies the change by WATCHING the file. Verified on 0.64.20 by editing it while the
 * socket was refusing every call: the next `capabilities` answered `allowAll`, with no
 * reload asked for - which matters, because the reload verb is one of the things being
 * refused.
 *
 * Comments survive. The file cmux writes is JSONC and is mostly a commented-out template of
 * every setting, so `jsonc-parser`'s `modify`/`applyEdits` edits the one value in place -
 * the same mechanism `shared/claude-settings.ts` uses on `~/.claude/settings.json`, and for
 * the same reason: reserializing an operator's config would silently delete their notes.
 */

/**
 * Where cmux keeps the file, as `cmux config path` prints it.
 *
 * Overridable for the reason `claudeSettingsPath` is: this is a file OUTSIDE `MISSION_HOME`,
 * belonging to another application, and the E2E suite drives the repair button for real.
 * Without a seam here, one browser test would edit the config of whichever cmux the machine
 * running it happens to have. Prefixed because the unprefixed `CMUX_*` namespace is cmux's
 * own - it already reads four names there, and a fifth is theirs to add.
 */
export function cmuxConfigPath(): string {
  return process.env.MISSION_CMUX_CONFIG_PATH ?? join(homedir(), ".config", "cmux", "cmux.json");
}

export const CMUX_SOCKET_CONTROL_PATH = ["automation", "socketControlMode"] as const;

/** The value that admits the daemon. cmux's other mode, `cmuxOnly`, is the shipped default. */
export const CMUX_SOCKET_CONTROL_ALLOW_ALL = "allowAll";

export type CmuxSocketControlWrite =
  | { ok: true; outcome: "enabled" | "unchanged"; path: string; backup: string | null }
  | { ok: false; error: string };

/** `cmux.json.20260910-102333.bak`, the shape cmux's own `--help` asks an editor to leave. */
export function cmuxConfigBackupPath(path: string, at: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${path}.${stamp}.bak`;
}

/**
 * Rewrite the file's own text with one value changed, preserving its comments and layout.
 *
 * Separated from the filesystem so the interesting half - what happens to a file that has
 * the key, has a commented-out copy of the key, has an `automation` block without it, or is
 * a bare `{}` - is testable as a string function.
 */
export function withCmuxSocketControlAllowed(original: string): string {
  const source = original.trim() ? original : "{}";
  // Match the file's own formatting so the inserted value blends in, exactly as the OTel
  // installer does to `~/.claude/settings.json`. An operator's config churning on our
  // whitespace conventions is a diff they have to read and cannot act on.
  const indent = /\n( +)\S/.exec(source)?.[1];
  const formattingOptions = {
    insertSpaces: !/^\t/m.test(source),
    tabSize: indent?.length ?? 2,
    eol: (source.includes("\r\n") ? "\r\n" : "\n") as "\n" | "\r\n",
  };
  return applyEdits(
    source,
    modify(source, [...CMUX_SOCKET_CONTROL_PATH], CMUX_SOCKET_CONTROL_ALLOW_ALL, {
      formattingOptions,
    }),
  );
}

/** Read the file's current mode, or null when it does not say. Commented-out copies do not count. */
export function readCmuxSocketControl(source: string): string | null {
  if (!source.trim()) return null;
  const errors: unknown[] = [];
  const parsed = parse(source, errors as never[], { allowTrailingComma: true }) as
    | Record<string, unknown>
    | undefined;
  if (errors.length > 0) throw new Error("unreadable");
  const automation = parsed?.automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) return null;
  const mode = (automation as Record<string, unknown>).socketControlMode;
  return typeof mode === "string" ? mode : null;
}

/**
 * Set `automation.socketControlMode` to `allowAll`, backing the file up first.
 *
 * Idempotent, and says which: a row that is re-checked after the write must be able to tell
 * "already correct" from "just repaired", and an unconditional rewrite would restamp an
 * operator's file for nothing. A file that will not parse is REFUSED rather than replaced -
 * everything else in it is theirs, and a broken JSONC file is something they need to see.
 */
export function enableCmuxSocketControl(
  path: string = cmuxConfigPath(),
  now: Date = new Date(),
): CmuxSocketControlWrite {
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  let current: string | null;
  try {
    current = readCmuxSocketControl(original);
  } catch {
    return { ok: false, error: `${path} is not valid JSON/JSONC - fix it and retry.` };
  }
  if (current === CMUX_SOCKET_CONTROL_ALLOW_ALL) {
    return { ok: true, outcome: "unchanged", path, backup: null };
  }

  let text: string;
  try {
    text = withCmuxSocketControlAllowed(original);
  } catch (error) {
    return { ok: false, error: `${path} could not be edited: ${String(error)}` };
  }

  let backup: string | null = null;
  try {
    if (existsSync(path)) {
      backup = cmuxConfigBackupPath(path, now);
      copyFileSync(path, backup);
    }
    mkdirSync(dirname(path), { recursive: true });
    if (!text.endsWith("\n")) text += "\n";
    writeFileSync(path, text);
  } catch (error) {
    return { ok: false, error: `${path} could not be written: ${String(error)}` };
  }
  return { ok: true, outcome: "enabled", path, backup };
}
