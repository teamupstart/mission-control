import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSafeAppLaunch, type MacAppOps } from "../../scripts/mac-app-lifecycle.mjs";
import { UpdateController, type UpdaterPort } from "../../src/main/updater.ts";
import { UPDATE_DIALOGS } from "../../src/shared/update-dialog.ts";
import { binaryOffer, binaryReceipt, binaryStaged } from "../../test/helpers/binary-update.ts";
import { connectUpdateController, pushUpdateDialog } from "../fixtures/update-controller.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

// The operator's failure, end to end: Restart and Install runs the real launch-conflict
// preflight (`assertSafeAppLaunch`) before the handoff. On their Mac ~470 GUI jobs printed one at
// a time took 25-29s under load against the installed build's 15s budget. The host below keeps
// that shape at a scale a browser test can afford: 400 jobs whose prints take 40ms each (2s at the
// sweep's 8-wide concurrency) against a 1.2s budget, while one `dumpstate` answers in 20ms.
const JOBS = 400;
const PRINT_MS = 40;
const BUDGET_MS = 1_200;
const labels = Array.from({length: JOBS}, (_, index) => `com.example.agent-${index}`);
const job = "type = Submitted\nprogram = /usr/bin/true\n";

/** A dump in launchd's real shape: the GUI domain's summary, then its jobs, then another domain. */
function dumpstate(uid: number): string {
  const block = (name: string, text: string) => `${name} = {\n${text.trimEnd().split("\n").map((line) => `\t${line}`).join("\n")}\n}\n\n`;
  const listing = labels.map((label) => `\t\t       0      - \t${label}`).join("\n");
  return block(`gui/${uid}`, `type = login\nservice count = ${JOBS}\n\nservices = {\n${listing}\n}`)
    + labels.map((label) => block(`gui/${uid}/${label}`, job)).join("")
    + "pid/1 = {\n\ttype = pid\n}\n";
}

/**
 * A Mac whose per-job prints are slow. `dump: false` is the installed build's path: it never asks
 * for `dumpstate`, and this module's per-job fallback is that same sweep. Every command honors the
 * budget it is handed the way `realMacAppOps` does: one slower than its budget is killed.
 */
function slowHost(dump: boolean, calls: string[]): MacAppOps {
  const answer = async (command: string, ms: number, timeout: number, stdout: string) => {
    if (ms > timeout) {
      await delay(timeout);
      throw new Error(`Could not inspect macOS launch state within the time limit (${basename(command)}).`);
    }
    await delay(ms);
    return {code: 0, stdout};
  };
  return {
    uid: 501, now: Date.now, sleep: (ms) => delay(ms),
    run: async (command, args, timeout = 15_000) => {
      calls.push(args[0] === "print" ? "print" : `${basename(command)} ${args[0] ?? ""}`.trim());
      if (command.endsWith("/lsappinfo")) return answer(command, 5, timeout, "");
      if (command.endsWith("/ps")) return answer(command, 5, timeout, "1 0 S /sbin/launchd\n");
      if (args[0] === "dumpstate") return dump ? answer(command, 20, timeout, dumpstate(501)) : {code: 1, stdout: ""};
      if (args[0] === "list") return answer(command, 5, timeout, `PID\tStatus\tLabel\n${labels.map((label) => `-\t0\t${label}`).join("\n")}\n`);
      return answer(command, PRINT_MS, timeout, job);
    },
    identity: () => null, kill: () => { throw new Error("the preflight never signals a process"); },
    readAck: () => null,
  };
}

