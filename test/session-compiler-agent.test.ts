import { test } from "node:test";
import assert from "node:assert/strict";
import { edit, typecheckWithPatch } from "./helpers/typecheck-probe.ts";

const AGENT_TYPES_DECL = `export const AGENT_TYPES = ["claude", "codex", "pi"] as const;`;
/**
 * Deliberately not a plausible agent id. A probe named `pi` would start passing for the
 * wrong reason on the day someone adds a real `pi` harness and fills every map in.
 */
const PROBE_AGENT = "probeagent";

/**
 * Each `Record<AgentType, …>` that a new harness must fill in, and the type name tsc
 * will quote back. Matched on the CODE plus the missing key plus that type name, per
 * the convention above - never on prose.
 *
 * Listing them rather than asserting "some error somewhere" is the point: this is the
 * set of decisions a new harness is forced to make, and a map dropping off it (rewritten
 * as a lookup with a default, say) is a capability that silently does nothing for the
 * new agent - the exact asymmetry the pluggable-integrations migration exists to close.
 */
const AGENT_RECORDS: ReadonlyArray<readonly [file: string, type: string]> = [
  ["src/shared/agent.ts", "AgentIdentity"],
  ["src/shared/cost.ts", "string | null"],
  ["src/shared/goal.ts", "string | null"],
  ["src/shared/model.ts", "readonly ShippedHarnessModelChoice[]"],
  // The harness registry, which subsumes what `goal/source.ts` and `config.ts` used to be
  // pinned for: the per-agent `GoalSource` record was the transcript capability spelled
  // twice (the reader now derives from `HARNESSES[agent].transcript.messages`), and
  // `AGENT_BINS` was the bin capability spelled somewhere the harnesses could not see.
  // Strictly stronger - one entry here forces a decision about every capability at once,
  // and every phase of the pluggable-integrations migration adds another to that list.
  ["src/server/harness/index.ts", "Harness"],
  // The harness registry's PURE half, split out because the dashboard answers most of
  // these in the browser and cannot import a spec that calls `statSync`. Both rows are
  // required and neither subsumes the other: this one forces permission modes, skills,
  // the work queue, context clearing and MCP; the one above forces the transcript. A new
  // harness that fills in only one of them does not compile.
  ["src/shared/harness-capabilities.ts", "HarnessCapabilities"],
];

/**
 * Escape a TYPE NAME for use inside the match pattern below.
 *
 * The table above is written the way tsc prints, not the way `RegExp` reads, and the
 * gap between those is how an assertion here goes quietly green: `string | null`
 * interpolated raw is an alternation whose right branch is the bare pattern ` null`,
 * which matches somewhere in tsc's output no matter what happened in the file the row
 * names. That row then passes with the map deleted - the precise rot this test exists
 * to catch. Escaping centrally rather than row by row is the point: a hand-escaped
 * table only holds until the next row someone adds with a `|`, `(` or `?` in it.
 */
function asLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a new agent id fails typecheck everywhere it has to be accounted for", () => {
  // The union is now written ONCE, so this probe edits one line - which is itself the
  // thing being proved. Before, the same edit compiled clean: the type widened, the
  // dispatch schema's own copy of the enum did not, and the new agent was offered by
  // the picker and rejected by the daemon.
  const out = typecheckWithPatch((dir) =>
    edit(
      dir,
      "src/shared/types.ts",
      AGENT_TYPES_DECL,
      `export const AGENT_TYPES = ["claude", "codex", "pi", "${PROBE_AGENT}"] as const;`,
    ),
  );
  for (const [file, type] of AGENT_RECORDS) {
    const base = asLiteral(file.split("/").pop()!);
    assert.match(
      out,
      new RegExp(`${base}[^\\n]*error TS2741:[^\\n]*'${PROBE_AGENT}'[^\\n]*${asLiteral(type)}`),
      `adding an agent id should force a decision in ${file}, got:\n${out}`,
    );
  }
});

