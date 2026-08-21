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
 * The Pull Request built-in used to be this file's standing negative - not addable, not
 * publishable - because its adapter did not exist. It does now, so those three tests were
 * turned around rather than removed: the same controls, the same routes, the same graph, and
 * the opposite answer. Keeping them pointed at the shipped built-in is what makes "the whole
 * browser change was the daemon saying yes" a claim a spec checks rather than a comment.
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
  // Whose a row is, said once at the group head rather than as a tag on every row.
  await expect(dashboard.getByRole("heading", { name: /^Built-in\s+2$/ })).toBeVisible();
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Pull Request" }))
    .toContainText("Skill · pull-request · Pull request is opened and verified");
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

  // Only what this build can PROVE is offered, and it now proves all three. The list is
  // asserted exhaustively rather than by membership, and in the append-only tuple's order: a
  // completion the daemon cannot run appearing here is how an operator authors a workflow that
  // then refuses to publish. Reached through the chip the four-across field row became; the
  // control inside it is the same `select`.
  await dashboard.getByRole("button", { name: /^completes when\b/ }).click();
  const completion = dashboard.getByRole("group", { name: "Completes when" })
    .getByRole("combobox", { name: "Completes when" });
  await expect(completion.locator("option")).toHaveText([
    "Session turn finishes",
    "Pull request is opened and verified",
    "A commit lands in the checkout",
  ]);
  await dashboard.keyboard.press("Escape");

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
  // The revision is on the open workspace rather than on every row: a revision and a
  // timestamp per row was provenance about four actions at once, none of them the one open.
  await expect(dashboard.locator(".wf-action-editor-head")).toContainText("Revision 1");
});

