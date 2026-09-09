import assert from "node:assert/strict";
import test from "node:test";

import { MULTIPLEXER_IDS } from "../src/shared/terminal.ts";
import { executableSpec } from "../src/server/executables/catalog.ts";
import { binUnsupportedReason, resolveBin } from "../src/server/terminal/bin.ts";
import {
  HERDR_BIN,
  HERDR_UNSUPPORTED_REASON,
  herdrEnvironment,
  herdrMultiplexer,
  herdrServerProbe,
} from "../src/server/terminal/herdr.ts";
import { HERDR_MIN_VERSION, HERDR_PROTOCOL } from "../src/server/terminal/herdr-client.ts";
import { MULTIPLEXERS } from "../src/server/terminal/registry.ts";
import { terminalTargetViews } from "../src/server/terminal/targets.ts";
import { ALL_KEYS, type Key } from "../src/server/terminal/types.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";
import type { RunResult } from "../src/server/util/exec.ts";
import { fakeHerdrSocket, refuse, reply, type HerdrRequest } from "./helpers/herdr-socket.ts";
import { fakeEmulator, fakeMultiplexer, fakeTerminals } from "./helpers/terminal-fakes.ts";

function result(stdout: string): RunResult {
  return { stdout, stderr: "", code: 0, outcomeUnknown: false, overflowed: false };
}

function execStatus(socket: string, calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }> = []): TerminalExec {
  return async (bin, args, opts) => {
    calls.push({ bin, args, env: opts?.env });
    return result(JSON.stringify({
      status: "running",
      running: true,
      version: HERDR_MIN_VERSION,
      protocol: HERDR_PROTOCOL,
      capabilities: {},
      compatible: true,
      socket,
      session: null,
      restart_needed: false,
    }));
  };
}

const SNAPSHOT = {
  type: "session_snapshot",
  snapshot: {
    version: HERDR_MIN_VERSION,
    protocol: HERDR_PROTOCOL,
    workspaces: [
      { workspace_id: "ws-api", label: "API" },
      { workspace_id: "ws-web", label: "Web" },
    ],
    tabs: [
      { tab_id: "tab-api", workspace_id: "ws-api", number: 1, label: "agent" },
      { tab_id: "tab-web", workspace_id: "ws-web", number: 2, label: "tests" },
    ],
    panes: [
      { pane_id: "pane-api", workspace_id: "ws-api", tab_id: "tab-api", cwd: "/repo", foreground_cwd: "/repo/api" },
      { pane_id: "pane-web", workspace_id: "ws-web", tab_id: "tab-web", cwd: "/repo/web", foreground_cwd: null },
    ],
  },
};

function standardReply(request: HerdrRequest, socket: import("node:net").Socket): void {
  if (request.method === "session.snapshot") reply(socket, request.id, SNAPSHOT);
  else if (request.method === "pane.process_info") {
    const paneId = String(request.params.pane_id);
    reply(socket, request.id, {
      type: "pane_process_info",
      process_info: { pane_id: paneId, shell_pid: paneId === "pane-api" ? 111 : 222, tty: null },
    });
  } else if (request.method === "pane.read") {
    reply(socket, request.id, { type: "pane_read", read: { pane_id: request.params.pane_id, text: "visible output" } });
  } else {
    reply(socket, request.id, { type: "ok" });
  }
}

test("Herdr is registered in exact inner-to-outer order with declared null capabilities", () => {
  assert.deepEqual(MULTIPLEXER_IDS, ["tmux", "herdr", "cmux"]);
  assert.equal(MULTIPLEXERS.herdr.id, "herdr");
  assert.equal(MULTIPLEXERS.herdr.label, "Herdr");
  assert.equal(MULTIPLEXERS.herdr.glyph, "▦");
  assert.equal(MULTIPLEXERS.herdr.clients, null);
  assert.equal(MULTIPLEXERS.herdr.paneMode, null);
  assert.equal(MULTIPLEXERS.herdr.sessions?.names.validate("plain name"), null);
});

