import type { DetectSpec } from "../types.ts";

/**
 * Codex on the process table. Installed as a node script, so argv0 is usually `node` and
 * the signatures are what identify it.
 */
export const codexDetect: DetectSpec = {
  commands: ["codex"],
  argvSignatures: ["@openai/codex", "codex.js"],
  /**
   * `mcp serve` only. It was one arm of a single GLOBAL exclusion before background became
   * the harness's own vocabulary, so declaring it here is what keeps `codex mcp serve` out
   * of the dashboard; the rest of that global list (`daemon`, `bg-pty-host`, `bg-spare`)
   * is Claude Code's internals and would be a lie on this spec.
   *
   * The one consequence, stated rather than discovered: `codex daemon` was excluded by that
   * global list and is not excluded here. Codex has no `daemon` subcommand, so nothing on a
   * real machine changes - a diff of old against new over ~1,000 live `ps` lines found this
   * and nothing else - and inheriting another vendor's roles to keep a hypothetical is the
   * habit this whole migration exists to break.
   *
   * `codex mcp-server`, the older spelling, is deliberately absent too: it is not excluded
   * today either, and quietly widening an exclusion is how a real session disappears.
   */
  background: { subcommands: ["mcp serve"], flags: [] },
};
