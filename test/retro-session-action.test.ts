import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_DIR,
  MEMORY_INDEX_PATH,
  MEMORY_REFERENCE_MARKER,
} from "../src/shared/memory.ts";
import { RETRO_SKILL } from "../src/shared/skills.ts";
import { SESSION_ACTION_COMPLETION_KINDS } from "../src/shared/workflow.ts";
import { renderSessionAction } from "../src/server/workflows/feedback.ts";
import {
  BUILTIN_SESSION_ACTIONS,
  RETRO_SESSION_ACTION_ID,
} from "../src/server/workflows/builtin-session-actions.ts";
import { parseSkill } from "../src/server/skills/catalog.ts";

// The retro's shipped halves and the contract between them: an action the daemon delivers, a
// skill it requires, and a completion it is proven by. Three separate files that only work
// together, so each assertion below is a seam where a rename lands silently otherwise.

const retro = () => BUILTIN_SESSION_ACTIONS.find((a) => a.id === RETRO_SESSION_ACTION_ID);

test("the shipped retro action requires the retro skill and is proven by a commit", () => {
  const action = retro();
  assert.ok(action, "the build must ship a retro session action");
  assert.equal(action.id, "builtin:retro");
  assert.equal(action.name, "Retro");
  assert.equal(action.builtin, true);
  // The contract table, not the Markdown. An unlisted slug silently defaults to
  // `{ requiredSkillId: null, completion: session_turn }`, which would ship a retro that
  // delivers without its procedure and reports success for a turn that wrote nothing.
  assert.equal(action.requiredSkillId, RETRO_SKILL);
  assert.deepEqual(action.completion, { kind: "repo_commit" });
  assert.ok(SESSION_ACTION_COMPLETION_KINDS.includes("repo_commit"));
});

test("the retro skill parses as a catalog entry under the id the action requires", () => {
  const text = readFileSync(join(process.cwd(), "skills", RETRO_SKILL, "SKILL.md"), "utf8");
  const parsed = parseSkill(RETRO_SKILL, text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.problem);
  // The frontmatter `name` is what the harness-native invocation is built from, so it has to
  // equal the id the contract table names or delivery resolves a command for another skill.
  assert.equal(parsed.skill.name, RETRO_SKILL);
  assert.equal(parsed.skill.enforcement, "triggered");
  assert.ok(parsed.skill.description.length > 0);
});

/**
 * The skill is Markdown and the convention is TypeScript, and Markdown cannot import.
 *
 * A skill installed into `~/.claude/skills` runs against repositories that have nothing to do
 * with this one, so it must spell the paths out rather than reference this repo's docs - which
 * means the frozen constants and the instructions can drift apart with nothing to catch it.
 * This is that catch: change `MEMORY_INDEX_PATH` and this fails until the procedure agrees.
 */
test("the retro skill names the memory paths phase 1 froze", () => {
  const text = readFileSync(join(process.cwd(), "skills", RETRO_SKILL, "SKILL.md"), "utf8");
  assert.ok(text.includes(MEMORY_INDEX_PATH), `the skill must name ${MEMORY_INDEX_PATH}`);
  assert.ok(text.includes(MEMORY_DIR), `the skill must name ${MEMORY_DIR}`);
  // The marker is what makes the AGENTS.md bootstrap idempotent, so the skill has to tell the
  // session to match on exactly this string rather than on a whole sentence.
  assert.ok(
    text.includes(MEMORY_REFERENCE_MARKER),
    `the skill must name the reference marker ${MEMORY_REFERENCE_MARKER}`,
  );
});

test("a retro packet names the receiving session and claims no workflow run", () => {
  const action = retro();
  assert.ok(action);
  const packet = renderSessionAction({
    origin: { kind: "session", sessionId: "sdk:retro:1" },
    actionName: action.name,
    promptMarkdown: action.promptMarkdown,
    skillCommand: "/retro",
  });
  assert.equal(packet.ok, true);
  if (!packet.ok) return;
  // The skill invocation leads, so the harness resolves it as the turn's first line.
  assert.ok(packet.payload.startsWith("/retro\n"));
  assert.ok(packet.payload.includes("Mission Control session action: Retro"));
  // The session id is the packet's only per-delivery fact, and the skill's transcript read
  // depends on it: the prompt Markdown is frozen bytes and can never carry it.
  assert.ok(packet.payload.includes("Session: sdk:retro:1"));
  // Nothing invents a run. An on-demand retro has no workflow, no version, and no run id.
  assert.ok(!packet.payload.includes("Workflow:"));
  assert.ok(!packet.payload.includes("Run:"));
  // The authored instruction survives to the last byte - nothing is appended after it.
  assert.ok(packet.payload.endsWith(action.promptMarkdown));
});

test("a run's packet still names its workflow and run", () => {
  const packet = renderSessionAction({
    origin: { kind: "run", workflowName: "Review", workflowVersion: 3, runId: "run-1", repoRoot: null },
    actionName: "Tidy",
    promptMarkdown: "# Tidy\n",
    skillCommand: null,
  });
  assert.equal(packet.ok, true);
  if (!packet.ok) return;
  assert.ok(packet.payload.includes("Workflow: Review v3"));
  assert.ok(packet.payload.includes("Run: run-1"));
  assert.ok(!packet.payload.includes("Session:"));
});

test("a run reviewing one repository of a multi-repo task names it in the packet", () => {
  // Two of a session's reviews deliver into ONE pane, so a packet that named only its run id
  // left the agent to guess which repository the instruction was about - and "open the pull
  // request for the work you just had reviewed" is unanswerable without it.
  const packet = renderSessionAction({
    origin: {
      kind: "run",
      workflowName: "Review",
      workflowVersion: 3,
      runId: "run-2",
      repoRoot: "/work/beta",
    },
    actionName: "Pull Request",
    promptMarkdown: "# Pull Request\n",
    skillCommand: null,
  });
  assert.equal(packet.ok, true);
  if (!packet.ok) return;
  assert.match(packet.payload, /Repository: \/work\/beta/);
});

test("a run on the session's own checkout names no repository at all", () => {
  const packet = renderSessionAction({
    origin: {
      kind: "run",
      workflowName: "Review",
      workflowVersion: 3,
      runId: "run-1",
      repoRoot: null,
    },
    actionName: "Tidy",
    promptMarkdown: "# Tidy\n",
    skillCommand: null,
  });
  assert.equal(packet.ok, true);
  if (!packet.ok) return;
  assert.doesNotMatch(packet.payload, /Repository:/);
});