test("list maps workspaces, tabs, panes, shell pids, and cwd fallback to stable generic handles", async () => {
  const fake = await fakeHerdrSocket(standardReply);
  try {
    const panes = await herdrMultiplexer(execStatus(fake.path)).list();
    assert.deepEqual(panes, [
      {
        session: "ws-api",
        sessionName: "API",
        windowIndex: 1,
        windowName: "agent",
        paneId: "pane-api",
        panePid: 111,
        tty: null,
        cwd: "/repo/api",
      },
      {
        session: "ws-web",
        sessionName: "Web",
        windowIndex: 2,
        windowName: "tests",
        paneId: "pane-web",
        panePid: 222,
        tty: null,
        cwd: "/repo/web",
      },
    ]);
  } finally {
    await fake.close();
  }
});

test("a stale pane process lookup keeps the pane visible with an unknown pid", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    if (request.method === "session.snapshot") reply(socket, request.id, SNAPSHOT);
    else if (request.params.pane_id === "pane-api") {
      socket.write(`${JSON.stringify({
        id: request.id,
        error: { code: "pane_not_found", message: "pane closed during snapshot enrichment" },
      })}\n`);
    } else {
      reply(socket, request.id, {
        type: "pane_process_info",
        process_info: { pane_id: request.params.pane_id, shell_pid: 222, tty: null },
      });
    }
  });
  try {
    const panes = await herdrMultiplexer(execStatus(fake.path)).list();
    assert.equal(panes.length, 2);
    assert.equal(panes.find((pane) => pane.paneId === "pane-api")?.panePid, null);
    assert.equal(panes.find((pane) => pane.paneId === "pane-web")?.panePid, 222);
  } finally {
    await fake.close();
  }
});

// The discovery sweep polls every installed backend every 1500ms and its only handler is a
// `console.error` around the whole tick, so a lister that throws does not report a problem -
// it prints a stack trace forever on a machine whose Herdr server is simply not up. Every
// sibling lister degrades to `[]`, and the Setup row for Herdr is where the server's state is
// reported once, to somebody who can act on it.
test("a refused pane lookup degrades to an empty pane list rather than throwing", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    if (request.method === "session.snapshot") reply(socket, request.id, SNAPSHOT);
    else {
      socket.write(`${JSON.stringify({
        id: request.id,
        error: { code: "permission_denied", message: "process inspection denied" },
      })}\n`);
    }
  });
  try {
    assert.deepEqual(await herdrMultiplexer(execStatus(fake.path)).list(), []);
  } finally {
    await fake.close();
  }
});

test("a stopped Herdr server enumerates as no panes, with no socket attempt", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const stopped: TerminalExec = async (bin, args) => {
    calls.push({ bin, args });
    return result(JSON.stringify({
      status: "not_running",
      running: false,
      version: null,
      protocol: null,
      compatible: null,
      socket: "/nonexistent/herdr.sock",
      restart_needed: false,
    }));
  };
  assert.deepEqual(await herdrMultiplexer(stopped).list(), []);
  assert.deepEqual(calls.map((call) => call.args), [["status", "server", "--json"]]);
});

test("an unreadable Herdr status enumerates as no panes", async () => {
  const broken: TerminalExec = async () => ({
    stdout: "", stderr: "herdr: command failed", code: 1, outcomeUnknown: false, overflowed: false,
  });
  assert.deepEqual(await herdrMultiplexer(broken).list(), []);
});

