import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Authoring a session action, end to end, in the real dashboard against a real daemon.
 *
 * The phase before this one shipped the durable representation and deliberately no authoring
 * surface, and this file's assertions were the negatives that pinned its absence. They have
 * flipped: an operator now writes an action in the library, drops it into a pipeline, and
 * publishes a version that freezes it - and every step of that goes through a route, a Zod
 * boundary, SQLite and back to the browser over SSE.
 *
 * That round trip is what no other layer reaches. The SSR render tests assert markup for a
 * hand-built props object and the HTTP tests assert routes against an in-process app; neither
 * proves that a `<select>` an operator changes reaches `PATCH /api/workflows/:id`, survives
 * publish, and comes back as a snapshot.
 *
 * The one negative that stays is the Pull Request built-in: its adapter does not exist until
 * Phase 4, so it must not be addable, and a graph naming it must not publish.
 */

const PROMPT = "# Tidy the workspace\n\nRemove the stray scratch file and say so.\n";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

interface ActionRow {
  id: string;
  name: string;
  revision: number;
  promptMarkdown: string;
  requiredSkillId: string | null;
  completion: { kind: string };
  archivedAt: number | null;
}

test("an operator authors a session action in the library, and the daemon stores it exactly", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);

  // The library opens on its own tab, beside Personas. The shipped Pull Request action is
  // already in the catalog, so this is also the read-only built-in case: it is listed, it is
  // selected, and its editor says why nothing here can be saved.
  await expect(dashboard.getByRole("heading", { name: "Session actions" })).toBeVisible();
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Pull Request" }))
    .toContainText("Built-in");
  await expect(dashboard.locator(".wf-state.builtin"))
    .toContainText("Duplicate it to make a copy you own and can edit");

  await dashboard.getByRole("button", { name: "New" }).click();
  const fields = dashboard.locator("section.wf-action-fields");
  await fields.getByLabel("Name").fill("Tidy the workspace");
  await fields.getByLabel("Description").fill("Remove the scratch files");

  // The prompt goes through the real CodeMirror editor an operator types into, not a
  // textarea a spec could set directly.
  const promptEditor = dashboard.locator(".wf-action-editor-host .cm-content");
  await promptEditor.click();
  await promptEditor.pressSequentially("# Tidy the workspace");
  await dashboard.keyboard.press("Enter");
  await dashboard.keyboard.press("Enter");
  await promptEditor.pressSequentially("Remove the stray scratch file and say so.");

  // Only what this build can PROVE is offered. `pull_request` has no adapter until Phase 4,
  // so a control that listed it would author a workflow that then refuses to publish.
  const completion = fields.getByLabel("Completes when");
  await expect(completion.locator("option")).toHaveText(["Session turn finishes"]);

  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.locator(".wf-action-editor-head .workflow-eyebrow"))
    .toHaveText("Revision 1");

  // The durable row behind the screen: exact prompt, and the default proof an operator did
  // not have to opt into.
  const rows = await api<ActionRow[]>(daemon, "/api/session-actions");
  const saved = rows.find((row) => row.name === "Tidy the workspace")!;
  // Byte for byte what was typed - the blank line between the heading and the body included.
  // Nothing between the editor and SQLite trims, re-wraps or normalizes this string.
  expect(saved.promptMarkdown).toBe("# Tidy the workspace\n\nRemove the stray scratch file and say so.");
  expect(saved.completion.kind).toBe("session_turn");
  expect(saved.requiredSkillId).toBe(null);
  expect(saved.revision).toBe(1);

  // And the list row reads back what the runtime will require, in the words it proves.
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Tidy the workspace" }))
    .toContainText("No required skill · Session turn finishes");
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Tidy the workspace" }))
    .toContainText("Revision 1");
});