for (const path of ["one dumpstate", "per-job prints"] as const) {
  test(`Restart and Install on a Mac with slow launchd prints: ${path}`, async ({dashboard, daemon}) => {
    const calls: string[] = [];
    const errors: string[] = [];
    const host = slowHost(path === "one dumpstate", calls);
    let handoffs = 0, quits = 0, dialogs = 0;
    const receipt = binaryReceipt(binaryOffer("a".repeat(40), "stable", "1.2.3"), {
      schema: 1 as const, repo: "teamupstart/mission-control", sourceClone: "/missing/source", appPath: "/Applications/Mission Control.app",
      installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-25T00:00:00Z",
    });
    const port: UpdaterPort = {
      readSnoozes: () => ({}), writeSnoozes: () => {},
      packaged: true, arch: "arm64", currentVersion: () => "1.2.3", currentCommit: () => "a".repeat(40), readAlpha: () => false, writeAlpha: () => {},
      installSnapshot: () => ({receipt, problem: null}),
      latestRelease: async () => ({tagName: "v1.2.4", name: "1.2.4", body: "Signed binary update.", publishedAt: "2026-10-25T00:00:00Z", isDraft: false, isPrerelease: false, binary: binaryOffer()}),
      latestMainCommit: async () => ({sha: "b".repeat(40), message: "Main build", committedAt: "2026-10-25T00:00:00Z"}),
      binaryForCommit: async (commit) => binaryOffer(commit, "alpha"),
      stage: async (request) => binaryStaged(request, join(daemon.home, "candidate.app")),
      stagedBundleIdentity: () => ({version: "1.2.4", revision: "staged-1", commit: "b".repeat(40)}),
      helperSource: () => "", stateDirectory: () => daemon.home,
      // The production preflight, over the slow host, with the scaled-down budget.
      launchPreflight: (bundle) => assertSafeAppLaunch(bundle, host, BUDGET_MS),
      handoff: async () => {handoffs++;}, requestQuit: () => {quits++;},
      readOutcome: () => null, clearOutcome: () => false, now: Date.now, random: () => 0, log: (line) => {errors.push(line);},
      dialogs: {
        error: async (message) => {await pushUpdateDialog(dashboard, {...UPDATE_DIALOGS.error(message), id: `error-${++dialogs}`});},
        available: async () => "defer", upToDate: async () => {}, preparing: async () => {}, ready: async () => "defer", applying: async () => {}, outcome: async () => {},
      },
    };
    const controller = new UpdateController(port); await controller.start(); await controller.check(true);
    const unsubscribe = await connectUpdateController(dashboard, controller, true);
    try {
      const banner = dashboard.getByRole("status", {name: "Mission Control update"});
      await banner.getByRole("button", {name: "Update Now"}).click();
      await expect(banner).toContainText("1.2.4 is ready to install");
      calls.length = 0;
      const started = Date.now();
      await banner.getByRole("button", {name: "Restart and Install"}).click();
      const shot = async (name: string) => {
        if (!process.env.MC_E2E_EVIDENCE) return;
        await mkdir("e2e/.artifacts/update-launch-preflight", {recursive: true});
        await dashboard.screenshot({path: `e2e/.artifacts/update-launch-preflight/${name}.png`});
      };
      if (path === "one dumpstate") {
        // The banner reads "Installing" from the start of the handoff; the preflight runs inside it.
        await expect.poll(() => handoffs, {timeout: BUDGET_MS * 4}).toBe(1);
        expect(quits).toBe(1);
        await expect(banner).toContainText("Installing Mission Control 1.2.4");
        expect(dialogs).toBe(0);
        expect(calls.filter((call) => call === "print")).toHaveLength(1);
        expect(calls).not.toContain("launchctl list");
        console.log(`[update-launch-preflight] ${path}: handed off in ${Date.now() - started}ms; ${calls.length} launch-state probes`);
        await shot("handed-off");
      } else {
        const dialog = dashboard.getByRole("dialog", {name: "Mission Control update"});
        await expect(dialog).toContainText("The update could not be completed");
        await expect(dialog).toContainText(/Could not inspect .*time limit/);
        await expectContentClearsBorder(dialog);
        expect(handoffs).toBe(0); expect(quits).toBe(0);
        expect(calls.filter((call) => call === "print").length).toBeLessThan(JOBS);
        console.log(`[update-launch-preflight] ${path}: refused in ${Date.now() - started}ms after ${calls.filter((call) => call === "print").length} of ${JOBS} prints; ${errors.at(-1)}`);
        await shot("refused");
      }
    } finally {unsubscribe(); controller.stop();}
  });
}