test("the Herdr server probe reports the same three states the transport gates on", async () => {
  const fake = await fakeHerdrSocket(standardReply);
  try {
    assert.deepEqual(await herdrServerProbe(execStatus(fake.path)), {
      state: "ready",
      socket: fake.path,
      version: HERDR_MIN_VERSION,
    });
  } finally {
    await fake.close();
  }
  const stopped = await herdrServerProbe(async () => result(JSON.stringify({
    status: "not_running",
    running: false,
    version: null,
    protocol: null,
    compatible: null,
    socket: "/nonexistent/herdr.sock",
    restart_needed: false,
  })));
  assert.deepEqual(stopped, { state: "stopped", socket: "/nonexistent/herdr.sock" });

  const failed = await herdrServerProbe(async () => result(JSON.stringify({
    status: "running",
    running: true,
    version: "0.7.0",
    protocol: 19,
    compatible: false,
    socket: "/nonexistent/herdr.sock",
    restart_needed: true,
  })));
  assert.equal(failed.state, "failed");
  assert.equal(failed.state === "failed" ? failed.retryable : true, false);
});

test("pane control uses raw text, exhaustive key names, bracket-aware paste, visible capture, and agent focus", async () => {
  const fake = await fakeHerdrSocket(standardReply);
  try {
    const mux = herdrMultiplexer(execStatus(fake.path));
    const target = { session: "ws-api", windowIndex: 1, paneId: "pane-api" };
    assert.equal((await mux.write.text(target, "literal\\ntext")).ok, true);
    assert.equal((await mux.write.keys(target, ALL_KEYS)).ok, true);
    assert.equal((await mux.write.paste?.(target, "line one\nline two"))?.ok, true);
    assert.equal(await mux.capture?.(target), "visible output");
    assert.equal((await mux.select?.(target))?.ok, true);

    const byMethod = new Map(fake.requests.map((request) => [request.method, request]));
    assert.deepEqual(byMethod.get("pane.send_text")?.params, { pane_id: "pane-api", text: "literal\\ntext" });
    const expected: Record<Key, string> = {
      enter: "enter", escape: "esc", up: "up", down: "down", left: "left", right: "right",
      tab: "tab", "shift-up": "shift+up", "shift-down": "shift+down", "shift-tab": "shift+tab",
    };
    assert.deepEqual(byMethod.get("pane.send_keys")?.params, {
      pane_id: "pane-api",
      keys: ALL_KEYS.map((key) => expected[key]),
    });
    assert.deepEqual(byMethod.get("pane.send_input")?.params, {
      pane_id: "pane-api",
      text: "line one\nline two",
      keys: [],
    });
    assert.deepEqual(byMethod.get("pane.read")?.params, {
      pane_id: "pane-api",
      source: "visible",
      format: "text",
      strip_ansi: true,
    });
    assert.deepEqual(byMethod.get("agent.focus")?.params, { target: "pane-api" });
  } finally {
    await fake.close();
  }
});

test("workspace lifecycle keeps exact cwd, selection intent, shell boundaries, and no-focus side split", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    if (request.method === "workspace.create") {
      reply(socket, request.id, {
        type: "workspace_created",
        workspace: { workspace_id: "workspace-uuid", label: request.params.label },
        tab: { tab_id: "tab-uuid", workspace_id: "workspace-uuid", number: 1, label: "main" },
        root_pane: { pane_id: "pane-uuid", workspace_id: "workspace-uuid", tab_id: "tab-uuid", cwd: request.params.cwd },
      });
    } else if (request.method === "pane.split") {
      reply(socket, request.id, {
        type: "pane_created",
        pane: { pane_id: "side-pane", workspace_id: "workspace-uuid", tab_id: "tab-uuid", cwd: request.params.cwd },
      });
    } else if (request.method === "workspace.rename") {
      reply(socket, request.id, {
        type: "workspace_info",
        workspace: { workspace_id: "workspace-uuid", label: request.params.label },
      });
    } else {
      reply(socket, request.id, { type: "ok" });
    }
  });
  try {
    const mux = herdrMultiplexer(execStatus(fake.path));
    const sessions = mux.sessions!;
    const launched = await sessions.spawnDetached({
      name: "Feature work",
      cwd: "/repo/a path",
      select: true,
      argv: ["agent", "a b", "don't"],
      sidePane: true,
    });
    assert.deepEqual(launched, { ok: true, outcomeUnknown: false });
    assert.deepEqual(fake.requests.map((request) => [request.method, request.params]), [
      ["workspace.create", { label: "Feature work", cwd: "/repo/a path", focus: true }],
      ["pane.send_input", {
        pane_id: "pane-uuid",
        text: `'agent' 'a b' 'don'"'"'t'`,
        keys: ["enter"],
      }],
      ["pane.split", {
        target_pane_id: "pane-uuid",
        direction: "right",
        ratio: 0.333,
        cwd: "/repo/a path",
        focus: false,
      }],
    ]);

    assert.equal((await sessions.rename("workspace-uuid", "Renamed")).ok, true);
    assert.equal((await sessions.kill?.("workspace-uuid"))?.ok, true);
    assert.deepEqual(fake.requests.at(-2)?.params, { workspace_id: "workspace-uuid", label: "Renamed" });
    assert.deepEqual(fake.requests.at(-1)?.params, { workspace_id: "workspace-uuid" });
  } finally {
    await fake.close();
  }
});

