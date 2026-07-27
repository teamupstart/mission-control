import type { ThinkingLevel } from "@shared/types.ts";

// The slice of `@anthropic-ai/claude-agent-sdk` this driver actually speaks.
//
// Structural, and declared HERE rather than imported from the vendor package, for three
// reasons that are all the same reason - the seam has to be reachable without the vendor:
//
//  - a test builds a `ClaudeSdkDeps` by hand and drives the REAL adapter on a scripted
//    message stream (the `PaneDeps.pane` pattern). Typed against the vendor's `Query`, a
//    fake would have to implement thirty control methods this driver never calls.
//  - the vendor's `sdk.d.ts` is 7,000 lines and its `SDKMessage` union has forty members;
//    pulling that into the type graph of every module that transitively reaches the harness
//    registry costs typecheck time for a surface we use ten fields of.
//  - it names, in one place, exactly what we depend on. When the SDK moves - and its
//    surface has moved before - the compile error lands in `sdk-deps.ts`, the one module
//    that adapts the vendor to this shape, instead of scattering through the driver.
//
// This is NOT a re-declaration of the vendor's types as truth: `sdk-deps.ts` assigns the
// real `query` to `ClaudeSdkDeps["query"]`, so anything here that stops matching the
// installed package fails typecheck there.

/** A user turn as the streaming-input protocol carries it. */
export interface ClaudeSdkUserMessage {
  type: "user";
  message: { role: "user"; content: unknown };
  parent_tool_use_id: string | null;
  session_id?: string;
}

/**
 * One message off the output stream, narrowed to what the driver reads.
 *
 * `session_id` is on every frame and is the whole of how a `/clear` rotation is noticed:
 * the CLI mints a new id and reports it on the next ordinary message rather than on a
 * second `init`.
 */
export interface ClaudeSdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** One claude.ai plan window returned by the SDK's structured `/usage` control. */
export interface ClaudeSdkUsageWindow {
  /** Percentage used, 0-100. */
  utilization: number | null;
  /** ISO 8601 reset instant. */
  resets_at: string | null;
}

/**
 * The slice of the SDK's experimental structured `/usage` response this driver reads.
 *
 * Session cost deliberately stays out of this shape: OTel is Claude's one ledger writer.
 * This control exists solely for the two plan windows unavailable through OTel.
 */
export interface ClaudeSdkUsageResponse {
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: ClaudeSdkUsageWindow | null;
    seven_day?: ClaudeSdkUsageWindow | null;
  } | null;
}

/** What `canUseTool` may hand back. Mirrors the vendor's `PermissionResult`. */
export type ClaudeSdkPermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: ClaudeSdkPermissionUpdate[];
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/**
 * A permission rule the CLI suggests persisting - what "don't ask again" would actually do.
 *
 * Opaque on purpose. The driver never reads inside one; it hands the set back verbatim when
 * the human picks the always-allow row, which is the only correct thing to do with a rule
 * set the CLI composed for this exact tool call.
 */
export type ClaudeSdkPermissionUpdate = Record<string, unknown>;

/** The live query object, narrowed to the controls this driver drives. */
export interface ClaudeSdkQuery extends AsyncIterable<ClaudeSdkMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: ThinkingLevel | null }): Promise<void>;
  setModel(model?: string): Promise<void>;
  /**
   * Structured plan usage behind `/usage`.
   *
   * Experimental upstream, so the adapter treats every failure as "not told" and never
   * lets this live gauge affect the session lifecycle.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<ClaudeSdkUsageResponse>;
}

/**
 * The permission modes Claude Code itself has.
 *
 * A strict subset of our `PermissionMode` union, which also carries Codex's four profiles:
 * `askForApproval` is not a thing this CLI can be asked for, and the SDK validates the
 * value, so a mode that leaked through would fail the launch for a reason no operator
 * typed. `sdkPermissionMode` is the narrowing gate.
 */
export type ClaudeSdkPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** The options this driver passes to `query()`. */
export interface ClaudeSdkQueryOptions {
  cwd: string;
  pathToClaudeCodeExecutable: string;
  env: Record<string, string | undefined>;
  model?: string;
  effort?: ThinkingLevel;
  permissionMode?: ClaudeSdkPermissionMode;
  resume?: string;
  mcpServers?: Record<string, unknown>;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      suggestions?: ClaudeSdkPermissionUpdate[];
      title?: string;
      description?: string;
      requestId: string;
      signal: AbortSignal;
    },
  ) => Promise<ClaudeSdkPermissionResult>;
  hooks: Record<string, unknown>;
  /** Which of the operator's settings layers the embedded session loads. */
  settingSources: ("user" | "project" | "local")[];
  includePartialMessages: boolean;
}

/**
 * The transport seam: how a session is started, where the binary is, and what env it gets.
 *
 * The direct analogue of `PaneDeps` on the terminal axis - a test swaps the whole thing for
 * scripted frames and exercises the real projections. `query` is async only so the default
 * can load the 4MB vendor bundle lazily; nothing about the protocol needs it.
 */
export interface ClaudeSdkDeps {
  query(params: {
    prompt: AsyncIterable<ClaudeSdkUserMessage>;
    options: ClaudeSdkQueryOptions;
  }): Promise<ClaudeSdkQuery>;
  /** The absolute `claude` path to pin the subprocess to. Rejects when it cannot be found. */
  executable(): Promise<string>;
  /** The subprocess environment. See `sdkSubprocessEnv` for what it subtracts and why. */
  env(): Record<string, string | undefined>;
}
