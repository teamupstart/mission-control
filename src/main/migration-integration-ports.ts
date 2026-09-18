import type { App } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE_URL, readClientToken, stateDir } from "@shared/harness-runtime.mjs";
import { createRotatingUpdateLogger } from "./update-log.ts";
import { locateCommandSync } from "../server/executables/locator.ts";
import { type MigrationPlan, type MigrationPolicy, readMigrationJournal, migrationBundleIdentity, migrationIsCommitted, migrationReceipt, validateMigrationTarget } from "../../scripts/install-migration.mjs";
import { sameMigrationProcess } from "../../scripts/migration-runtime.mjs";
import type { MigrationIntegrationPorts } from "./migration-integrations.ts";

type LoginApp = Pick<App, "getLoginItemSettings" | "setLoginItemSettings">;

/** Runs only in the verified retained source, before ordinary startup or redirects.
 * Electron's macOS login API acts on the calling bundle; its path option is Windows-only. */
export function removeMigrationSourceLogin(options: {
  stateDirectory: string; runningBundle: string; nonce: string; app: LoginApp;
  policy?: MigrationPolicy; parentPid?: number;
}): void {
  const journal = readMigrationJournal(options.stateDirectory, options.policy);
  if (!journal || journal.plan.nonce !== options.nonce || journal.plan.source !== options.runningBundle || journal.ownerRole !== "recovery" || journal.owner.pid !== (options.parentPid ?? process.ppid) || !sameMigrationProcess(journal.owner) || !migrationIsCommitted(journal, migrationReceipt(options.stateDirectory))) throw new Error("Login cleanup has no matching committed migration owner.");
  validateMigrationTarget(journal.plan);
  validateLoginSource(journal.plan);
  if (options.app.getLoginItemSettings().openAtLogin) options.app.setLoginItemSettings({openAtLogin: false});
  if (options.app.getLoginItemSettings().openAtLogin) throw new Error("Remove the retained system app from Login Items, then retry integration repair.");
}

function validateLoginSource(plan: MigrationPlan): void {
  const source = migrationBundleIdentity(plan.source);
  const expected = plan.sourceIdentity;
  if (source.commit !== expected.commit || source.version !== expected.version || source.revision !== expected.revision) throw new Error("The retained source changed before login cleanup.");
}

function launchSourceCleanup(plan: MigrationPlan): Promise<void> {
  validateLoginSource(plan);
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    execFile(join(plan.source, "Contents/MacOS/Mission Control"), ["--mission-migration-remove-login", plan.nonce],
      {env, timeout: 15_000, maxBuffer: 16 * 1024}, (error) => {
        if (error) reject(new Error("The retained system app could not verify removal from Login Items. Remove its login entry manually, then retry."));
        else resolve();
      });
  });
}

/** Electron, CLI and daemon adapters; the daemon remains the sole skills writer. */
export function createMigrationIntegrationPorts(app: LoginApp, options: {
  executable?: string; platform?: NodeJS.Platform; fetch?: typeof fetch;
  sourceCleanup?: (plan: MigrationPlan) => Promise<void>;
} = {}): MigrationIntegrationPorts {
  const executable = options.executable ?? process.execPath;
  const platform = options.platform ?? process.platform;
  return {
    home: homedir(), environment: process.env,
    log: createRotatingUpdateLogger(join(stateDir(), "update.log")),
    command: (spec, args) => {
      const command = locateCommandSync(spec.cli);
      if (!command) throw new Error(`${spec.cli} is unavailable. Install it or repair its configured path, then retry.`);
      try { return execFileSync(command.path, args, {encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024, env: command.env, stdio: ["ignore", "pipe", "pipe"]}); }
      catch { throw new Error(`${spec.cli} could not inspect its MCP registrations. Check the CLI configuration, then retry.`); }
    },
    login: () => app.getLoginItemSettings({path: executable}),
    retargetLogin: async (plan, openAtLogin) => {
      const target = join(plan.target, "Contents/MacOS/Mission Control");
      const source = join(plan.source, "Contents/MacOS/Mission Control");
      if (executable !== target) throw new Error("Login repair must run from the personal installation.");
      if (platform === "darwin") await (options.sourceCleanup ?? launchSourceCleanup)(plan);
      else if (platform === "win32") {
        if (app.getLoginItemSettings({path: source}).openAtLogin) app.setLoginItemSettings({path: source, openAtLogin: false});
        if (app.getLoginItemSettings({path: source}).openAtLogin) throw new Error("The retained source login entry could not be removed.");
      } else throw new Error("Login item repair is unsupported on this platform.");
      if (app.getLoginItemSettings({path: target}).openAtLogin !== openAtLogin) app.setLoginItemSettings({path: target, openAtLogin});
      const settings = app.getLoginItemSettings({path: target});
      if (settings.openAtLogin !== openAtLogin || (platform === "win32" && openAtLogin && !settings.executableWillLaunchAtLogin)) throw new Error("Login startup could not be verified for the personal app. Toggle Open at Login in the personal app, then retry.");
    },
    skills: async () => {
      const response = await (options.fetch ?? fetch)(`${BASE_URL}/api/skills/config`, {
        method: "PUT", headers: {"content-type": "application/json", "x-harness-token": readClientToken()},
        body: JSON.stringify({skills: {}}), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("The daemon could not reconcile existing skill settings. Open Settings > Skills, then retry.");
      const view = await response.json() as {blocked?: unknown[]; problems?: unknown[]};
      return [...(view.blocked ?? []), ...(view.problems ?? [])].map(String);
    },
  };
}