test("a filled new action will not save while the daemon has not said what it can prove", async ({
  dashboard,
  daemon,
}) => {
  // The capability read is the boundary this surface exists to enforce, and a brand-new draft
  // defaults to a completion without the operator choosing one - so a save gate that only
  // asked whether the DRAFT was well formed let a fully-typed action through while the
  // selector beside it said nothing could be selected.
  await dashboard.route("**/api/session-actions/capabilities", (route) => route.abort());
  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await dashboard.getByRole("button", { name: "New" }).click();

  const fields = dashboard.locator("section.wf-action-fields");
  await fields.getByLabel("Name").fill("Tidy the workspace");
  const promptEditor = dashboard.locator(".wf-action-editor-host .cm-content");
  await promptEditor.click();
  await promptEditor.pressSequentially("# Tidy");

  // Everything the operator owns is now valid, and the save is still refused - by the one
  // fact they do not own.
  await expect(dashboard.getByRole("button", { name: "Save" })).toBeDisabled();
  // And the reason is on the screen, in both places an operator looks: the banner over the
  // form, and the note under the selector it is about. Neither says "this build cannot prove
  // it" - that is an answer, and no answer arrived.
  await expect(dashboard.locator(".wf-error"))
    .toContainText("has not said which completions it can prove");
  // The note sits beside the chip it is about, on the face rather than inside a popover: a
  // completion this build cannot vouch for is the one fact on that row waiting on somebody.
  await expect(dashboard.locator("p.lib-props-note"))
    .toHaveText("This daemon has not said which completions it can prove yet.");
  // Nothing reached the catalog. Asserted against the route rather than the screen, because
  // "the button looked off" is not the claim - "no row was written" is.
  const rows = await api<ActionRow[]>(daemon, "/api/session-actions");
  expect(rows.some((row) => row.name === "Tidy the workspace")).toBe(false);

  // The control case, which is what makes the refusal above mean something rather than being
  // a form that never worked: with the daemon answering, the identical draft saves.
  await dashboard.unroute("**/api/session-actions/capabilities");
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "New" }).click();
  await dashboard.locator("section.wf-action-fields").getByLabel("Name").fill("Tidy the workspace");
  const retry = dashboard.locator(".wf-action-editor-host .cm-content");
  await retry.click();
  await retry.pressSequentially("# Tidy");
  await expect(dashboard.getByRole("button", { name: "Save" })).toBeEnabled();
  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(async () => (await api<ActionRow[]>(daemon, "/api/session-actions"))
      .some((row) => row.name === "Tidy the workspace"))
    .toBe(true);
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
  // to know their published versions keep working. It lives behind the overflow menu now,
  // beside Duplicate - one promoted verb, everything else one click further in.
  await dashboard.getByRole("button", { name: "More session action options" }).click();
  await dashboard.getByRole("menu", { name: "More session action options" })
    .getByRole("menuitem", { name: "Archive" }).click();
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
  // It is still reachable, because a draft or a version may name it. Through the counted
  // toggle in the rail's footer, which is where the Active/Archived select went.
  const archivedToggle = dashboard.locator(".wf-action-sidebar")
    .getByRole("button", { name: /^Archived/ });
  await expect(archivedToggle).toHaveText(/Archived\s*1/);
  await archivedToggle.click();
  await expect(dashboard.locator(".wf-action-list-item").filter({ hasText: "Tidy the workspace" }))
    .toHaveCount(1);
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
  await expect(pipeline).toContainText("a reviewer, a Command or a session action");
  const picker = pipeline.getByLabel("Add the first stage");
  // Three groups, and the third is the one the session action phase added. Asserted as a group
  // rather than as a bare option so a Persona that happened to share the name could not satisfy
  // it, and exhaustively so every shipped built-in whose adapter this build can prove - Pull
  // Request, and Retro since `repo_commit` shipped - has to be accounted for rather than
  // silently tolerated.
  await expect(picker.locator('optgroup[label="Session actions"] option'))
    .toHaveText(["Pull Request", "Retro", "Tidy the workspace"]);
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
    .selectOption({ label: "Command · typecheck" });
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
    "＋ Command",
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
  // The sentence the capability table supplies, not one this surface writes: the kinds are
  // append-only, and a rail that derived its own two-way split would caption the next adapter
  // as a session-turn completion.
  await expect(rail).toContainText("Completes when session turn finishes");
  const deleteNode = rail.getByRole("button", { name: "Delete node" });
  await expect(deleteNode).toHaveAttribute("aria-keyshortcuts", "d");
  await dashboard.keyboard.press("d");
  await dashboard.getByRole("dialog", { name: "Remove node" })
    .getByRole("button", { name: "Remove node" }).click();
  await expect(dashboard.locator('[data-node-kind="session_action"]')).toHaveCount(0);
});

test("the shipped Pull Request built-in is addable from the pipeline and the palette", async ({
  dashboard,
  daemon,
}) => {
  // This was the standing negative until its adapter shipped, and the assertions are the same
  // ones read the other way. Nothing in the browser was special-cased for the built-in: it is
  // catalog data that `addableSessionActions` filters on availability, and availability is a
  // fact the daemon states over a route.
  await api(daemon, "/api/workflows", { name: "E2E ship it" });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E ship it/ }).click();

  const picker = dashboard.locator(".wf-pipeline-strip").getByLabel("Add the first stage");
  await expect(picker.locator("option", { hasText: "Pull Request" })).toHaveCount(1);

  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  // And the palette gained the entry, because something addable now exists on this daemon.
  await expect(dashboard.locator("section.workflow-palette").getByRole("button")).toHaveText([
    "＋ Persona",
    "＋ All-pass Join",
    "＋ Command",
    "＋ Session action",
    "＋ End",
  ]);
});

/** Session -> Pull Request built-in -> End, as the raw draft API writes it. */
const PR_NODE = { action: "action-node", session: "session-node", end: "end-node" };

