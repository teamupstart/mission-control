import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The two DURABLE task creators offering *Inherit* for their agent: a Recurring Mission and a
 * task source.
 *
 * The feature is "chosen once on Settings → Models instead of overridden by hand", and the
 * paths that most need it are the two that file work while nobody is watching. Both used to
 * carry a Claude that no operator ever chose - a schema default wearing the costume of a pin -
 * and a pin is exactly what the kind default may not override. So the kind default reached
 * every creator except the ones that run unattended.
 *
 * What only a browser can say here:
 *
 *   - The control EXISTS and is the resting state. A stored `null` that no picker can produce
 *     is a contract nobody can reach.
 *   - Choosing *Inherit* disables the Model select and says why, because a model id belongs to
 *     one harness and an inheriting template does not know which harness it will get.
 *   - The choice survives the round trip through the daemon, which is the half an optimistic
 *     DOM cannot prove - so this asserts against `GET /api/schedules` after the save.
 *
 * NO AGENT IS DISPATCHED. A mission files backlog rows on a cadence and never launches one,
 * and nothing here fires an occurrence. No binary runs, faked or otherwise, and no model
 * tokens are spent. Every control is reached by role and accessible name.
 */

const EVIDENCE = artifactsDir("task-kind-agent-inheritance");

/**
 * A viewport frame, scrolled so `scrollTo` is actually in it.
 *
 * The subject of both shots sits below the fold of a long form, and a viewport shot taken
 * where the page happens to be photographs everything except the control the assertion beside
 * it just proved.
 */
async function shoot(page: Page, name: string, scrollTo?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // `Tooltip` portals a bubble over whatever is being photographed once anything is hovered.
  await page.mouse.move(0, 0);
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-kind-agent-inheritance/${name}.png`);
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} answered ${response.status} with non-JSON: ${text.slice(0, 160)}`);
  }
}

interface StoredSchedule {
  id: string;
  name: string;
  template: { agent: string | null; model: string | null } | null;
}

/** A mission that names no agent, which is what "Inherit" is stored as. */
async function seedMission(daemon: DaemonHandle, name: string): Promise<StoredSchedule> {
  return api<StoredSchedule>(daemon, "/api/schedules", {
    method: "POST",
    body: {
      name,
      expression: "0 3 * * *",
      timezone: "UTC",
      overlapPolicy: "skip-active",
      missedPolicy: "coalesce-latest",
      template: {
        title: `${name} task`,
        intent: `Whatever ${name} is for.`,
        repoRoot: daemon.repo,
        kind: "plan",
      },
    },
  });
}

function storedAgent(daemon: DaemonHandle, id: string): Promise<string | null | undefined> {
  return api<StoredSchedule[]>(daemon, "/api/schedules").then(
    (all) => all.find((s) => s.id === id)?.template?.agent,
  );
}

test("a recurring mission inherits its agent, and says why it cannot pin a model", async ({
  dashboard,
  daemon,
}) => {
  const mission = await seedMission(daemon, "Nightly plan");
  // The API is the contract the UI has to agree with: an omitted agent is stored as an
  // inherit, not as the Claude a schema default used to invent.
  expect(await storedAgent(daemon, mission.id)).toBeNull();

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Nightly plan", exact: false }).first().click();
  await dashboard.getByRole("button", { name: "Edit" }).first().click();

  const agent = dashboard.getByRole("combobox", { name: "Agent", exact: true });
  await expect(agent).toBeVisible();
  // Resting state: what the daemon stored, drawn as the option an operator can also choose.
  await expect(agent).toHaveValue("");
  const model = dashboard.getByRole("combobox", { name: /^Model/ });
  await expect(model, "an inheriting mission must not be able to pin a model").toBeDisabled();
  await expect(model).toHaveAccessibleDescription(/belongs to one harness/);
  // Scrolled past the Model row rather than to it: a sticky action bar sits over the bottom of
  // the form, so stopping AT the subject leaves it under the bar in the frame.
  await shoot(dashboard, "01-mission-inherits", dashboard.getByText("Cadence and time zone"));

  // Naming a harness is a pin, and it unlocks the model that belongs to it.
  await agent.selectOption("claude");
  await expect(model).toBeEnabled();
  await shoot(dashboard, "02-mission-pinned", dashboard.getByText("Cadence and time zone"));

  // ...and back, because a mind changed after a save is the case that strands a model.
  await agent.selectOption("");
  await expect(model).toBeDisabled();
});

test("a task source offers Inherit, and stores it as no agent at all", async ({
  dashboard,
  daemon,
}) => {
  // Seeded through the daemon's own route so the panel is reading real stored state rather
  // than a draft it has not saved yet.
  await api(daemon, "/api/task-sources/config", {
    method: "PUT",
    body: {
      sources: [
        {
          id: "src-e2e",
          kind: "github-issues",
          label: "inbox",
          enabled: false,
          repoRoot: daemon.repo,
          intervalMs: 900_000,
          defaults: { kind: "plan", priority: null, labels: [], enabled: true },
          maxPerSweep: 25,
          config: { owner: "o", repo: "r", query: "" },
        },
      ],
    },
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const agent = dashboard.getByRole("combobox", { name: "Agent for tasks this source files" });
  await expect(agent).toBeVisible();
  // Stored with no agent, so the control rests on Inherit rather than showing a harness the
  // operator never picked.
  await expect(agent).toHaveValue("");
  await expect(agent.getByRole("option", { name: /Inherit/ })).toHaveCount(1);
  await shoot(dashboard, "03-source-inherits", agent);

  await agent.selectOption("codex");
  await expect
    .poll(async () => {
      const view = await api<{ sources: Array<{ id: string; defaults: { agent: string | null } }> }>(
        daemon,
        "/api/task-sources/config",
      );
      return view.sources.find((s) => s.id === "src-e2e")?.defaults.agent;
    }, { message: "choosing a harness on a source should reach the daemon as a pin" })
    .toBe("codex");
});
