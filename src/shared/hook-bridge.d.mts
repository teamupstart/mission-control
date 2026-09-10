// Types for the agent-agnostic hook bridge, mirroring `hooks/install-checks.d.mts`.
//
// The module itself has to stay .mjs: the installed hook command is `node <path> <event>`
// with a bare external node - no tsx, no bundler - so the TypeScript side (the tests) gets
// its types from here.

/** The hook JSON on stdin, or "" when there is none (a TTY, or a slow writer). */
export function readStdin(): Promise<string>;

/**
 * A daemon answer that asks the agent not to process a prompt.
 *
 * The only decision this bridge carries, and only on `UserPromptSubmit`. Everything else -
 * and every failure - is `null`, which callers read as "carry on".
 */
export interface HookDecision {
  decision?: string;
  reason?: string;
}

/** POST one already-mapped event, answering the daemon's decision or `null` to carry on. */
export function postHookEvent(body: unknown): Promise<HookDecision | null>;
