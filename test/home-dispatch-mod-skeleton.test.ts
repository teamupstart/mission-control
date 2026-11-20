// Headless mode phase 2: the mod skeleton. Flows and pane tabs are stubs behind `ModHost`, the
// `$.state` contract mirrors the shared schemas, and `build:mod` produces an installable folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type {
  MissionControlInbox,
  MissionControlModState,
  MissionControlRegistration,
  MissionControlResident,
} from "claude-code";
import { MOD_API, MOD_NAME } from "../src/mod/constants.ts";
import { FLOW_NOT_IMPLEMENTED } from "../src/mod/flows/command.ts";
import { runDispatchCommand, runDispatchFlow, runStartDispatchTool } from "../src/mod/flows/index.ts";
import { PANE_TABS, renderPane } from "../src/mod/pane/index.ts";
import { PANE_NOT_IMPLEMENTED, type PaneProps } from "../src/mod/pane/types.ts";
import { register } from "../src/mod/register.ts";
import type { ModPaneTab, ModPanePlacement } from "../src/mod/host.ts";
import type {
  HomeDispatchInbox,
  HomeDispatchResident,
  HomeSessionRegistrationAnswer,
} from "../src/shared/home-dispatch.ts";
import { createFakeModHost } from "./helpers/home-dispatch-fakes.ts";

const root = new URL("..", import.meta.url).pathname;

test("every flow is a stub that tells the person it is not implemented", async () => {
  const fake = createFakeModHost();
  await runDispatchCommand(fake.host, "");
  await runDispatchFlow(fake.host, { kind: "ship", words: "x" });
  await runStartDispatchTool(fake.host, { brief: "x" });
  assert.deepEqual(fake.notices, [FLOW_NOT_IMPLEMENTED, FLOW_NOT_IMPLEMENTED, FLOW_NOT_IMPLEMENTED]);
  // A stub never asks, fetches, opens the pane or writes to the model.
  assert.deepEqual(fake.calls.map((c) => c.type), ["notice", "notice", "notice"]);
});

test("each pane tab draws not implemented for every placement, and the fake records the view", () => {
  const fake = createFakeModHost();
  const tabs: ModPaneTab[] = ["needs-you", "tasks", "workflows", "residents"];
  const placements: ModPanePlacement[] = ["dock", "inline", "widget"];
  assert.deepEqual(Object.keys(PANE_TABS).sort(), [...tabs].sort());
  for (const tab of tabs) {
    for (const placement of placements) {
      const props: PaneProps = { tab, placement, bodyColumns: 60 };
      const view = fake.drawPane(props);
      assert.deepEqual(view, { tab, placement, lines: [PANE_NOT_IMPLEMENTED], buttons: [] });
    }
  }
  assert.equal(fake.views.length, tabs.length * placements.length);
});

test("the skeleton registers no hook, so an installed P2 build changes nothing in a session", () => {
  const on = (event: unknown) => assert.fail(`the P2 skeleton hooked ${String(event)}`);
  register(on, {});
});

test("the $.state contract matches the shared schemas in both directions", () => {
  // Type-level: `npm run typecheck` fails when either side drifts from the other.
  const registration = (a: HomeSessionRegistrationAnswer): MissionControlRegistration => a;
  const registrationBack = (a: MissionControlRegistration): HomeSessionRegistrationAnswer => a;
  const inbox = (a: HomeDispatchInbox): MissionControlInbox => a;
  const resident = (a: HomeDispatchResident): MissionControlResident => a;
  const state: MissionControlModState = {
    registration: null, draftId: null, inbox: null, residents: null, paneTab: "needs-you",
    paneView: "list", selectedTaskId: null, armedApproval: null, chatSince: 0,
  };
  void [registration, registrationBack, inbox, resident, state];
  // The engine holds `$.state` keys to the contract under the plugin's own name, so the
  // contract's key must be the plugin name `build:mod` writes into plugin.json.
  const contract = readFileSync(join(root, "src/mod/types/index.d.ts"), "utf8");
  assert.match(contract, new RegExp(`interface PluginState \\{\\s*"${MOD_NAME}": MissionControlModState;`));
});

test("npm run build:mod's script writes an installable folder marketplace that carries the pane", async () => {
  const out = mkdtempSync(join(tmpdir(), "mission-mod-build-"));
  try {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/build-mod.ts"], {
      cwd: root, env: { ...process.env, MISSION_MOD_OUT_DIR: out }, stdio: "pipe",
    });
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const read = (rel: string) => JSON.parse(readFileSync(join(out, rel), "utf8")) as Record<string, unknown>;

    const plugin = read("mission-control/.claude-plugin/plugin.json");
    assert.equal(plugin.name, "mission-control");
    assert.equal(plugin.version, pkg.version);
    assert.equal(plugin.modApi, MOD_API);
    assert.equal(plugin.types, "./types/index.d.ts");
    assert.ok(existsSync(join(out, "mission-control", "types", "index.d.ts")));

    assert.deepEqual(read("mission-control/hooks/hooks.json"), { modules: ["./register.js"] });
    const bundle = readFileSync(join(out, "mission-control/hooks/register.js"), "utf8");
    assert.match(bundle, /function register\(/);
    assert.doesNotMatch(bundle, /node:/);

    // The pane and the flows are in the built artifact, not only in source: load the built
    // module and draw every tab through it.
    const built = (await import(pathToFileURL(join(out, "mission-control/hooks/register.js")).href)) as {
      renderPane: typeof renderPane;
      PANE_TABS: Record<string, unknown>;
      runDispatchCommand: unknown;
    };
    assert.deepEqual(Object.keys(built.PANE_TABS).sort(), ["needs-you", "residents", "tasks", "workflows"]);
    assert.equal(typeof built.runDispatchCommand, "function");
    const fake = createFakeModHost();
    for (const tab of ["needs-you", "tasks", "workflows", "residents"] as const) {
      assert.deepEqual(
        built.renderPane(fake.host, { tab, placement: "dock", bodyColumns: 50 }).lines,
        [PANE_NOT_IMPLEMENTED],
      );
    }

    const market = read(".claude-plugin/marketplace.json") as { plugins: { name: string; source: string }[] };
    assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [["mission-control", "./mission-control"]]);
    assert.ok(existsSync(join(out, market.plugins[0]!.source, ".claude-plugin", "plugin.json")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