test("workspace creation refuses inconsistent workspace, tab, and root-pane identities before command delivery", async () => {
  for (const mismatch of ["tab-workspace", "pane-workspace", "pane-tab"] as const) {
    const fake = await fakeHerdrSocket((request, socket) => {
      if (request.method === "workspace.create") {
        reply(socket, request.id, {
          type: "workspace_created",
          workspace: { workspace_id: "new-workspace", label: "work" },
          tab: {
            tab_id: "new-tab",
            workspace_id: mismatch === "tab-workspace" ? "other-workspace" : "new-workspace",
            number: 1,
            label: "main",
          },
          root_pane: {
            pane_id: "new-pane",
            workspace_id: mismatch === "pane-workspace" ? "other-workspace" : "new-workspace",
            tab_id: mismatch === "pane-tab" ? "other-tab" : "new-tab",
          },
        });
      } else {
        reply(socket, request.id, { type: "ok" });
      }
    });
    try {
      const result = await herdrMultiplexer(execStatus(fake.path)).sessions!.spawnDetached({
        name: "work", cwd: "/repo", select: false, argv: ["agent"], sidePane: false,
      });
      assert.equal(result.ok, false, mismatch);
      assert.equal(result.outcomeUnknown, true, mismatch);
      assert.match(result.error ?? "", /invalid response/, mismatch);
      assert.deepEqual(fake.requests.map((request) => request.method), ["workspace.create"], mismatch);
    } finally {
      await fake.close();
    }
  }
});

test("confirmed command refusal rolls back only the created workspace", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    if (request.method === "workspace.create") {
      reply(socket, request.id, {
        type: "workspace_created",
        workspace: { workspace_id: "new-workspace", label: "work" },
        tab: { tab_id: "new-tab", workspace_id: "new-workspace", number: 1, label: "main" },
        root_pane: {
          pane_id: "new-pane",
          workspace_id: "new-workspace",
          tab_id: "new-tab",
          cwd: request.params.cwd,
        },
      });
    } else if (request.method === "pane.send_input") refuse(socket, request.id, "command rejected");
    else reply(socket, request.id, { type: "ok" });
  });
  try {
    const launched = await herdrMultiplexer(execStatus(fake.path)).sessions!.spawnDetached({
      name: "work", cwd: "/repo", select: false, argv: ["agent"], sidePane: false,
    });
    assert.equal(launched.ok, false);
    assert.equal(launched.outcomeUnknown, false);
    assert.deepEqual(fake.requests.map((request) => request.method), [
      "workspace.create", "pane.send_input", "workspace.close",
    ]);
    assert.deepEqual(fake.requests.at(-1)?.params, { workspace_id: "new-workspace" });
  } finally {
    await fake.close();
  }
});

