import { existsSync } from "node:fs";
import { run } from "../../util/exec.ts";
import { resolveBinSpec } from "../bin.ts";
import { claudeBin } from "./bin.ts";
import type { ClaudeSdkDeps, ClaudeSdkQuery } from "./sdk-types.ts";

// The ONE module that imports `@anthropic-ai/claude-agent-sdk`.
//
// Everything else in the driver is written against `ClaudeSdkDeps`, so this file is where
// the vendor's surface meets ours, and where a version bump that moves that surface fails
// to compile. It is deliberately thin: no projection, no bookkeeping, nothing a test would
// want to exercise - all of that is in `sdk.ts`, which a test drives on scripted frames
// with these deps replaced.

/**
 * Where the `claude` binary is, as an ABSOLUTE path this process has confirmed exists.
 *
 * PINNED, rather than left to the SDK's own detection - which falls back to the native CLI
 * shipped inside the npm package. That is a different Claude Code build from the one the
 * operator logged in with and configured, so running it silently would make "which version
 * is this session" unanswerable from the dashboard, and would ignore a `MISSION_CLAUDE_BIN`
 * pointing at a wrapper. The resolution is the harness's own chain, so an embedded session
 * and a dispatched pane launch the same binary by construction.
 *
 * Throws rather than degrades, per `SdkSpec.launch`: a driver that cannot honour what it
 * was asked for must not leave a card that looks dispatched and is running something else.
 */
export async function claudeExecutable(): Promise<string> {
  const configured = resolveBinSpec(claudeBin);
  if (configured.includes("/")) {
    if (existsSync(configured)) return configured;
    throw new Error(`the configured claude binary "${configured}" does not exist`);
  }
  const which = await run("which", [configured]);
  const found = which.stdout.trim().split("\n")[0];
  if (which.code !== 0 || !found || !existsSync(found)) {
    throw new Error(`agent binary "${configured}" not found on PATH`);
  }
  return found;
}

/**
 * The subprocess environment: `process.env` minus the daemon's OWN terminal identity.
 *
 * That subtraction is load-bearing rather than tidy. Machine-installed
 * `~/.claude/settings.json` hooks fire inside this subprocess exactly as they do in a pane,
 * and `harness-hook.mjs` reports `TMUX_PANE` / `WEZTERM_PANE` as the pane it believes it is
 * running in. A daemon started from a terminal would hand its own pane down to every
 * embedded session it launches, and `findSessionByEnv` prefers a pane key over every other
 * match - so every hook from every embedded session would land on whichever card holds the
 * daemon's terminal. Dropping the three vars makes those hooks fall through to their
 * session-id match, which is the truthful one for a session that has no pane at all.
 *
 * `CLAUDE_CODE_ENTRYPOINT` is the same leak on a different axis: it says how the CLI was
 * invoked, and the SDK sets `sdk-ts` only when the variable is absent. A daemon launched
 * from inside a Claude Code session inherits `cli` and would hand that identity to every
 * SDK session it starts.
 */
export function sdkSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env = { ...base };
  delete env.TMUX_PANE;
  delete env.WEZTERM_PANE;
  delete env.TERM_PROGRAM;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/**
 * Load the vendor package and start a query.
 *
 * Imported lazily - the bundle is several megabytes and a daemon whose operator never turns
 * the Agent SDK runtime on should not pay for it at boot, nor should the test suite pay for
 * it on every file that reaches the harness registry. esbuild still inlines it into
 * `dist/server/index.mjs`, so this resolves nothing at runtime in a packaged build.
 */
async function startQuery(params: Parameters<ClaudeSdkDeps["query"]>[0]): Promise<ClaudeSdkQuery> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  type VendorParams = Parameters<typeof query>[0];
  type VendorOptions = NonNullable<VendorParams["options"]>;

  // Spread-and-assign rather than one blanket cast, so this line is what actually checks
  // the vendor's surface: `cwd`, `pathToClaudeCodeExecutable`, `env`, `model`, `effort`,
  // `permissionMode`, `resume`, `settingSources` and `includePartialMessages` all have to
  // still exist upstream, with types ours satisfy, or this fails to compile - which is what
  // makes this module, and not the driver, the place an SDK bump lands.
  //
  // Four fields ARE cast, and each is a place we deliberately declined to re-declare a
  // vendor type. `hooks` and `mcpServers` are `Record<string, unknown>` in our shape so a
  // test fake can build one without forty message types behind it. `prompt` carries a
  // message `content` that is a union of the Anthropic SDK's own block types. And
  // `canUseTool` differs only in `updatedPermissions`, whose elements are OPAQUE to this
  // driver by design: we hand back the exact rule set the CLI suggested, never one we
  // composed, so modelling its variants here would be re-declaring a type we never read.
  const { hooks, mcpServers, canUseTool, ...rest } = params.options;
  const options: VendorOptions = {
    ...rest,
    canUseTool: canUseTool as unknown as VendorOptions["canUseTool"],
    hooks: hooks as VendorOptions["hooks"],
    ...(mcpServers ? { mcpServers: mcpServers as VendorOptions["mcpServers"] } : {}),
  };
  return query({
    prompt: params.prompt as VendorParams["prompt"],
    options,
  }) as unknown as ClaudeSdkQuery;
}

/** What the shipped driver uses. Tests replace the whole object. */
export const defaultClaudeSdkDeps: ClaudeSdkDeps = {
  query: startQuery,
  executable: claudeExecutable,
  env: () => sdkSubprocessEnv(),
};