test("editing bumps one revision, and archiving retires the action without touching history", async ({
  dashboard,
  daemon,
}) => {
  const created = await api<ActionRow>(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    description: "Remove the scratch files",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });

  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await dashboard.getByRole("button", { name: /Tidy the workspace/ }).click();
  const fields = dashboard.locator("section.wf-action-fields");
  await fields.getByLabel("Description").fill("Remove the scratch files and say so");
  await expect(dashboard.locator(".wf-state.dirty")).toHaveText("Unsaved changes");
  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.locator(".wf-action-editor-head .workflow-eyebrow"))
    .toHaveText("Revision 2");

  const afterEdit = await api<ActionRow>(daemon, `/api/session-actions/${created.id}`);
  expect(afterEdit.revision).toBe(2);
  // ONE revision for one save, and the prompt nobody edited is untouched.
  expect(afterEdit.promptMarkdown).toBe(PROMPT);

  // Archive is one dialog, and it states what survives: an operator retiring an action needs
  // to know their published versions keep working.
  await dashboard.getByRole("button", { name: "Archive" }).click();
  const dialog = dashboard.getByRole("dialog", { name: /Archive Tidy the workspace/ });
  await expect(dialog).toContainText("Every published version keeps the snapshot it was published with");
  await dialog.getByRole("button", { name: "Archive session action" }).click();

  const archived = await api<ActionRow>(daemon, `/api/session-actions/${created.id}`);
  expect(archived.archivedAt).not.toBe(null);
  // Soft: the row stays readable, because drafts and versions name its id.
  expect(archived.name).toBe("Tidy the workspace");
  // And it leaves the ACTIVE list, which is the whole point of retiring it. The shipped
  // built-in stays, so this is "the archived row is gone" rather than "the list is empty" -
  // an emptiness assertion would have passed on a catalog that failed to load at all.
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Tidy the workspace" }))
    .toHaveCount(0);
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Pull Request" }))
    .toHaveCount(1);
  // It is still reachable, because a draft or a version may name it.
  await dashboard.locator(".wf-action-sidebar").getByLabel("State").selectOption("archived");
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Tidy the workspace" }))
    .toContainText("Archived");
});

test("a second tab's edit is a conflict that preserves the local draft", async ({
  dashboard,
  daemon,
}) => {
  const created = await api<ActionRow>(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    description: "",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });

  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await dashboard.getByRole("button", { name: /Tidy the workspace/ }).click();
  const fields = dashboard.locator("section.wf-action-fields");
  await fields.getByLabel("Description").fill("mine, typed locally");

  // Another tab saves first. The editor is dirty, so the SSE upsert must NOT replace a byte.
  await api(daemon, `/api/session-actions/${created.id}`, {
    expectedRevision: 1,
    description: "theirs, saved first",
  }, "PATCH");

  await expect(dashboard.locator(".wf-state.conflict"))
    .toContainText("Your instruction has not been changed");
  await expect(fields.getByLabel("Description")).toHaveValue("mine, typed locally");

  // Reload is one explicit way out, and only then does the local text go.
  await dashboard.getByRole("button", { name: "Reload latest" }).click();
  await expect(fields.getByLabel("Description")).toHaveValue("theirs, saved first");
  await expect(dashboard.locator(".wf-state.conflict")).toHaveCount(0);
});

test("reapply lands the preserved draft on the same action, keeping the other tab's fields", async ({
  dashboard,
  daemon,
}) => {
  // The route Reload and Duplicate between them cannot offer. Reload throws the operator's
  // edits away; Duplicate keeps them on a DIFFERENT action, leaving every workflow that
  // already points at this one unchanged. Reapply is the one that lands the edits here.
  const created = await api<ActionRow>(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    description: "the original blurb",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });

  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await dashboard.getByRole("button", { name: /Tidy the workspace/ }).click();

  // This operator edits the INSTRUCTION and nothing else.
  const promptEditor = dashboard.locator(".wf-action-editor-host .cm-content");
  await promptEditor.click();
  await dashboard.keyboard.press("ControlOrMeta+a");
  await promptEditor.pressSequentially("# Mine");
  await expect(dashboard.locator(".wf-state.dirty")).toHaveText("Unsaved changes");

  // Another tab saves first, editing the DESCRIPTION and nothing else.
  await api(daemon, `/api/session-actions/${created.id}`, {
    expectedRevision: 1,
    description: "their newer blurb",
  }, "PATCH");
  await expect(dashboard.locator(".wf-state.conflict")).toContainText("r2");

  await dashboard.getByRole("button", { name: "Reapply my changes" }).click();
  await expect(dashboard.locator(".wf-state.conflict")).toHaveCount(0);
  await expect(dashboard.locator(".wf-action-editor-head .workflow-eyebrow"))
    .toHaveText("Revision 3");

  const merged = await api<ActionRow>(daemon, `/api/session-actions/${created.id}`);
  // The SAME row - the id a workflow would already be pointing at, not a copy.
  expect(merged.id).toBe(created.id);
  expect(merged.revision).toBe(3);
  // Mine landed.
  expect(merged.promptMarkdown).toBe("# Mine");
  // And theirs survived. A reapply that wrote the whole draft, or that diffed against the row
  // the conflict reported, would have sent the description back to "the original blurb" -
  // reverting a save the banner was in the middle of reporting.
  expect(merged.description).toBe("their newer blurb");

  // One row in the library, still. Duplicate would have made two.
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Tidy the workspace" }))
    .toHaveCount(1);
});

