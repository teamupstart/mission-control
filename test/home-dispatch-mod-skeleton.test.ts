// Headless mode phase 2: the mod skeleton. Flows and pane tabs are stubs behind `ModHost`, the
// `$.state` contract mirrors the shared schemas, and `build:mod` produces an installable folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  MissionControlInbox,
  MissionControlModState,
  PluginState,
  MissionControlRegistration,
  MissionControlResident,
} from "claude-code";
import { MOD_API, MOD_NAME } from "../src/mod/constants.ts";
import { PANE_TABS, renderPane } from "../src/mod/pane/index.ts";
import { PANE_NOT_IMPLEMENTED, type PaneProps } from "../src/mod/pane/types.ts";
import type { ModPaneTab, ModPanePlacement } from "../src/mod/host.ts";
import type {
  HomeDispatchInbox,
  HomeDispatchResident,
  HomeSessionRegistrationAnswer,
} from "../src/shared/home-dispatch.ts";
import { createFakeModHost } from "./helpers/home-dispatch-fakes.ts";
import { tempDir } from "./temp-root.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the later pane tabs draw not implemented for every placement, and the fake records the view", () => {
  const fake = createFakeModHost();
  // Needs you and Tasks are real since P12 (test/home-dispatch-mod-pane.test.ts).
  const tabs: ModPaneTab[] = ["workflows", "residents"];
  const placements: ModPanePlacement[] = ["dock", "inline", "widget"];
  assert.deepEqual(Object.keys(PANE_TABS).sort(), ["needs-you", "residents", "tasks", "workflows"]);
  for (const tab of tabs) {
    for (const placement of placements) {
      const props: PaneProps = { tab, placement, bodyColumns: 60 };
      const view = fake.drawPane(props);
      assert.deepEqual(view, { tab, placement, lines: [PANE_NOT_IMPLEMENTED], buttons: [] });
    }
  }
  assert.equal(fake.views.length, tabs.length * placements.length);
});

test("build:mod refuses an output directory outside dist/ and the temp directory, even through a symlink", () => {
  // Only throwaway targets are ever handed over: a sentinel in the gitignored .tmp/, a symlink to it
  // from the temp directory, and a path that does not exist. A broken guard could delete the sentinel.
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const sentinel = mkdtempSync(join(root, ".tmp", "mod-guard-"));
  writeFileSync(join(sentinel, "keep.txt"), "keep");
  const linkDir = tempDir("mission-mod-guard-");
  symlinkSync(sentinel, join(linkDir, "escape"));
  const refused = (out: string): boolean => {
    try {
      execFileSync(process.execPath, ["--import", "tsx", "scripts/build-mod.ts"], {
        cwd: root, env: { ...process.env, MISSION_MOD_OUT_DIR: out }, stdio: "pipe",
      });
      return false;
    } catch (error) {
      return /refusing to replace it/.test(String((error as { stderr?: Buffer }).stderr));
    }
  };
  try {
    assert.equal(refused(sentinel), true);
    assert.equal(refused(join(linkDir, "escape")), true);
    assert.equal(refused(join(root, ".tmp", "mod-guard-does-not-exist")), true);
    assert.equal(readFileSync(join(sentinel, "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(sentinel, { recursive: true, force: true });
  }
});

test("build:mod writes through a symlinked output directory into the directory it resolves to", () => {
  const real = tempDir("mission-mod-real-");
  const holder = tempDir("mission-mod-link-");
  const link = join(holder, "out");
  symlinkSync(real, link);
  try {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/build-mod.ts"], {
      cwd: root, env: { ...process.env, MISSION_MOD_OUT_DIR: link }, stdio: "pipe",
    });
    assert.ok(existsSync(join(real, "mission-control", ".claude-plugin", "plugin.json")), "built into the resolved directory");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the symlink itself was not replaced");
  } finally {
    rmSync(holder, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
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
  assert.match(contract, new RegExp(`interface PluginState \\{[^]*?"${MOD_NAME}": \\{[^]*?registration: MissionControlModState\\["registration"\\]`));
});

// `PluginState` spells every key out (the engine's validator reads literals), so it is a second list
// of `MissionControlModState`'s keys. Both are held to the same set, at the type level and in the source.
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
const pluginStateMirrorsModState: SameKeys<PluginState["mission-control"], MissionControlModState> = true;

test("PluginState mirrors every MissionControlModState key, each typed from it", () => {
  assert.equal(pluginStateMirrorsModState, true);
  const contract = readFileSync(join(root, "src/mod/types/index.d.ts"), "utf8");
  const block = (name: string): string => {
    const start = contract.indexOf(name);
    assert.notEqual(start, -1, name);
    return contract.slice(start, contract.indexOf("\n  }", start));
  };
  const modState = [...block("interface MissionControlModState {").matchAll(/^\s{4}(\w+): /gm)].map((m) => m[1]!);
  const mirrored = [...block('"mission-control": {').matchAll(/^\s{6}(\w+): MissionControlModState\["(\w+)"\];/gm)];
  assert.ok(modState.length >= 9, "the state has its nine keys");
  // Every key is mirrored once, and each mirror reads the key of the same name.
  assert.deepEqual(mirrored.map((m) => m[1]).sort(), [...modState].sort());
  for (const [, key, from] of mirrored) assert.equal(key, from);
});

test("npm run build:mod's script writes an installable folder marketplace that carries the pane", async () => {
  const out = tempDir("mission-mod-build-");
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
    for (const tab of ["workflows", "residents"] as const) {
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
