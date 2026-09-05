import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrClient,
  HERDR_MIN_VERSION,
  HERDR_PROTOCOL,
} from "../src/server/terminal/herdr-client.ts";
import { HERDR_BIN } from "../src/server/terminal/herdr.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";
import type { RunResult } from "../src/server/util/exec.ts";
import { fakeHerdrSocket, refuse, reply } from "./helpers/herdr-socket.ts";

function run(stdout: string, code = 0, outcomeUnknown = false): RunResult {
  return { stdout, stderr: "", code, outcomeUnknown, overflowed: false };
}

function status(socket: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "running",
    running: true,
    version: HERDR_MIN_VERSION,
    protocol: HERDR_PROTOCOL,
    capabilities: {},
    compatible: true,
    socket,
    session: null,
    restart_needed: false,
    ...over,
  });
}

function execStatus(socket: string, calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []): TerminalExec {
  return async (_bin, args, opts) => {
    calls.push({ args, env: opts?.env });
    return run(status(socket));
  };
}

const SNAPSHOT = {
  type: "session_snapshot",
  snapshot: {
    version: HERDR_MIN_VERSION,
    protocol: HERDR_PROTOCOL,
    workspaces: [{ workspace_id: "w1", label: "api" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", foreground_cwd: null },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", foreground_cwd: "/repo/src" },
    ],
  },
};

test("snapshot and pane process info use stable one-request connections and correlate out-of-order responses", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    if (request.method === "session.snapshot") {
      const line = `${JSON.stringify({ id: request.id, result: SNAPSHOT })}\n`;
      socket.write(line.slice(0, 17));
      socket.write(line.slice(17));
      return;
    }
    const item = { id: request.id, pane: String(request.params.pane_id) };
    setTimeout(() => {
      reply(socket, item.id, {
        type: "pane_process_info",
        process_info: { pane_id: item.pane, shell_pid: item.pane.endsWith("2") ? 202 : 101, tty: null },
      });
    }, item.pane.endsWith("1") ? 10 : 0);
  });
  try {
    const client = createHerdrClient(execStatus(fake.path), HERDR_BIN);
    const result = await client.snapshotWithProcesses();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.processes.get("w1:p1")?.shell_pid, 101);
    assert.equal(result.value.processes.get("w1:p2")?.shell_pid, 202);
    assert.equal(fake.connectionCount, 3);
    assert.deepEqual(fake.requests.map((request) => request.method), [
      "session.snapshot",
      "pane.process_info",
      "pane.process_info",
    ]);
  } finally {
    await fake.close();
  }
});

test("application refusals are confirmed while malformed post-write mutation responses are unknown", async () => {
  let mode: "refuse" | "malformed" = "refuse";
  const fake = await fakeHerdrSocket((request, socket) => {
    if (mode === "refuse") refuse(socket, request.id, "pane is not writable");
    else socket.write("not-json\n");
  });
  try {
    const client = createHerdrClient(execStatus(fake.path), HERDR_BIN);
    assert.deepEqual(await client.sendText("w1:p1", "hello"), {
      ok: false,
      error: "Herdr text write to w1:p1 was refused: pane is not writable",
      outcomeUnknown: false,
    });
    mode = "malformed";
    const malformed = await client.sendText("w1:p1", "hello");
    assert.equal(malformed.ok, false);
    assert.equal(malformed.outcomeUnknown, true);
    assert.match(malformed.error ?? "", /malformed JSON/);
  } finally {
    await fake.close();
  }
});

test("agent focus rejects a successful response for a different pane", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    reply(socket, request.id, {
      type: "agent_info",
      agent: { pane_id: "w1:p2" },
    });
  });
  try {
    const result = await createHerdrClient(execStatus(fake.path), HERDR_BIN).focusAgent("w1:p1");
    assert.equal(result.ok, false);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /invalid response/);
  } finally {
    await fake.close();
  }
});

test("duplicate, unknown, and schema-mismatched response ids terminally fail a written mutation", async () => {
  for (const kind of ["duplicate", "unknown", "schema"] as const) {
    const fake = await fakeHerdrSocket((request, socket) => {
      if (kind === "duplicate") {
        socket.write(
          `${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n` +
          `${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`,
        );
      } else if (kind === "unknown") {
        reply(socket, "somebody-elses-id", { type: "ok" });
      } else {
        reply(socket, request.id, { type: "pane_read", read: { pane_id: "w1:p1", text: "wrong" } });
      }
    });
    try {
      const result = await createHerdrClient(execStatus(fake.path), HERDR_BIN).sendText("w1:p1", "x");
      assert.equal(result.ok, false, kind);
      assert.equal(result.outcomeUnknown, true, kind);
    } finally {
      await fake.close();
    }
  }
});

