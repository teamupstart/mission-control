import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  conductorWorktree,
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";

/**
 * Pushed pipeline events, end to end: a batch over HTTP, a daemon that folds it, and a panel
 * that says observation changed hands.
 *
 * What only this layer can prove. `test/pipeline-ingest.test.ts` pins the route's refusals
 * and the fold against an in-process app; `test/conductor-plugin.test.ts` pins the plugin's
 * batching against a stub emitter. Neither has a real daemon on a real port with a real
 * token file, a real watch loop, and a browser reading the answer - which is the whole of
 * what an operator is trusting when they install the plugin.
 *
 * The tick is set to TEN MINUTES on purpose, and it is the load-bearing part of this spec.
 * With a cadence that long, nothing in the window this test runs in can be explained by a
 * poll: every projection change asserted below was produced by the POST that preceded it,
 * or by nothing at all. A fast tick would make the same assertions pass against a daemon
 * whose ingest route did nothing but return 200.
 *
 * No model tokens: nothing here dispatches an agent, and the only subprocess the daemon
 * spawns is the fake `conduct-ts`.
 */
test.use({ daemonEnv: { MISSION_PIPELINE_TICK_MS: "600000" } });

const EVIDENCE = artifactsDir("conductor-live-ingest");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Unconditional, and that is the point: the live-events panel is a UI change, so the
 * screenshot that shows it working is part of what this spec OWES rather than an optional
 * extra a reviewer has to know an environment variable to obtain. Gating it behind a flag
 * meant the artifact existed only when somebody already knew to ask, which is precisely when
 * evidence is least needed.
 *
 * Safe to make unconditional because it cannot influence a result: every assertion about a
 * state has already been made by the time it is photographed, the files land in gitignored
 * `e2e/.artifacts/`, and four screenshots cost about a second of a twenty-second spec.
 *
 * The taller viewport is the whole reason this is not a bare `page.screenshot`. The panel is
 * longer than the default 720px, so a shot at that height opens on a paragraph cut through
 * the middle - which reads as a rendering fault in a reviewed screenshot rather than as the
 * scroll position it is.
 */
async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  const restore = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  if (restore) await page.setViewportSize(restore);
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conductor-live-ingest/${name}.png`);
}

/** The daemon's own shared secret, from the file it wrote - not one this spec invented. */
function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/** One envelope line, in the frozen wire shape the shipped plugin posts. */
function line(
  daemon: DaemonHandle,
  slug: string,
  event: Record<string, unknown>,
  seq: number,
): string {
  return JSON.stringify({
    repo: daemon.repo,
    worktree: conductorWorktree(daemon.repo, slug),
    slug,
    seq,
    event,
  });
}

/** POST an NDJSON batch exactly as the plugin does. */
async function push(
  daemon: DaemonHandle,
  lines: readonly string[],
  auth: string | null,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${daemon.baseURL}/ingest/conductor`, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      ...(auth === null ? {} : { "x-harness-token": auth }),
    },
    body: `${lines.join("\n")}\n`,
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

