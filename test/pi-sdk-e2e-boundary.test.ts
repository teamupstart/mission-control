import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiSdk } from "../src/server/harness/pi/sdk-types.ts";
import type { PiHostUI } from "../src/server/harness/pi/sdk-ui.ts";

// What is at stake: a browser suite that quietly starts spending money, or reading the
// operator's real Pi configuration.
//
// Every other agent in `e2e/` is made free by ONE mechanism - `MISSION_<AGENT>_BIN` points
// at a fake, so no real CLI can start. Pi's managed runtime has no subprocess: its SDK is
// imported into the daemon, so that redirection cannot reach it and a second one
// (`MISSION_PI_SDK_MODULE`) carries the same guarantee. A second mechanism is a second
// thing that can be forgotten, and the way it fails is silent: the daemon would import the
// real `@earendil-works/pi-coding-agent`, resolve the operator's own `~/.pi`, and call a
// provider with their credentials.
//
// So the fixture's own guards are pinned here rather than left as comments in it. This is a
// `node:test` file rather than a spec because it asks questions about the FIXTURE - what it
// refuses, and what the daemon environment always sets - which a spec can only ever
// demonstrate for the one daemon it happened to start.

const FAKE_SDK = new URL("../e2e/fixtures/fake-pi-sdk.mjs", import.meta.url);
const DAEMON_FIXTURE = new URL("../e2e/fixtures/daemon.ts", import.meta.url);

