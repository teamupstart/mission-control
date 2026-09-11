import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * cmux installed, and unusable anyway - the reading this row used to get wrong.
 *
 * Two facts stand between an installed cmux and a working one, and Setup could see neither:
 * the control socket exists only while the app is RUNNING, and cmux ships
 * `automation.socketControlMode: "cmuxOnly"`, which admits only processes started inside
 * cmux. Under either, the adapter degrades to an empty pane list without a word, and this
 * row reported "Ready" on the strength of the binary being on PATH while every dispatch to
 * cmux failed.
 *
 * The repair for the second one edits a file belonging to another application, so
 * `MISSION_CMUX_CONFIG_PATH` puts it inside this run's disposable home (see
 * `fixtures/daemon.ts`). Nothing here can reach an operator's real `~/.config/cmux`.
 */

const ROW = "dependency-cmux";

/** Where `daemon.ts` points `MISSION_CMUX_CONFIG_PATH`, inside this run's disposable home. */
const configPath = (daemon: { home: string }): string =>
  join(daemon.home, "cmux-config", "cmux.json");

test.describe("a cmux that is installed and not running", () => {
  test.use({ daemonEnv: { MC_E2E_CMUX_CONTROL: "stopped" } });

  test("Setup says the app is closed and offers to open it, not to install again", async ({
    page,
    daemon,
  }) => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "terminals");
    const cmux = setupRow(page, ROW);

    await expectRowStatus(page, ROW, "Needs setup");
    await expect(cmux).toContainText("cmux is installed but not running.");
    // Not the install guide: cmux IS installed, and installing it again repairs nothing.
    await expect(cmux.getByRole("link", { name: "Open cmux installation guide" })).toHaveCount(0);
    await expect(cmux.getByRole("button", { name: "Open cmux" })).toBeEnabled();
    // And not the config repair, which fixes a fault this machine does not have.
    await expect(
      cmux.getByRole("button", { name: "Allow Mission Control to drive cmux" }),
    ).toHaveCount(0);
  });
});

test.describe("a cmux that is running and refusing", () => {
  test.use({ daemonEnv: { MC_E2E_CMUX_CONTROL: "refused" } });

  test("Setup names the setting, repairs the config file, and backs it up first", async ({
    page,
    daemon,
  }) => {
    const path = configPath(daemon);
    // The file cmux ships: a schema line, prose, and a commented-out template of every
    // setting. Its commented `socketControlMode` is the trap - it configures nothing, and a
    // repair that edited the text it matched would rewrite a comment and change no behavior.
    const shipped = [
      "{",
      '  "$schema": "https://example.invalid/cmux.schema.json",',
      '  "schemaVersion": 1,',
      "",
      "  // This file uses JSON with comments (JSONC).",
      "",
      '  //   "automation" : {',
      '  //     "socketControlMode" : "cmuxOnly"',
      "  //   },",
      "}",
      "",
    ].join("\n");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, shipped);

    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "terminals");
    const cmux = setupRow(page, ROW);

    await expectRowStatus(page, ROW, "Needs setup");
    await expect(cmux).toContainText(
      "cmux is running but its control socket only admits processes started inside cmux.",
    );
    // The row names the setting, so an operator who would rather edit it themselves can.
    await expect(cmux).toContainText("automation.socketControlMode");
    // Neither of the other two offers: this is not an install and not a closed app.
    await expect(cmux.getByRole("link", { name: "Open cmux installation guide" })).toHaveCount(0);
    await expect(cmux.getByRole("button", { name: "Open cmux" })).toHaveCount(0);

    const repaired = page.waitForResponse((response) =>
      response.url().endsWith("/api/setup/service") && response.request().method() === "POST");
    await cmux.getByRole("button", { name: "Allow Mission Control to drive cmux" }).click();
    const response = await repaired;
    expect(response.request().postDataJSON()).toEqual({ service: "cmux-socket-control" });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "cmux-socket-control",
      outcome: "started",
      label: "cmux socket control",
      // What the operator reads afterwards. This repair starts no process, so the sentence
      // says what changed and that cmux needs nothing further from them.
      detail: "cmux socket control is set to allowAll. cmux applies it without a restart.",
    });
    await expect(cmux).toContainText("cmux applies it without a restart.");

    const edited = readFileSync(path, "utf8");
    expect(edited).toMatch(/"socketControlMode":\s*"allowAll"/);
    // The operator's prose and their commented-out template are still theirs.
    expect(edited).toContain("// This file uses JSON with comments (JSONC).");
    expect(edited).toContain('//     "socketControlMode" : "cmuxOnly"');
    // And the file as it was is one copy away, under the timestamped name cmux's own help
    // asks an editor to leave behind.
    const backups = readdirSync(dirname(path)).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^cmux\.json\.\d{8}-\d{6}\.bak$/);
    expect(readFileSync(join(dirname(path), backups[0]!), "utf8")).toBe(shipped);

    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("cmux-socket-control");
      mkdirSync(evidence, { recursive: true });
      await page.mouse.move(1, 1);
      await cmux.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, "cmux-row-refused.png") });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/cmux-socket-control/cmux-row-refused.png");
    }
  });
});

test("a cmux whose socket answers is Ready, and reports the mode it is in", async ({
  page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const cmux = setupRow(page, ROW);

  await expectRowStatus(page, ROW, "Ready");
  await expect(cmux).toContainText("socket control allowAll");
  await expect(cmux.getByRole("button", { name: "Open cmux" })).toHaveCount(0);
  await expect(
    cmux.getByRole("button", { name: "Allow Mission Control to drive cmux" }),
  ).toHaveCount(0);
  // Nothing was written on the way to a satisfied row: the probe reads, and only the button
  // edits. A config that appeared here would mean Setup had repaired a machine on its own.
  expect(existsSync(configPath(daemon))).toBe(false);
});
