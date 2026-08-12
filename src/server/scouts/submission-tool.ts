/**
 * The one spelling of the scout submission tool's name.
 *
 * Named here, alone, for the reason `ensembles/submission-tool.ts` gives about its own: the
 * string is asserted in four places that must not drift - the launch requirement every scout
 * dispatch declares (`MISSION_MCP_TOOLS`), the tool the bundled MCP server registers
 * (`src/mcp/server.ts`), the daemon route that accepts the call, and the sentence the scout's
 * prompt appendix tells it to call. A scout whose prompt names a tool its launch did not
 * pre-approve stops on a permission prompt; a launch that pre-approves a tool the server never
 * registered pre-approves nothing at all.
 *
 * Append-only agent-facing behaviour. Renaming it silently breaks every scout mid-flight when
 * the daemon restarts under a new build, because the tool name is baked into a prompt that was
 * already delivered.
 */
export const SUBMIT_SCOUT_ARTIFACTS_TOOL = "submit_scout_artifacts" as const;
