import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_ACTION_COMPLETION_KINDS,
  WORKFLOW_LIMITS,
  WORKFLOW_SOURCE_PORTS,
  normalizeSessionActionName,
  sessionActionChoiceLabel,
  sessionActionChoicesForDisplay,
  sessionActionDescriptionFromMarkdown,
  sessionActionNameFromMarkdown,
  sessionActionSnapshotIsOutdated,
  sessionActionsForDisplay,
  isSessionActionNode,
  isVerdictNode,
} from "../src/shared/workflow.ts";
import type {
  PublishedWorkflowNode,
  SessionAction,
  SessionActionSnapshot,
} from "../src/shared/workflow.ts";
import {
  ArchiveSessionActionSchema,
  CreateSessionActionSchema,
  PublishedWorkflowGraphSchema,
  SessionActionCompletionSchema,
  SessionActionSnapshotSchema,
  UpdateSessionActionSchema,
  WorkflowDraftGraphSchema,
} from "../src/shared/protocol.ts";

// What is at stake: every later SessionAction phase persists the names declared here. The
// prompt is DELIVERED verbatim into an operator's session, so a boundary that quietly trimmed
// it would type an instruction nobody authored; and a completion kind decides what counts as
// proof, so reading an unknown one as `session_turn` would complete a historical action under
// a weaker contract than the version it belongs to was published with.

const action = (patch: Partial<SessionAction> = {}): SessionAction => ({
  id: "a1",
  name: "Pull Request",
  normalizedName: "pull request",
  description: "",
  promptMarkdown: "# Pull Request\n\nDo it.\n",
  requiredSkillId: "pull-request",
  completion: { kind: "pull_request" },
  revision: 3,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  builtin: false,
  ...patch,
});

const snapshot = (patch: Partial<SessionActionSnapshot> = {}): SessionActionSnapshot => ({
  sourceSessionActionId: "a1",
  sourceRevision: 3,
  name: "Pull Request",
  description: "",
  promptMarkdown: "# Pull Request\n\nDo it.\n",
  requiredSkillId: "pull-request",
  completion: { kind: "pull_request" },
  ...patch,
});

test("the durable spellings are exactly the ones later phases were promised", () => {
  // APPEND-ONLY. A rename here does not migrate an operator's rows or an immutable published
  // version - it makes them unreadable, and Phase 2 consumes these literal strings.
  assert.deepEqual(SESSION_ACTION_COMPLETION_KINDS, ["session_turn", "pull_request"]);
  assert.deepEqual(WORKFLOW_SOURCE_PORTS, ["submitted", "pass", "fail", "complete"]);
  assert.equal(WORKFLOW_LIMITS.sessionActionSkillId, 200);
  // The prompt CEILING is deliberately not pinned here any more, and the distinction is the
  // point of this test. A spelling is append-only because renaming it makes stored rows and
  // published versions unreadable; a byte bound is not an identifier, and this one had to
  // move once the runtime existed to say what could actually be delivered. Phase 1 set it to
  // 100,000 beside a 60,000-byte packet, so a published action between the two would have
  // typed only a prefix of its immutable instruction. It is now DERIVED from the packet
  // budget, and `session-action-durability.test.ts` pins that relationship rather than the
  // number. Stored rows keep their old, looser read bound so none became unreadable.
  assert.equal(
    WORKFLOW_LIMITS.sessionActionPromptBytes,
    WORKFLOW_LIMITS.sessionActionPacketBytes - WORKFLOW_LIMITS.sessionActionEnvelopeBytes,
  );
  assert.equal(WORKFLOW_LIMITS.sessionActionPromptReadBytes, 100_000);
});

test("the completion schema admits exactly the closed registry and nothing else", () => {
  for (const kind of SESSION_ACTION_COMPLETION_KINDS) {
    assert.deepEqual(SessionActionCompletionSchema.parse({ kind }), { kind });
  }
  // The schema spells its arms out, so this is what stops the two from drifting: a kind
  // appended to the tuple and forgotten in the schema fails here rather than at a row.
  assert.equal(
    SessionActionCompletionSchema.options.length,
    SESSION_ACTION_COMPLETION_KINDS.length,
  );
  for (const rejected of [{ kind: "shell" }, { kind: "" }, {}, "session_turn", null]) {
    assert.equal(SessionActionCompletionSchema.safeParse(rejected).success, false);
  }
});

test("prompt Markdown crosses the boundary byte-for-byte", () => {
  // Deliberately hostile: CRLF, a trailing double space (a Markdown line break), a leading
  // blank line, and a non-BMP character. Each is something a "helpful" normalizer eats.
  const promptMarkdown = "\n# Do the thing\r\n\r\nExact trailing space  \r\n\u{1F680}\n";
  const parsed = CreateSessionActionSchema.parse({ name: "Exact", promptMarkdown });
  assert.equal(parsed.promptMarkdown, promptMarkdown);
  assert.equal(SessionActionSnapshotSchema.parse(snapshot({ promptMarkdown })).promptMarkdown, promptMarkdown);
});