test("an authored action becomes a pipeline stage, publishes, and freezes its instruction", async ({
  dashboard,
  daemon,
}) => {
  await api(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    description: "Remove the scratch files",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E authored action",
    description: "One authored session action between Session and End",
  });

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E authored action/ }).click();

  // The empty pipeline offers all three kinds of stage, from the one control that creates one.
  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await expect(pipeline).toContainText("a reviewer, a check or a session action");
  const picker = pipeline.getByLabel("Add the first stage");
  // Three groups, and the third is the one this phase adds. Asserted as a group rather than
  // as a bare option so a Persona that happened to share the name could not satisfy it.
  await expect(picker.locator('optgroup[label="Session actions"] option'))
    .toHaveText(["Tidy the workspace"]);
  await picker.selectOption({ label: "Tidy the workspace" });

  // It lands as a singleton stage that names itself and says what happens after it.
  const row = pipeline.locator("li.wf-pipeline-reviewer");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Tidy the workspace");
  await expect(row).toContainText("Session action");
  await expect(row).toContainText("No required skill · Completes when session turn finishes");
  await expect(pipeline).toContainText("later stages review new evidence");
  // Session submits into it; it emits `complete`, never `pass`.
  await expect(pipeline.locator(".wf-pipeline-gate")).toHaveText(["submitted", "complete"]);
  // And the surface says what an action does to the run, beside what a fail does.
  await expect(dashboard.locator(".wf-pipeline-repair"))
    .toContainText("captures fresh evidence and only the stages after it run again");

  // No id reaches the screen; the picker's option value is the machine's business.
  await expect(pipeline).not.toContainText(created.workflow.id);

  // Publish is ON now - this is the gate the previous phase held shut.
  const publish = dashboard.getByRole("button", { name: "Publish" });
  await expect(publish).toBeEnabled();
  await publish.click();

  await expect
    .poll(async () => (await api<unknown[]>(daemon, `/api/workflows/${created.workflow.id}/versions`)).length)
    .toBe(1);
  const version = await api<{
    graph: { nodes: Array<{ kind: string; action?: { promptMarkdown: string; sourceRevision: number } }> };
  }>(daemon, `/api/workflows/${created.workflow.id}/versions/1`);
  const node = version.graph.nodes.find((candidate) => candidate.kind === "session_action")!;
  // The immutable copy the runtime will read. Editing the library afterwards cannot reach it.
  expect(node.action!.promptMarkdown).toBe(PROMPT);
  expect(node.action!.sourceRevision).toBe(1);
});

test("an action stage reorders, is replaced, and is removed through the builder", async ({
  dashboard,
  daemon,
}) => {
  await api(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });
  await api(daemon, "/api/session-actions", {
    name: "Push the branch",
    promptMarkdown: "# Push\n\nPush the branch.\n",
    completion: { kind: "session_turn" },
  });
  await api(daemon, "/api/workflows", { name: "E2E action edits" });

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E action edits/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await pipeline.getByLabel("Add the first stage").selectOption({ label: "Tidy the workspace" });
  await pipeline.getByLabel("Insert a stage after Stage 1").click();
  await pipeline.getByLabel("Insert a stage after Stage 1")
    .selectOption({ label: "Check · typecheck" });
  await expect(pipeline.locator("li.wf-pipeline-reviewer")).toHaveCount(2);

  // REPLACE, not add: the stage already exists, so this changes which action it sends.
  await pipeline.getByLabel("Choose the session action Stage 1 sends")
    .selectOption({ label: "Push the branch" });
  await expect(pipeline.locator("li.wf-pipeline-reviewer").first()).toContainText("Push the branch");

  // Alt+Right moves the action past the check. The barrier the previous phase needed is gone
  // with the reason for it: an operator who authored this stage may move it.
  await pipeline.locator('[data-focus-key="stage:0"]').focus();
  await dashboard.keyboard.press("Alt+ArrowRight");
  await expect(pipeline.locator("li.wf-pipeline-reviewer").first()).toContainText("typecheck");
  await expect(pipeline.locator("li.wf-pipeline-reviewer").nth(1)).toContainText("Push the branch");

  // And Remove says what it is removing, in the terms an action deserves rather than a
  // member list it does not have.
  await pipeline.getByRole("button", { name: "Remove Stage 2" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Remove stage" });
  await expect(dialog).toContainText("go back to reviewing the evidence the stages above it saw");
  await dialog.getByRole("button", { name: "Remove stage" }).click();
  await expect(pipeline.locator("li.wf-pipeline-reviewer")).toHaveCount(1);
  await expect(pipeline).not.toContainText("Push the branch");
});

test("the Graph palette creates an action node with one complete port, and can delete it", async ({
  dashboard,
  daemon,
}) => {
  await api(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });
  await api(daemon, "/api/workflows", { name: "E2E action graph" });

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E action graph/ }).click();
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();

  const palette = dashboard.locator("section.workflow-palette");
  await expect(palette.getByRole("button")).toHaveText([
    "＋ Persona",
    "＋ All-pass Join",
    "＋ Check",
    "＋ Session action",
    "＋ End",
  ]);
  await palette.getByLabel("Session action for new node").selectOption({ label: "Tidy the workspace" });
  await palette.getByRole("button", { name: "＋ Session action" }).click();

  const node = dashboard.locator('[data-node-kind="session_action"]');
  await expect(node).toHaveCount(1);
  await expect(node).toContainText("Tidy the workspace");
  // ONE source port. A `fail` handle here would invite a route back to Session for what is a
  // delivery problem, and a `pass` handle would let a Join read it as a favourable verdict.
  await expect(node.getByLabel("Complete output")).toHaveCount(1);
  await expect(node.getByLabel("Fail output")).toHaveCount(0);
  await expect(node.getByLabel("Pass output")).toHaveCount(0);
  await expect(node.getByLabel("Activate input")).toHaveCount(1);

  // Selecting it opens a rail that can repoint it AND remove it. Half an authoring loop was
  // the previous phase's deliberate answer; both halves ship together.
  await node.click();
  const rail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  await expect(rail.getByLabel("Session action")).toBeVisible();
  await expect(rail).toContainText("Completes once the session's turn finishes");
  await rail.getByRole("button", { name: "Delete node" }).click();
  await dashboard.getByRole("dialog", { name: "Remove node" })
    .getByRole("button", { name: "Remove node" }).click();
  await expect(dashboard.locator('[data-node-kind="session_action"]')).toHaveCount(0);
});