const prDraft = {
  nodes: [
    { id: PR_NODE.session, kind: "session", position: { x: 60, y: 60 } },
    {
      id: PR_NODE.action,
      kind: "session_action",
      sessionActionId: "builtin:pull-request",
      position: { x: 340, y: 60 },
    },
    { id: PR_NODE.end, kind: "end", outcome: "Complete", position: { x: 620, y: 60 } },
  ],
  edges: [
    { id: "e-submit", source: PR_NODE.session, sourcePort: "submitted", target: PR_NODE.action, targetPort: "activate" },
    { id: "e-complete", source: PR_NODE.action, sourcePort: "complete", target: PR_NODE.end, targetPort: "terminal" },
  ],
};

test("an action node duplicates, keeping the adapter it was copied for", async ({
  dashboard,
  daemon,
}) => {
  // Duplicating a node is the THIRD way to put one in a graph, beside the palette button and
  // the drop handler, and it gates on the same catalog both of those do. It used to be off for
  // this node because the adapter was unavailable; it is on now, and the copy has to carry the
  // action it was copied FOR rather than whatever the palette happens to have selected.
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E duplicate action",
  });
  await api(daemon, `/api/workflows/${created.workflow.id}`, {
    expectedDraftRevision: 1,
    draft: prDraft,
  }, "PATCH");

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E duplicate action/ }).click();
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();

  const node = dashboard.locator('[data-node-kind="session_action"]');
  await expect(node).toHaveCount(1);
  await node.click();
  await expect(dashboard.getByRole("button", { name: "Duplicate nodes" })).toBeEnabled();
  await dashboard.getByRole("button", { name: "Duplicate nodes" }).click();

  await expect(dashboard.locator('[data-node-kind="session_action"]')).toHaveCount(2);
  // Asserted against the route, because "a second box appeared" is not the claim - "the daemon
  // holds two nodes, and both name the action that was copied" is. Polled because the draft
  // autosaves on a debounce, so the DOM is ahead of the PATCH by design.
  await expect.poll(async () => {
    const detail = await api<{
      workflow: { draft: { nodes: Array<{ kind: string; sessionActionId?: string }> } };
    }>(daemon, `/api/workflows/${created.workflow.id}`);
    return detail.workflow.draft.nodes
      .filter((item) => item.kind === "session_action")
      .map((item) => item.sessionActionId);
  }).toEqual(["builtin:pull-request", "builtin:pull-request"]);
});

test("a graph naming the shipped built-in publishes, and freezes its snapshot", async ({
  dashboard,
  daemon,
}) => {
  // The other half of the turned-around negative. The same draft that was refused now reads as
  // itself in the pipeline AND publishes, and the version that comes back carries a frozen
  // copy of the shipped prompt rather than a live reference to it.
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E pr stage",
  });
  const id = created.workflow.id;
  await api(daemon, `/api/workflows/${id}`, {
    expectedDraftRevision: 1,
    draft: prDraft,
  }, "PATCH");

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E pr stage/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await expect(pipeline.locator("li.wf-pipeline-reviewer")).toContainText("Pull Request");
  await expect(pipeline.locator("li.wf-pipeline-reviewer")).toContainText("Skill · pull-request");
  // What the stage promises the runtime will prove, in the words the selector offered.
  await expect(pipeline.locator("li.wf-pipeline-reviewer"))
    .toContainText("Completes when pull request is opened and verified");
  // The picker no longer has to RETAIN it under a refusal label: it is addable, so it appears
  // as an ordinary option under its own name.
  await expect(pipeline.getByLabel("Choose the session action Stage 1 sends"))
    .not.toContainText("Not available in this build");

  await expect(dashboard.locator(".workflow-validation"))
    .not.toContainText("cannot verify a pull request");
  await dashboard.getByRole("button", { name: "Publish" }).click();

  // Polled: Publish is a click, and the version list is what the daemon has actually written.
  await expect.poll(async () =>
    (await api<Array<{ version: number }>>(daemon, `/api/workflows/${id}/versions`)).length,
  ).toBe(1);

  // The graph rides the single-version route; the list is summaries.
  const published = await api<{
    graph: {
      nodes: Array<{
        id: string;
        kind: string;
        action?: {
          completion: { kind: string };
          requiredSkillId: string | null;
          promptMarkdown: string;
        };
      }>;
    };
  }>(daemon, `/api/workflows/${id}/versions/1`);
  const frozen = published.graph.nodes.find((item) => item.id === PR_NODE.action)!;
  expect(frozen.kind).toBe("session_action");
  expect(frozen.action!.completion.kind).toBe("pull_request");
  expect(frozen.action!.requiredSkillId).toBe("pull-request");
  // The published node carries the TEXT, not the id it was resolved from: an edit to the
  // shipped document cannot reach a version already published.
  expect(frozen.action!.promptMarkdown).toContain("# Pull Request");
});

