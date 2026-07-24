/**
 * The one spelling of the ensemble submission tool's name.
 *
 * Named here, alone, because it is asserted in three places that must not drift: the launch
 * requirement a member is dispatched with (`MISSION_MCP_TOOLS`), the tool the bundled MCP server
 * registers (`src/mcp/server.ts`), and the sentence a member's prompt tells it to call. A member
 * whose prompt names a tool its launch did not pre-approve would stop on a permission prompt; a
 * launch that pre-approves a tool the server never registered would pre-approve nothing.
 */
export const SUBMIT_ENSEMBLE_RESULT_TOOL = "submit_ensemble_result" as const;