test("a non-responsive socket settles at the deadline and a pre-connect failure is known not delivered", async () => {
  const fake = await fakeHerdrSocket(() => {});
  try {
    const client = createHerdrClient(execStatus(fake.path), HERDR_BIN, {
      actionTimeoutMs: 25,
      readTimeoutMs: 25,
    });
    const timeout = await client.sendText("w1:p1", "hello");
    assert.equal(timeout.ok, false);
    assert.equal(timeout.outcomeUnknown, true);
    assert.match(timeout.error ?? "", /timed out/);
  } finally {
    await fake.close();
  }

  const missing = createHerdrClient(execStatus("/definitely/not/a/socket"), HERDR_BIN, {
    actionTimeoutMs: 50,
  });
  const refused = await missing.sendText("w1:p1", "hello");
  assert.equal(refused.ok, false);
  assert.equal(refused.outcomeUnknown, false);
  assert.match(refused.error ?? "", /could not connect/);
});

test("an unterminated final line fails reads without leaking a partial result", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    socket.end(JSON.stringify({ id: request.id, result: { type: "pane_read" } }));
  });
  try {
    const result = await createHerdrClient(execStatus(fake.path), HERDR_BIN).read("w1:p1");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.outcomeUnknown, false);
    assert.match(result.error, /truncated response/);
  } finally {
    await fake.close();
  }
});

test("UTF-8 response characters may cross socket chunks", async () => {
  const fake = await fakeHerdrSocket((request, socket) => {
    const response = Buffer.from(`${JSON.stringify({
      id: request.id,
      result: { type: "pane_read", read: { pane_id: "w1:p1", text: "ready 🐑" } },
    })}\n`);
    const sheep = response.indexOf(Buffer.from("🐑"));
    socket.write(response.subarray(0, sheep + 2));
    socket.write(response.subarray(sheep + 2));
  });
  try {
    const result = await createHerdrClient(execStatus(fake.path), HERDR_BIN).read("w1:p1");
    assert.deepEqual(result, { ok: true, value: "ready 🐑", outcomeUnknown: false });
  } finally {
    await fake.close();
  }
});

