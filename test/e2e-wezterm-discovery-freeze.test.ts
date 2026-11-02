import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { weztermEmulator } from "../e2e/fixtures/wezterm-boundary.ts";

test("WezTerm fixture freezes discovery even when an interrupted observation completes later", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wzf-"));
  const previousHome = process.env.MISSION_HOME;
  process.env.MISSION_HOME = home;
  const socket = join(home, "sock");
  let freezeDiscovery = false;
  const save = () => writeFileSync(join(home, "terminal-boundary.json"), JSON.stringify({ socket, freezeDiscovery }));
  save();
  const clients = new Set<Socket>();
  let interrupt: ((client: Socket) => void) | undefined;
  let paneId = 1;
  const server = createServer((client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.once("data", (data) => {
      const { args } = JSON.parse(data.toString()) as { args: string[] };
      if (interrupt && args.some((arg) => arg.startsWith("WEZTERM_UNIX_SOCKET="))) {
        const held = interrupt;
        interrupt = undefined;
        held(client);
      } else client.end(JSON.stringify([{ pane_id: paneId, tab_id: 1, window_id: 1, tty_name: "/dev/ttyfixture" }]));
    });
  });
  t.after(async () => {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.MISSION_HOME;
    else process.env.MISSION_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const adapter = weztermEmulator();
  const initial = await adapter.list!();
  assert.equal(initial?.[0]?.paneId, "1");

  // Pause the pinned list response, then freeze before it reports interrupted discovery.
  const inFlight = new Promise<Socket>((resolve) => { interrupt = resolve; });
  const pending = adapter.list!();
  const held = await inFlight;
  freezeDiscovery = true;
  save();
  held.end("interrupted list output");
  assert.deepEqual(await pending, initial, "in-flight discovery must not erase the frozen handle");
  assert.deepEqual(await adapter.list!(), initial);

  freezeDiscovery = false;
  save();
  paneId = 2;
  assert.equal((await adapter.list!())?.[0]?.paneId, "2", "fresh discovery resumes after the freeze");
});
