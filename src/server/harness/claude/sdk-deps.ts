import { headlessAgentSubprocessEnv } from "../../agent-subprocess-env.ts";
import { locateExecutable } from "../../executables/locator.ts";
import type {
  ClaudeSdkDeps,
  ClaudeSdkOneShotDeps,
  ClaudeSdkQuery,
} from "./sdk-types.ts";

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
  const executable = await locateExecutable("claude");
  if (!executable) throw new Error('agent binary "claude" not found in the executable environment');
  return executable.path;
}

/**
 * Load the vendor package and start a query.
 *
 * Imported lazily - the bundle is several megabytes and a daemon whose operator never turns
 * the Agent SDK runtime on should not pay for it at boot, nor should the test suite pay for
 * it on every file that reaches the harness registry. esbuild still inlines it into
 * `dist/server/index.mjs`, so this resolves nothing at runtime in a packaged build.
 */
type StartQueryParams =
  | Parameters<ClaudeSdkDeps["query"]>[0]
  | Parameters<ClaudeSdkOneShotDeps["query"]>[0];

async function startQuery(params: StartQueryParams): Promise<ClaudeSdkQuery> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  type VendorParams = Parameters<typeof query>[0];
  type VendorOptions = NonNullable<VendorParams["options"]>;

  // Spread-and-assign rather than one blanket cast, so this line is what actually checks
  // the vendor's surface: `cwd`, `pathToClaudeCodeExecutable`, `env`, `model`, `effort`,
  // `permissionMode`, `allowDangerouslySkipPermissions`, `resume`, `settingSources`,
  // `abortController`, `tools`, `settings`, `maxTurns`, `maxBudgetUsd`, `outputFormat`,
  // `stderr` and `includePartialMessages` all have to still exist upstream, with types ours
  // satisfy, or this fails to compile - which is what makes this module, and not the driver,
  // the place an SDK bump lands.
  //
  // Four fields ARE cast, and each is a place we deliberately declined to re-declare a
  // vendor type. `hooks` and `mcpServers` are `Record<string, unknown>` in our shape so a
  // test fake can build one without forty message types behind it. `prompt` carries a
  // message `content` that is a union of the Anthropic SDK's own block types. And
  // `canUseTool` differs only in `updatedPermissions`, whose elements are OPAQUE to this
  // driver by design: we hand back the exact rule set the CLI suggested, never one we
  // composed, so modelling its variants here would be re-declaring a type we never read.
  let options: VendorOptions;
  if ("canUseTool" in params.options) {
    const { hooks, mcpServers, canUseTool, ...rest } = params.options;
    options = {
      ...rest,
      canUseTool: canUseTool as unknown as VendorOptions["canUseTool"],
      hooks: hooks as VendorOptions["hooks"],
      ...(mcpServers ? { mcpServers: mcpServers as VendorOptions["mcpServers"] } : {}),
    };
  } else {
    // The one-shot surface has none of the four opaque fields above, so every option is
    // assigned directly and remains compiler-checked against the installed vendor.
    options = { ...params.options };
  }
  return query({
    prompt: params.prompt as VendorParams["prompt"],
    options,
  }) as unknown as ClaudeSdkQuery;
}

/** What the shipped driver uses. Tests replace the whole object. */
export const defaultClaudeSdkDeps: ClaudeSdkDeps = {
  query: startQuery,
  executable: claudeExecutable,
  env: (cwd, stateHome) => headlessAgentSubprocessEnv(process.env, cwd, stateHome),
};

/** The same lazy vendor import and binary/env answers, narrowed for one fresh query. */
export const defaultClaudeSdkOneShotDeps: ClaudeSdkOneShotDeps = {
  query: startQuery,
  executable: claudeExecutable,
  env: (cwd) => headlessAgentSubprocessEnv(process.env, cwd),
};