test("creation readiness alone starts a stopped server and polls until compatible", async () => {
  const calls: string[][] = [];
  let probes = 0;
  const exec: TerminalExec = async (_bin, args) => {
    calls.push(args);
    probes += 1;
    return run(probes < 3
      ? status("/tmp/herdr.sock", { status: "not_running", running: false, version: null, protocol: null, compatible: null })
      : status("/tmp/herdr.sock"));
  };
  let spawned = 0;
  let spawnErrorHandled = false;
  let clock = 0;
  const original = new Map<string, string | undefined>();
  for (const key of HERDR_BIN.dropEnv) {
    original.set(key, process.env[key]);
    process.env[key] = `ambient-${key}`;
  }
  try {
    const client = createHerdrClient(exec, HERDR_BIN, {
      spawnDetached: (_bin, args, options) => {
        spawned += 1;
        assert.deepEqual(args, ["server"]);
        assert.equal(options.detached, true);
        assert.equal(options.stdio, "ignore");
        for (const key of HERDR_BIN.dropEnv) assert.equal(options.env?.[key], undefined, key);
        return {
          on(event) {
            assert.equal(event, "error");
            spawnErrorHandled = true;
          },
          unref() {},
        };
      },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      actionTimeoutMs: 500,
      readyPollMs: 10,
    });
    const ready = await client.ensureReady();
    assert.deepEqual(ready, { ok: true, value: "/tmp/herdr.sock", outcomeUnknown: false });
    assert.equal(spawned, 1);
    assert.equal(spawnErrorHandled, true);
    assert.equal(calls.length, 3);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("creation readiness retries a transient initial status failure before starting the server", async () => {
  let probes = 0;
  const exec: TerminalExec = async () => {
    probes += 1;
    if (probes === 1) return run("", 1, true);
    return run(probes === 2
      ? status("/tmp/herdr.sock", { status: "not_running", running: false, version: null, protocol: null, compatible: null })
      : status("/tmp/herdr.sock"));
  };
  let spawned = 0;
  let clock = 0;
  const client = createHerdrClient(exec, HERDR_BIN, {
    spawnDetached: () => {
      assert.equal(probes, 2, "server startup waits for a confirmed stopped status");
      spawned += 1;
      return { unref() {} };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    actionTimeoutMs: 500,
    readyPollMs: 10,
  });

  assert.deepEqual(await client.ensureReady(), {
    ok: true,
    value: "/tmp/herdr.sock",
    outcomeUnknown: false,
  });
  assert.equal(probes, 3);
  assert.equal(spawned, 1);
});

test("creation readiness bounds persistent status failures and returns retry guidance", async () => {
  let probes = 0;
  const timeouts: number[] = [];
  const exec: TerminalExec = async (_bin, _args, options) => {
    probes += 1;
    timeouts.push(options?.timeoutMs ?? 0);
    return run("", 1, true);
  };
  let spawned = 0;
  let clock = 0;
  const client = createHerdrClient(exec, HERDR_BIN, {
    spawnDetached: () => {
      spawned += 1;
      return { unref() {} };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    actionTimeoutMs: 25,
    readyPollMs: 10,
  });

  const result = await client.ensureReady();
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Herdr server status did not finish/);
  assert.match(result.error ?? "", /Start Herdr or restart its server, then try again/);
  assert.equal(probes, 3);
  assert.equal(spawned, 0);
  assert.equal(clock, 25);
  assert.deepEqual(timeouts, [25, 15, 5]);
});

test("only strict stable Herdr versions are compatible", async () => {
  for (const version of [`${HERDR_MIN_VERSION}-beta.1`, `${HERDR_MIN_VERSION}+local`, "00.8.2"]) {
    const client = createHerdrClient(async () => run(status("/tmp/herdr.sock", { version })), HERDR_BIN);
    const result = await client.probe();
    assert.equal(result.state, "failed", version);
    assert.match(result.state === "failed" ? result.error : "", /incompatible/, version);
  }
});

test("pane_not_found is a per-pane process miss while other process refusals remain failures", async () => {
  for (const code of ["pane_not_found", "permission_denied"] as const) {
    const fake = await fakeHerdrSocket((request, socket) => {
      if (request.method === "session.snapshot") {
        reply(socket, request.id, SNAPSHOT);
      } else if (request.params.pane_id === "w1:p1") {
        socket.write(`${JSON.stringify({ id: request.id, error: { code, message: code } })}\n`);
      } else {
        reply(socket, request.id, {
          type: "pane_process_info",
          process_info: { pane_id: request.params.pane_id, shell_pid: 202, tty: null },
        });
      }
    });
    try {
      const result = await createHerdrClient(execStatus(fake.path), HERDR_BIN).snapshotWithProcesses();
      if (code === "pane_not_found") {
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.processes.get("w1:p1"), null);
          assert.equal(result.value.processes.get("w1:p2")?.shell_pid, 202);
        }
      } else {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, code);
      }
    } finally {
      await fake.close();
    }
  }
});

test("passive operations never start a stopped or incompatible Herdr server", async () => {
  for (const incompatible of [false, true]) {
    let spawned = 0;
    let connected = 0;
    const exec: TerminalExec = async () => run(status("/tmp/no.sock", incompatible
      ? { compatible: false }
      : { status: "not_running", running: false, version: null, protocol: null, compatible: null }));
    const client = createHerdrClient(exec, HERDR_BIN, {
      connect: () => { connected += 1; throw new Error("must not connect"); },
      spawnDetached: () => { spawned += 1; return { unref() {} }; },
    });
    const result = await client.snapshotWithProcesses();
    assert.equal(result.ok, false);
    assert.equal(spawned, 0);
    assert.equal(connected, 0);
  }
});

test("every status probe drops all default-session selectors", async () => {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const original = new Map<string, string | undefined>();
  for (const key of HERDR_BIN.dropEnv) {
    original.set(key, process.env[key]);
    process.env[key] = `ambient-${key}`;
  }
  try {
    await createHerdrClient(execStatus("/tmp/no.sock", calls), HERDR_BIN).probe();
    assert.equal(calls.length, 1);
    for (const key of HERDR_BIN.dropEnv) assert.equal(calls[0]!.env?.[key], undefined, key);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