test("unsupported diagnostics do not keep an ordinary fake turn streaming", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-diagnostic-boundary-"));
  try {
    writeFileSync(join(home, "models.json"), "[]");
    await withEnv({ MISSION_HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"),
      MC_E2E_RECORD_DIR: join(home, "records"), MC_E2E_PI_SDK_MODELS: join(home, "models.json") }, async (module) => {
      const sdk = await module.createPiSdk() as unknown as PiSdk;
      const runtime = await sdk.createRuntime({ cwd: home, sessionPath: null, model: null,
        thinkingLevel: null, projectTrust: false, appendSystemPrompt: [], toolEnv: {} });
      const methods: string[] = [];
      let settled = 0;
      runtime.session.subscribe((event) => { if (event.type === "agent_settled") settled += 1; });
      await runtime.session.bindExtensions({ select: async () => undefined, confirm: async () => false,
        input: async () => undefined, editor: async () => undefined, notify() {},
        unsupported(method) { methods.push(method); } });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runtime.session.prompt("PI_UNSUPPORTED", { preflightResult() {} }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("ordinary turn did not settle")), 3_000);
          }),
        ]);
        assert.equal(runtime.session.streaming, false);
        assert.equal(settled, 1);
        assert.deepEqual(methods, ["custom", "setWidget", "setWidget"]);
      } finally {
        clearTimeout(timeout);
        await runtime.dispose();
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const blocked of ["select", "confirm", "input", "editor"] as const) {
  test(`the fake stops its scripted turn after abort during ${blocked}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-abort-boundary-"));
    try {
      writeFileSync(join(home, "models.json"), "[]");
      await withEnv({ MISSION_HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"),
        MC_E2E_RECORD_DIR: join(home, "records"), MC_E2E_PI_SDK_MODELS: join(home, "models.json") }, async (module) => {
        const sdk = await module.createPiSdk() as unknown as PiSdk;
        const runtime = await sdk.createRuntime({ cwd: home, sessionPath: null, model: null,
          thinkingLevel: null, projectTrust: false, appendSystemPrompt: [], toolEnv: {} });
        const calls: string[] = [];
        let release!: () => void;
        let waiting!: () => void;
        const reached = new Promise<void>((resolve) => { waiting = resolve; });
        const ask = async (method: string) => {
          calls.push(method);
          if (method === blocked) {
            waiting();
            await new Promise<void>((resolve) => { release = resolve; });
          }
          return undefined;
        };
        const ui: PiHostUI = { select: () => ask("select"), confirm: async () => {
          await ask("confirm"); return false;
        }, input: () => ask("input"), editor: () => ask("editor"), notify() {}, unsupported() {} };
        await runtime.session.bindExtensions(ui);
        const turn = runtime.session.prompt("PI_QUESTIONS", { preflightResult() {} });
        await reached;
        await runtime.session.abort();
        release();
        await turn;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, ["select", "confirm", "input", "editor"].slice(0, ["select", "confirm", "input", "editor"].indexOf(blocked) + 1));
        assert.equal(readdirSync(join(home, "records", "pi-sdk")).some(name => name.startsWith("answers-")), false);
        await runtime.dispose();
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

/** Load the fixture fresh, with an environment scoped to one case and then restored. */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  body: (module: { createPiSdk(): Promise<Record<string, unknown>> }) => Promise<T>,
): Promise<T> {
  const before = { ...process.env };
  const fetchBefore = globalThis.fetch;
  try {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // A cache-busting query, so each case gets a module that reads the environment it was
    // given rather than the first one this worker happened to set.
    return await body(
      (await import(`${FAKE_SDK.href}?case=${Math.random()}`)) as never,
    );
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, before);
    globalThis.fetch = fetchBefore;
  }
}

test("the fake refuses a Pi agent directory outside the daemon's disposable home", async () => {
  // The guard that stands between a browser spec and the operator's own `~/.pi` - which is
  // where their provider credentials and every real Pi transcript live.
  const home = mkdtempSync(join(tmpdir(), "pi-boundary-"));
  try {
    await withEnv(
      {
        MISSION_HOME: home,
        PI_CODING_AGENT_DIR: join(tmpdir(), "somewhere-else", "agent"),
        MC_E2E_RECORD_DIR: join(home, "records"),
        MC_E2E_PI_SDK_MODELS: join(home, "models.json"),
      },
      async (module) => {
        await assert.rejects(
          () => module.createPiSdk(),
          /outside this daemon's disposable home/,
        );
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the fake refuses to run at all when the daemon did not isolate it", async () => {
  // Absence is a FAILURE rather than a default. A fixture that fell back to `~/.pi` when
  // nobody told it otherwise would be indistinguishable from a working one until the day it
  // mattered.
  for (const missing of ["PI_CODING_AGENT_DIR", "MISSION_HOME"]) {
    const home = mkdtempSync(join(tmpdir(), "pi-boundary-"));
    try {
      await withEnv(
        {
          MISSION_HOME: home,
          PI_CODING_AGENT_DIR: join(home, "pi-agent"),
          MC_E2E_RECORD_DIR: join(home, "records"),
          MC_E2E_PI_SDK_MODELS: join(home, "models.json"),
          [missing]: undefined,
        },
        async (module) => {
          await assert.rejects(() => module.createPiSdk(), new RegExp(`${missing} is not set`));
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a loaded fake makes any network request throw rather than reach a provider", async () => {
  // The backstop for everything the two guards above cannot see. Bedrock is an HTTPS
  // endpoint, and `fetch` is how anything in this process would reach one - so replacing it
  // turns "a browser spec must not spend money" from a property of the fixtures we wrote
  // into a property of the process they run in.
  const home = mkdtempSync(join(tmpdir(), "pi-boundary-"));
  try {
    await withEnv(
      {
        MISSION_HOME: home,
        PI_CODING_AGENT_DIR: join(home, "pi-agent"),
        MC_E2E_RECORD_DIR: join(home, "records"),
        MC_E2E_PI_SDK_MODELS: join(home, "models.json"),
      },
      async (module) => {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, "models.json"), JSON.stringify(["amazon-bedrock/x"]));
        const sdk = await module.createPiSdk();
        assert.equal(typeof sdk.createRuntime, "function");
        assert.throws(
          () => (globalThis.fetch as unknown as () => void)(),
          /attempted a network request/,
        );
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every E2E daemon redirects Pi's SDK and its agent directory, unconditionally", () => {
  // Read off the fixture's own source, because the thing being asserted is that these are
  // in the SHARED environment rather than opt-in per spec. An override a spec has to
  // remember is one a spec can forget, and the forgetting is silent.
  const source = readFileSync(DAEMON_FIXTURE, "utf8");
  // The block bounded by the declaration and the first per-spec branch AFTER it - the
  // fixture also branches on `piOnLoginShellOnly` further up, so the end anchor has to be
  // searched from the start of this block rather than from the top of the file.
  const start = source.indexOf("const isolatedEnv");
  const isolated = source.slice(start, source.indexOf("if (piOnLoginShellOnly)", start));
  assert.ok(isolated.length > 0, "the daemon fixture's shared environment could not be read");
  assert.match(isolated, /MISSION_PI_SDK_MODULE: fakePiSdkModulePath\(\)/);
  // Inside the disposable home, which is what the fake's own guard then checks.
  assert.match(isolated, /PI_CODING_AGENT_DIR: join\(home, "pi-agent"\)/);
  // And the binary redirection is still there for the terminal runtime and the catalog probe.
  assert.match(isolated, /MISSION_PI_BIN: bins\.pi/);
});
