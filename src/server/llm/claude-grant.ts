import type { LlmSandboxSpec, LlmToolGrant } from "@shared/llm.ts";

/**
 * The tools a Claude call may be granted, and nothing else.
 *
 * Read-only by construction. Today exactly one caller holds any tools at all - the
 * Inspector, which needs to read source to review a diff honestly and carries four other
 * defence layers because of it - and this is the same three it holds. A caller wanting
 * `Bash` or `Write` has to edit this line, which is where that argument should have to be
 * made rather than in a call site's options object.
 */
export const CLAUDE_GRANTABLE_TOOLS = ["Read", "Grep", "Glob"] as const;

/** The grant contract shared by Claude's print and SDK transports. */
export const CLAUDE_SANDBOX: LlmSandboxSpec = {
  tools: CLAUDE_GRANTABLE_TOOLS,
  enforcesDenyPaths: true,
};

/**
 * Render a grant's deny globs into Claude's flag-settings payload.
 *
 * Every path is denied for EVERY tool the run holds, not just `Read`. That is not padding:
 * `Grep` takes an absolute path and prints the matching lines, so a `Read(...)`-only list
 * protects nothing it names, and `Glob` confirms the files exist. The grant is what pays
 * for the tool access, so the denial has to cover the whole grant.
 *
 * Path-major, tool-minor, to reproduce byte-for-byte what the Inspector builds today.
 * `llm-runner-contract.test.ts` asserts that equality against the Inspector's own
 * constants, so the item that migrates it is provably a no-op rather than hopefully one.
 */
export function claudeGrantSettings(grant: LlmToolGrant): string {
  return JSON.stringify({
    permissions: {
      deny: grant.denyPaths.flatMap((p) => grant.tools.map((t) => `${t}(${p})`)),
    },
  });
}
