import { randomBytes } from "node:crypto";
import { link, lstat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { binEnv, resolveBin, WEZTERM_BIN } from "./bin.ts";
import type { TerminalExec } from "./exec.ts";

export interface WeztermSocket {
  incarnation: string;
  exec: (args: string[], opts?: { input?: string; timeoutMs?: number }) => ReturnType<TerminalExec>;
}

/**
 * Let WezTerm resolve its default endpoint, with the inherited socket scrubbed. The
 * diagnostic is only an endpoint locator: its pane list is deliberately discarded.
 * Unknown diagnostics, proxy commands and filesystems without socket links fail closed.
 */
function selectedSocket(stderr: string): string | null {
  const matches = [...stderr.matchAll(/wezterm_client::client\s*> connect to Socket\(("(?:[^"\\]|\\.)*")\)/g)];
  if (matches.length !== 1) return null;
  try {
    const path: unknown = JSON.parse(matches[0]![1]!);
    return typeof path === "string" && path.startsWith("/") && !path.includes("\0") ? path : null;
  } catch { return null; }
}

/**
 * A pathname check followed by a CLI call can race a mux restart. Pin the socket inode
 * with a hard link BEFORE enumerating or validating it, and keep that link until the
 * operation finishes. Rebinding the default pathname cannot retarget this link. Unix
 * WezTerm clients do not reconnect after losing their server.
 *
 * The opaque lifetime excludes ctime/nlink, which our own link changes. Birth time
 * distinguishes later inode reuse between operations; no birth time means no authority.
 * The short alias stays on the socket's filesystem and is removed on every exit path.
 */
export async function withWeztermSocket<T>(
  exec: TerminalExec,
  expected: string | undefined,
  operation: (socket: WeztermSocket) => Promise<T>,
): Promise<T | null> {
  const bin = resolveBin(WEZTERM_BIN);
  const env = binEnv(WEZTERM_BIN);
  const located = await exec(bin, ["cli", "--no-auto-start", "list", "--format", "json"], {
    env: { ...env, WEZTERM_LOG: "wezterm_client::client=trace" },
    timeoutMs: 1000,
  });
  const path = located.code === 0 ? selectedSocket(located.stderr) : null;
  if (!path) return null;
  // Do not lengthen an already near-limit sockaddr_un path (notably a private macOS HOME).
  // link is exclusive, so a collision refuses without altering anybody else's entry.
  const alias = join(dirname(path), randomBytes(8).toString("hex").slice(0, Math.min(16, basename(path).length)));
  let linked = false;
  try {
    const stat = await (async () => {
      try {
        await link(path, alias);
        linked = true;
        return await lstat(alias, { bigint: true });
      } catch { return null; }
    })();
    if (!stat?.isSocket() || stat.birthtimeNs <= 0n) return null;
    const incarnation = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    if (expected !== undefined && incarnation !== expected) return null;
    return await operation({
      incarnation,
      // env supplies a freshly pinned address, never the inherited WEZTERM_UNIX_SOCKET.
      // The fixed env executable keeps the locator's unconditional WezTerm scrub intact.
      exec: (args, opts = {}) => exec(FIXED_OS_EXECUTABLES.env, [
        `WEZTERM_UNIX_SOCKET=${alias}`, bin, "cli", "--no-auto-start", ...args,
      ], { ...opts, env }),
    });
  } finally {
    if (linked) await unlink(alias).catch(() => {});
  }
}