test("the unavailable built-in is not addable, and a graph naming it will not publish", async ({
  dashboard,
  daemon,
}) => {
  // The one negative that survives this phase. `pull_request` has no verified adapter yet, so
  // the shipped Pull Request action must be nameable without being offerable.
  await api(daemon, "/api/workflows", { name: "E2E ship it" });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E ship it/ }).click();

  const picker = dashboard.locator(".wf-pipeline-strip").getByLabel("Add the first stage");
  await expect(picker.locator("option", { hasText: "Pull Request" })).toHaveCount(0);
  await expect(picker.locator("optgroup", { hasText: "Pull Request" })).toHaveCount(0);
  // The reason is in the control's own tooltip rather than behind a failed publish.
  await expect(dashboard.locator(".tt-desc").filter({ hasText: "Add the first stage" }))
    .toContainText("No session action here can run on this daemon yet");

  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  // No palette entry either, because nothing addable exists on this daemon.
  await expect(dashboard.locator("section.workflow-palette").getByRole("button")).toHaveText([
    "＋ Persona",
    "＋ All-pass Join",
    "＋ Check",
    "＋ End",
  ]);
});

test("a draft naming the unavailable built-in renders, and the daemon refuses to publish it", async ({
  dashboard,
  daemon,
}) => {
  // The shape can still arrive through the raw draft API, so it still has to read as itself
  // and still has to be refused - by the SERVER, with a diagnostic the panel is showing.
  const NODE = { action: "action-node", session: "session-node", end: "end-node" };
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E legacy pr draft",
  });
  const id = created.workflow.id;
  await api(daemon, `/api/workflows/${id}`, {
    expectedDraftRevision: 1,
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 60, y: 60 } },
        {
          id: NODE.action,
          kind: "session_action",
          sessionActionId: "builtin:pull-request",
          position: { x: 340, y: 60 },
        },
        { id: NODE.end, kind: "end", outcome: "Complete", position: { x: 620, y: 60 } },
      ],
      edges: [
        { id: "e-submit", source: NODE.session, sourcePort: "submitted", target: NODE.action, targetPort: "activate" },
        { id: "e-complete", source: NODE.action, sourcePort: "complete", target: NODE.end, targetPort: "terminal" },
      ],
    },
  }, "PATCH");

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E legacy pr draft/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await expect(pipeline.locator("li.wf-pipeline-reviewer")).toContainText("Pull Request");
  await expect(pipeline.locator("li.wf-pipeline-reviewer")).toContainText("Skill · pull-request");
  // The replace picker RETAINS it, disabled-by-labelling, so changing anything else on this
  // draft cannot silently repoint the node at something else.
  await expect(pipeline.getByLabel("Choose the session action Stage 1 sends"))
    .toContainText("Pull Request (Not available in this build)");

  await expect(dashboard.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(dashboard.locator(".workflow-validation")).toContainText(
    "This build cannot verify a pull request yet, so a workflow using this action cannot be published.",
  );

  const refused = await fetch(`${daemon.baseURL}/api/workflows/${id}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDraftRevision: 2 }),
  });
  expect(refused.status).toBe(422);
  const body = (await refused.json()) as { diagnostics: Array<{ code: string; nodeId?: string }> };
  expect(body.diagnostics.some((item) =>
    item.code === "session_action_runtime_unavailable" && item.nodeId === NODE.action)).toBe(true);
  expect(await api<unknown[]>(daemon, `/api/workflows/${id}/versions`)).toEqual([]);
});