test("create defaults are the conservative ones, and an empty prompt is refused", () => {
  const parsed = CreateSessionActionSchema.parse({ name: "Bare", promptMarkdown: "go" });
  assert.equal(parsed.description, "");
  assert.equal(parsed.requiredSkillId, null);
  // `session_turn` and not `pull_request`: an action opts INTO proving something about a
  // repository, it does not inherit that promise from a default.
  assert.deepEqual(parsed.completion, { kind: "session_turn" });
  for (const promptMarkdown of ["", "   \n\t "]) {
    assert.equal(CreateSessionActionSchema.safeParse({ name: "n", promptMarkdown }).success, false);
  }
  const oversize = "x".repeat(WORKFLOW_LIMITS.sessionActionPromptBytes + 1);
  assert.equal(
    CreateSessionActionSchema.safeParse({ name: "n", promptMarkdown: oversize }).success,
    false,
  );
});

test("a required skill is a catalog id and can never be a command", () => {
  for (const requiredSkillId of ["pull-request", "a", "some_skill.v2", null]) {
    assert.equal(
      CreateSessionActionSchema.safeParse({ name: "n", promptMarkdown: "p", requiredSkillId }).success,
      true,
      `${requiredSkillId} should be a legal skill id`,
    );
  }
  // Anything that could carry an argv, a path, a redirect or a substitution is refused at the
  // boundary rather than trusted to be harmless by the time it reaches a resolver.
  for (const requiredSkillId of [
    "npm test",
    "pull-request; rm -rf /",
    "../../etc/passwd",
    "$(whoami)",
    "-rf",
    "",
    "x".repeat(WORKFLOW_LIMITS.sessionActionSkillId + 1),
  ]) {
    assert.equal(
      CreateSessionActionSchema.safeParse({ name: "n", promptMarkdown: "p", requiredSkillId }).success,
      false,
      `${requiredSkillId} must not be a legal skill id`,
    );
  }
});

test("update requires an expected revision and at least one editable field", () => {
  assert.equal(UpdateSessionActionSchema.safeParse({ name: "Renamed" }).success, false);
  assert.equal(UpdateSessionActionSchema.safeParse({ expectedRevision: 2 }).success, false);
  assert.equal(UpdateSessionActionSchema.safeParse({ expectedRevision: 0, name: "n" }).success, false);
  for (const field of [
    { name: "Renamed" },
    { description: "d" },
    { promptMarkdown: "p" },
    { requiredSkillId: null },
    { completion: { kind: "session_turn" } },
  ]) {
    assert.equal(UpdateSessionActionSchema.safeParse({ expectedRevision: 2, ...field }).success, true);
  }
  assert.equal(ArchiveSessionActionSchema.safeParse({ expectedRevision: 1 }).success, true);
  assert.equal(ArchiveSessionActionSchema.safeParse({}).success, false);
});

test("a draft node names a live action and a published node carries a whole snapshot", () => {
  const position = { x: 1, y: 2 };
  const draft = WorkflowDraftGraphSchema.parse({
    nodes: [{ id: "n", kind: "session_action", sessionActionId: "a1", position }],
    edges: [],
  });
  assert.equal(draft.nodes[0]!.kind, "session_action");

  // The published arm refuses a DRAFT-shaped node. That refusal is the whole immutability
  // contract: a version holding a live id would let a library edit change what an in-flight
  // run types into somebody's session.
  assert.equal(
    PublishedWorkflowGraphSchema.safeParse({
      nodes: [{ id: "n", kind: "session_action", sessionActionId: "a1", position }],
      edges: [],
    }).success,
    false,
  );
  assert.equal(
    PublishedWorkflowGraphSchema.safeParse({
      nodes: [{ id: "n", kind: "session_action", action: snapshot(), position }],
      edges: [],
    }).success,
    true,
  );
  // A snapshot with a completion this build cannot read fails the whole node rather than
  // degrading, for the same reason the row parser does.
  assert.equal(
    PublishedWorkflowGraphSchema.safeParse({
      nodes: [{
        id: "n",
        kind: "session_action",
        action: { ...snapshot(), completion: { kind: "shell" } },
        position,
      }],
      edges: [],
    }).success,
    false,
  );
});

test("a complete route is accepted only through the shared source-port tuple", () => {
  const edge = (sourcePort: string) => WorkflowDraftGraphSchema.safeParse({
    nodes: [
      { id: "a", kind: "session_action", sessionActionId: "a1", position: { x: 0, y: 0 } },
      { id: "b", kind: "end", outcome: "Done", position: { x: 1, y: 0 } },
    ],
    edges: [{ id: "e", source: "a", sourcePort, target: "b", targetPort: "terminal" }],
  }).success;
  assert.equal(edge("complete"), true);
  assert.equal(edge("completed"), false);
  assert.equal(edge("done"), false);
});

