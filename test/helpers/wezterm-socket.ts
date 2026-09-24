import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalExec } from "../../src/server/terminal/exec.ts";
import { stubRun } from "../../src/server/util/exec.ts";

/** A real socket inode for CLI-shape tests; replacement races live in wezterm-incarnation. */
export async function weztermSocketFixture() {
  const directory = await mkdtemp(join(tmpdir(), "mc-wez-socket-test-"));
  const path = join(directory, "sock");
  const server = createServer((client) => client.end());
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const observed = await stat(path, { bigint: true });
  const incarnation = `${observed.dev}:${observed.ino}:${observed.birthtimeNs}`;
  return {
    path, incarnation,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    },
    /** Keep payload/argv assertions focused on the CLI command after endpoint selection. */
    wrap(exec: TerminalExec): TerminalExec {
      return async (bin, args, opts) => {
        if (opts?.env?.WEZTERM_LOG === "wezterm_client::client=trace") {
          return stubRun({ code: 0, stdout: "[]", stderr: `TRACE wezterm_client::client > connect to Socket(${JSON.stringify(path)})` });
        }
        return args[0]?.startsWith("WEZTERM_UNIX_SOCKET=")
          ? exec(args[1]!, args.slice(2), opts) : exec(bin, args, opts);
      };
    },
  };
}