test("a pushed batch projects a run the daemon has not polled for", async ({ page, daemon }) => {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", memory: "done", build: "in_progress" },
    lastStep: "build",
    tier: "M",
    track: "product",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });

  await page.goto(`${daemon.baseURL}/#/settings/conductor`);
  await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();

  // Consent, in two acts, exactly as the operator gives it.
  await page.locator('.sc-card[data-anchor="conductor/enabled"] label.sc-switch').click();
  const repoSwitch = page.getByRole("checkbox", { name: "Observe pipelines in demo-repo" });
  await repoSwitch.check();
  await expect(page.getByText("On - reading 1 repository.")).toBeVisible();

  // Waited for from the DAEMON's side, not the panel's. Saves are applied optimistically and
  // serialized, so the sentence above can be drawn while the PUT is still in flight - and a
  // push that arrived first would be refused for a repository the operator had consented to,
  // which is a race in the test rather than a fact about the route.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
        return (await res.json()).config;
      },
      { message: "the daemon should hold consent for the seeded repository" },
    )
    .toMatchObject({ enabled: true, repos: [{ repoRoot: daemon.repo, enabled: true }] });

  // Nothing has been read, and with a ten-minute cadence nothing is going to be. This is the
  // baseline that makes every assertion below attributable to a POST.
  await expect(page.getByText("Enabled - not read yet.")).toBeVisible();
  await shoot(page, "01-consented-not-yet-read");

  // A batch with the wrong secret is refused, and changes nothing. First, because a route
  // that accepted this would make every assertion after it meaningless.
  const refused = await push(daemon, [line(daemon, "add-widgets", { type: "step_started" }, 1)], "not-the-token");
  expect(refused.status).toBe(401);
  const missing = await push(daemon, [line(daemon, "add-widgets", { type: "step_started" }, 1)], null);
  expect(missing.status).toBe(401);
  await expect(page.getByText("Enabled - not read yet.")).toBeVisible();

  // And with the daemon's own token, the run appears - from a push, on a daemon whose next
  // poll is ten minutes away.
  const accepted = await push(
    daemon,
    [
      line(daemon, "add-widgets", { type: "step_started", step: "build" }, 1),
      line(daemon, "add-widgets", { type: "gate_verdict", step: "build", satisfied: true }, 2),
    ],
    token(daemon),
  );
  expect(accepted.status).toBe(200);
  expect(accepted.body).toMatchObject({ received: 2, stored: 2, malformed: 0, unconsented: 0 });

  // The health line: the engine's daemon, the run it found, and how it found out.
  await expect(
    page.getByText(/engine daemon running · 1 pipeline · live events/),
  ).toBeVisible({ timeout: 15_000 });
  await shoot(page, "02-live-events");

  // The projection itself, not only the sentence about it - the row phases 2 and 3 render.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
        return (await res.json()).status?.[0];
      },
      { message: "the daemon should have projected the run from the push alone" },
    )
    .toMatchObject({ runs: 1, halted: 0, ingest: "live" });

  // Now the engine halts. It writes its files - which is where halts live, because conductor
  // does not persist a halt to its event ledger at all - and emits. The push is what makes
  // the daemon look; the files are still what it reads.
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", memory: "done", build: "done" },
    lastStep: "build",
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
  });
  const halted = await push(
    daemon,
    [line(daemon, "add-widgets", { type: "loop_halt", step: "build" }, 3)],
    token(daemon),
  );
  expect(halted.status).toBe(200);

  await expect(
    page.getByText(/engine daemon running · 1 pipeline, 1 halted · live events/),
  ).toBeVisible({ timeout: 15_000 });
  await shoot(page, "03-halt-arrived-by-push");

  // A malformed line costs that line and nothing else - the posture that lets the envelope
  // stay tolerant of a conductor release nobody here has read.
  const mixed = await push(
    daemon,
    [
      "{ not json at all",
      line(daemon, "add-widgets", { type: "a_kind_from_the_future", detail: { x: 1 } }, 4),
    ],
    token(daemon),
  );
  expect(mixed.status).toBe(200);
  expect(mixed.body).toMatchObject({ received: 2, stored: 1, malformed: 1 });
});

test("a push for a repository nobody consented to is dropped", async ({ page, daemon }) => {
  // The consent boundary, at the one door something outside Mission Control pushes through.
  // Asserted in a browser rather than only in-process because the sequence that matters is
  // an operator's: they can SEE that a repository is switched off, and the push must not
  // quietly make it observed anyway.
  writeConductorProjects(daemon.home, [
    { name: "demo-repo", path: daemon.repo },
    { name: "second-repo", path: daemon.secondRepo },
  ]);
  seedConductorRun(daemon.secondRepo, "secret-feature", { steps: { build: "in_progress" } });
  seedConductorDaemon(daemon.secondRepo, { pid: process.pid });

  await page.goto(`${daemon.baseURL}/#/settings/conductor`);
  await page.locator('.sc-card[data-anchor="conductor/enabled"] label.sc-switch').click();
  await page.getByRole("checkbox", { name: "Observe pipelines in demo-repo" }).check();
  const second = page.getByRole("checkbox", { name: "Observe pipelines in second-repo" });
  await expect(second).not.toBeChecked();

  const res = await fetch(`${daemon.baseURL}/ingest/conductor`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson", "x-harness-token": token(daemon) },
    body: `${JSON.stringify({
      repo: daemon.secondRepo,
      worktree: conductorWorktree(daemon.secondRepo, "secret-feature"),
      slug: "secret-feature",
      seq: 1,
      event: { type: "step_started", step: "build" },
    })}\n`,
  });
  // Accepted as a request and refused as an observation: the plugin cannot fix this, so a
  // 4xx would only make it log for ever. The count is the honest channel.
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ received: 1, stored: 0, unconsented: 1 });

  // And the panel still shows it unobserved, from the daemon's own answer.
  await expect(second).not.toBeChecked();
  await expect
    .poll(async () => {
      const view = await (await page.request.get(`${daemon.baseURL}/api/pipelines/config`)).json();
      return view.status?.length ?? 0;
    })
    .toBe(1);
  await shoot(page, "04-unconsented-dropped");
});