test("an action node is never a verdict node", () => {
  const node: PublishedWorkflowNode = {
    id: "n",
    kind: "session_action",
    action: snapshot(),
    position: { x: 0, y: 0 },
  };
  // Two narrow predicates rather than one widened one. Every reader of `isVerdictNode`
  // treats its node as something that passed or failed a review, and an action that finished
  // has done neither - so it must answer false there and true only in its own guard.
  assert.equal(isVerdictNode(node), false);
  assert.equal(isSessionActionNode(node), true);
  const persona: PublishedWorkflowNode = {
    id: "p",
    kind: "persona",
    position: { x: 0, y: 0 },
    persona: {
      sourcePersonaId: "p1",
      sourceRevision: 1,
      name: "Judge",
      description: "",
      guidanceMarkdown: "# Judge",
      runner: null,
      model: null,
    },
  };
  assert.equal(isSessionActionNode(persona), false);
  assert.equal(isVerdictNode(persona), true);
});

test("names normalize by the same Unicode rule Personas use", () => {
  assert.equal(normalizeSessionActionName("  Pull   Request  "), "pull request");
  assert.equal(
    normalizeSessionActionName("Pull Request"),
    normalizeSessionActionName("pull request"),
  );
  assert.equal(normalizeSessionActionName("ﬁle Action"), "file action");
});

test("a document's first heading names it and the paragraph beneath describes it", () => {
  const markdown = "# Pull Request\n\nPrepare the reviewed work.\n\n## Detail\n\nMore.\n";
  assert.equal(sessionActionNameFromMarkdown(markdown, "slug"), "Pull Request");
  assert.equal(sessionActionDescriptionFromMarkdown(markdown), "Prepare the reviewed work.");
  assert.equal(sessionActionNameFromMarkdown("no heading", "slug"), "slug");
  assert.equal(sessionActionDescriptionFromMarkdown("# Only\n"), "");
});

test("an outdated snapshot is decided by revision for a row and by text for a built-in", () => {
  assert.equal(sessionActionSnapshotIsOutdated(snapshot(), action()), false);
  assert.equal(sessionActionSnapshotIsOutdated(snapshot(), null), true);
  assert.equal(sessionActionSnapshotIsOutdated(snapshot(), action({ revision: 4 })), true);

  // A built-in's revision is a synthetic constant, so comparing revisions would report a
  // build shipping edited Markdown as current. Its TEXT and its contracts decide.
  const builtin = action({ builtin: true, revision: 1 });
  assert.equal(
    sessionActionSnapshotIsOutdated(snapshot({ sourceRevision: 999 }), builtin),
    false,
    "a built-in's revision number says nothing",
  );
  assert.equal(
    sessionActionSnapshotIsOutdated(snapshot({ promptMarkdown: "# Changed\n" }), builtin),
    true,
  );
  assert.equal(
    sessionActionSnapshotIsOutdated(snapshot({ completion: { kind: "session_turn" } }), builtin),
    true,
    "a weaker proof contract is a change, not a cosmetic one",
  );
  assert.equal(
    sessionActionSnapshotIsOutdated(snapshot({ requiredSkillId: null }), builtin),
    true,
  );
});

test("a live operator row shadows a same-named built-in, and the built-in stays addressable", () => {
  const builtin = action({ id: "builtin:pull-request", builtin: true });
  const mine = action({ id: "mine", name: "Pull Request", normalizedName: "pull request" });
  const archivedMine = action({ id: "mine", normalizedName: "pull request", archivedAt: 5 });

  assert.deepEqual(sessionActionsForDisplay([builtin, mine]).map((a) => a.id), ["mine"]);
  // Only a LIVE row shadows, so the archived listing stays a superset of the active one.
  assert.deepEqual(
    sessionActionsForDisplay([builtin, archivedMine]).map((a) => a.id).sort(),
    ["builtin:pull-request", "mine"],
  );

  // A shadowed or archived source a node already names is RETAINED in the choice list, so a
  // draft pointing at it can still say which action it means.
  const choices = sessionActionChoicesForDisplay([builtin, mine], ["builtin:pull-request"]);
  assert.deepEqual(choices.map(({ action: a }) => a.id), ["builtin:pull-request", "mine"]);
  assert.deepEqual(choices.map(({ retained }) => retained), [true, false]);
  assert.equal(
    sessionActionChoiceLabel(builtin, true),
    "Pull Request (Built-in, shadowed by your action)",
  );
  assert.equal(sessionActionChoiceLabel(archivedMine, true), "Pull Request (Archived)");
  assert.equal(sessionActionChoiceLabel(mine, false), "Pull Request");
});