test("uncertain command delivery preserves the created workspace and outcome", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    if (request.method === "workspace.create") {
      reply(socket, request.id, {
        type: "workspace_created",
        workspace: { workspace_id: "new-workspace", label: "work" },
        tab: { tab_id: "new-tab", workspace_id: "new-workspace", number: 1, label: "main" },
        root_pane: {
          pane_id: "new-pane",
          workspace_id: "new-workspace",
          tab_id: "new-tab",
          cwd: request.params.cwd,
        },
      });
    } else socket.write("malformed\n");
  });
  try {
    const launched = await herdrMultiplexer(execStatus(fake.path)).sessions!.spawnDetached({
      name: "work", cwd: "/repo", select: false, argv: ["agent"], sidePane: false,
    });
    assert.equal(launched.ok, false);
    assert.equal(launched.outcomeUnknown, true);
    assert.deepEqual(fake.requests.map((request) => request.method), ["workspace.create", "pane.send_input"]);
  } finally {
    await fake.close();
  }
});

test("default-session selectors are scrubbed from probes, server environment, and full-client attach", () => {
  const base: NodeJS.ProcessEnv = { PATH: "/bin", KEEP: "yes" };
  const dropEnv = executableSpec("herdr").dropEnv;
  for (const key of dropEnv) base[key] = "ambient";
  const clean = herdrEnvironment(base);
  assert.equal(clean.KEEP, "yes");
  for (const key of dropEnv) assert.equal(clean[key], undefined, key);

  const previous = process.env.HERDR_BIN;
  process.env.HERDR_BIN = process.execPath;
  try {
    assert.equal(resolveBin(HERDR_BIN), process.execPath);
    const argv = herdrMultiplexer().sessions!.attachArgv!("ignored-default-session-workspace");
    assert.deepEqual(argv, [
      "/usr/bin/env",
      "-u", "HERDR_SESSION",
      "-u", "HERDR_SOCKET_PATH",
      "-u", "HERDR_WORKSPACE_ID",
      "-u", "HERDR_TAB_ID",
      "-u", "HERDR_PANE_ID",
      process.execPath,
    ]);
    assert.equal(argv.includes("--takeover"), false);
    assert.equal(argv.includes("attach"), false);
  } finally {
    if (previous === undefined) delete process.env.HERDR_BIN;
    else process.env.HERDR_BIN = previous;
  }
});

test("host allowlist gates all operations and leaves an actionable disabled generic target", async () => {
  assert.equal(binUnsupportedReason(HERDR_BIN, "darwin"), null);
  assert.equal(binUnsupportedReason(HERDR_BIN, "linux"), null);
  assert.equal(binUnsupportedReason(HERDR_BIN, "win32"), HERDR_UNSUPPORTED_REASON);
  assert.equal(binUnsupportedReason(HERDR_BIN, "freebsd"), HERDR_UNSUPPORTED_REASON);

  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  let execCalls = 0;
  try {
    const mux = herdrMultiplexer(async () => {
      execCalls += 1;
      throw new Error("unsupported host must not run Herdr");
    });
    assert.deepEqual(await mux.list(), []);
    assert.equal((await mux.write.text({ session: "w", windowIndex: 1, paneId: "p" }, "x")).ok, false);
    assert.equal((await mux.sessions!.spawnDetached({ name: "x", cwd: "/x", select: true, argv: ["sh"], sidePane: false })).ok, false);
    assert.equal(execCalls, 0);

    const deps = fakeTerminals(fakeMultiplexer(), fakeEmulator(), fakeMultiplexer({ id: "cmux" }));
    deps.multiplexers.herdr = mux;
    const views = terminalTargetViews({
      ...deps,
      installed: () => true,
      unsupported: (spec) => binUnsupportedReason(spec, "win32"),
      launchId: () => "test",
    });
    assert.equal(views.find((view) => view.id === "herdr")?.unavailable, HERDR_UNSUPPORTED_REASON);
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
});