/** Session -> Retro built-in -> End, the shipped action whose proof is a commit. */
const RETRO_NODE = { action: "action-node", session: "session-node", end: "end-node" };

const retroDraft = {
  nodes: [
    { id: RETRO_NODE.session, kind: "session", position: { x: 60, y: 60 } },
    {
      id: RETRO_NODE.action,
      kind: "session_action",
      sessionActionId: "builtin:retro",
      position: { x: 340, y: 60 },
    },
    { id: RETRO_NODE.end, kind: "end", outcome: "Complete", position: { x: 620, y: 60 } },
  ],
  edges: [
    { id: "e-submit", source: RETRO_NODE.session, sourcePort: "submitted", target: RETRO_NODE.action, targetPort: "activate" },
    { id: "e-complete", source: RETRO_NODE.action, sourcePort: "complete", target: RETRO_NODE.end, targetPort: "terminal" },
  ],
};

/**
 * A commit-proving action is described as one, everywhere a reader can meet it.
 *
 * The kinds are append-only, and every surface below used to derive its own two-way split on
 * `=== "pull_request"`. Widening the tuple to `repo_commit` made all three say "the session
 * turn finishes" about an action that waits for a commit and will sit there with the turn long
 * settled - a confident wrong sentence, which is worse than no sentence. Asserted at all three
 * because they are three files: fixing one and missing the others is exactly what happened.
 */
test("a repo_commit action is captioned by what it proves, on the canvas, the rail and history", async ({
  dashboard,
  daemon,
}) => {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E retro stage",
  });
  const id = created.workflow.id;
  await api(daemon, `/api/workflows/${id}`, {
    expectedDraftRevision: 1,
    draft: retroDraft,
  }, "PATCH");

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E retro stage/ }).click();

  // The pipeline card, which already derived its sentence from the capability table.
  await expect(dashboard.locator(".wf-pipeline-strip"))
    .toContainText("Completes when a commit lands in the checkout");

  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();

  // The canvas node's subtitle.
  const node = dashboard.locator('[data-node-kind="session_action"]');
  await expect(node).toHaveCount(1);
  await expect(node).toContainText("Completes when a commit lands in the checkout");
  await expect(node).not.toContainText("session turn");

  // The properties rail, once the node is selected.
  await node.click();
  const rail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  await expect(rail).toContainText("Completes when a commit lands in the checkout");
  await expect(rail).not.toContainText("Completes when session turn finishes");

  // And the version history, which describes a guarantee that has already been published - the
  // worst of the three places to misstate it, because the run it describes has already run.
  await dashboard.getByRole("button", { name: "Publish" }).click();
  await expect.poll(async () =>
    (await api<Array<{ version: number }>>(daemon, `/api/workflows/${id}/versions`)).length,
  ).toBe(1);
  const history = dashboard.locator("section.workflow-version-history");
  await history.getByRole("button", { name: /Version 1/ }).click();
  await expect(history).toContainText("Completes when a commit lands in the checkout");
  await expect(history).not.toContainText("Completes when session turn finishes");
});
