import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The workflow builder, as a keyboard meets it.
 *
 * The builder's undo and redo shortcut is delegated: it is handled on the builder's container
 * for whichever builder control holds focus, and that container is now marked presentational
 * so the accessibility tree is unchanged. The Undo and Redo buttons read the draft's history
 * depth, which is now mirrored into state on every push, pop and clear. Both halves are
 * asserted below through the controls a person uses. No agent is launched, so no model
 * tokens are spent.
 */

async function createWorkflow(daemon: DaemonHandle, name: string): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/api/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: "For the builder keyboard spec." }),
  });
  if (!response.ok) throw new Error(`create workflow answered ${response.status}: ${await response.text()}`);
  const created = (await response.json()) as { workflow: { id: string } };
  return created.workflow.id;
}

test("the builder's undo shortcut and Undo/Redo buttons follow the draft history", async ({
  dashboard,
  daemon,
}) => {
  const original = "Keyboard undo workflow";
  const renamed = "Keyboard undo workflow, renamed";
  const id = await createWorkflow(daemon, original);
  await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${id}`);

  const name = dashboard.locator("section.workflow-policy-fields").getByLabel("Name");
  await expect(name).toHaveValue(original);
  const undo = dashboard.getByRole("button", { name: "Undo", exact: true });
  const redo = dashboard.getByRole("button", { name: "Redo", exact: true });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await name.fill(renamed);
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();

  // The shortcut stands down inside a text field, so focus a builder control that is not one.
  // Focusing the view toggle does not press it.
  await dashboard.getByRole("button", { name: "Graph", exact: true }).focus();
  await dashboard.keyboard.press("ControlOrMeta+z");
  await expect(name).toHaveValue(original);
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();

  await dashboard.getByRole("button", { name: "Graph", exact: true }).focus();
  await dashboard.keyboard.press("ControlOrMeta+Shift+z");
  await expect(name).toHaveValue(renamed);
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();

  // The buttons drive the same history as the shortcut.
  await undo.click();
  await expect(name).toHaveValue(original);
  await expect(redo).toBeEnabled();
});
