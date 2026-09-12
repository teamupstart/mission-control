import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh state dir above the imports: this file WRITES the terminals config through the
// route and then has the daemon read it back, so it needs a database of its own.
const home = mkdtempSync(join(tmpdir(), "mission-focus-route-"));
process.env.MISSION_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { configuredTerminalDeps } = await import("../src/server/terminals-config.ts");

import { OK, fakeEmulator, fakeMultiplexer } from "./helpers/terminal-fakes.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { TabSpec } from "../src/server/terminal/types.ts";

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { "content-type": "application/json", host: "127.0.0.1:7317" };

/** Each fake records the tabs it was asked to open, which is the observation this file makes. */
function recordingEmulator(id: "wezterm" | "ghostty" | "iterm", label: string) {
  const opened: TabSpec[] = [];
  return {
    opened,
    backend: fakeEmulator({
      id,
      label,
      spawn: {
        tab: async (spec: TabSpec) => {
          opened.push(spec);
          return { ...OK, target: null };
        },
      },
    }),
  };
}

/**
 * The daemon's own deps with only the REGISTRIES swapped - `focusEmulator` is left exactly as
 * `configuredTerminalDeps` composed it.
 *
 * The adapters are swapped because no emulator can be faked through its binary
 * (`e2e/fixtures/fake-agents.ts` records that as why cmux is the only backend that suite
 * installs), so a real one here would open a window on the machine running the test.
 */
function terminals() {
  const wezterm = recordingEmulator("wezterm", "WezTerm");
  const ghostty = recordingEmulator("ghostty", "Ghostty");
  const iterm = recordingEmulator("iterm", "iTerm2");
  const tmux = fakeMultiplexer({
    sessions: {
      spawnDetached: async () => OK,
      attachArgv: (name: string) => ["fake-mux", "attach", "-t", name],
      rename: async () => OK,
      kill: async () => OK,
      names: { validate: () => null, sanitize: (t: string) => t },
    },
    clients: async () => [],
    select: async () => OK,
  });
  return {
    wezterm,
    ghostty,
    iterm,
    deps: {
      ...configuredTerminalDeps,
      multiplexers: { tmux, herdr: fakeMultiplexer({ id: "herdr" }), cmux: fakeMultiplexer({ id: "cmux" }) },
      emulators: { wezterm: wezterm.backend, ghostty: ghostty.backend, iterm: iterm.backend },
      // Travels with the registries: `installed` probes the real filesystem for the real
      // adapters' binaries, and fake adapters carry a spec no machine has. Leaving the
      // production probe here would skip every candidate and prove only that nothing opened.
      installed: () => true,
    },
  };
}

function discovered(): DiscoveredSession {
  return {
    syntheticId: "s1",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/wt/work",
    gitBranch: null,
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "work", windowName: "0", paneId: "%3" })],
    startedAt: 0,
  } as DiscoveredSession;
}

function appWith(focusTerminals: ReturnType<typeof terminals>["deps"]) {
  const registry = new Registry();
  registry.applyDiscovery([discovered()]);
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined,
    focusTerminals,
  );
  const session = registry.snapshot().sessions.find((s) => s.id === "s1")!;
  return { app, session };
}

test("a preference saved over the route is the terminal the focus route opens", async () => {
  const t = terminals();
  const { app, session } = appWith(t.deps);

  const saved = await app.request("/api/terminals/config", {
    method: "PUT",
    headers: LOOPBACK,
    body: JSON.stringify({ multiplexerTerminal: { tmux: "iterm" } }),
  });
  assert.equal(saved.status, 200);
  assert.equal(
    ((await saved.json()) as { multiplexerTerminal: Record<string, string | null> })
      .multiplexerTerminal.tmux,
    "iterm",
  );

  const focused = await app.request(`/api/sessions/${session.id}/focus`, {
    method: "POST",
    headers: LOOPBACK,
  });
  assert.equal(focused.status, 200);
  assert.deepEqual(await focused.json(), { ok: true });

  assert.deepEqual(t.iterm.opened.map((spec) => spec.argv), [
    ["fake-mux", "attach", "-t", "work"],
  ]);
  // `wezterm` is the registry's first entry, so an unread preference would land here.
  assert.deepEqual(t.wezterm.opened, []);
  assert.deepEqual(t.ghostty.opened, []);
});

test("changing the saved preference reaches the very next focus, with no restart", async () => {
  const t = terminals();
  const { app, session } = appWith(t.deps);
  const save = (backend: string | null) =>
    app.request("/api/terminals/config", {
      method: "PUT",
      headers: LOOPBACK,
      body: JSON.stringify({ multiplexerTerminal: { tmux: backend } }),
    });
  const focus = () =>
    app.request(`/api/sessions/${session.id}/focus`, { method: "POST", headers: LOOPBACK });

  await save("ghostty");
  await focus();
  await save("iterm");
  await focus();

  assert.equal(t.ghostty.opened.length, 1);
  assert.equal(t.iterm.opened.length, 1);

  // One app instance throughout, so none of these three readings came from a restart.
  await save(null);
  await focus();
  assert.equal(t.wezterm.opened.length, 1);
});
