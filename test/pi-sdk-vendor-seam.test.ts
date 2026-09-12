import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one file that touches the REAL `@earendil-works/pi-coding-agent`.
//
// Every other Pi test replaces this module, which is the design - it is what lets the
// adapter's event normalization and turn accounting be driven with no Pi installed. The
// cost of that design is that the projection itself, the part which has to be right about
// the vendor rather than about us, would otherwise be exercised by nothing until a real
// dispatch. A vendor bump that moved `getAgentDir`, renamed a session-manager method or
// changed what `createAgentSessionServices` accepts would compile (the seam is typed
// against the vendor) and then fail on an operator's first managed launch.
//
// So this drives the shipped `defaultPiSdkDeps` against the installed package.
//
// It spends nothing and reads nothing of the operator's. `PI_CODING_AGENT_DIR` points at a
// temp dir, which is the same variable pi's own `getAgentDir()` reads, so every path the
// vendor derives - settings, credentials, the session store - lands inside it. No prompt is
// ever delivered, so no model is called; the one model lookup below asks for an id that
// cannot exist, which fails in the local catalog before any auth or network path is
// reached.

const home = mkdtempSync(join(tmpdir(), "pi-vendor-seam-"));
process.env.HARNESS_HOME = join(home, "state");
const agentDir = join(home, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { defaultPiSdkDeps } = await import("../src/server/harness/pi/sdk-deps.ts");
const { PiSdkError } = await import("../src/server/harness/pi/sdk-errors.ts");
const { piVariables, PI_SESSION_VARIABLES } = await import(
  "../src/server/harness/pi/sdk-deps.ts"
);

test.after(() => rmSync(home, { recursive: true, force: true }));

test("the real Pi loader cannot execute local extension factories before trust allows them", async () => {
  const sdk = await defaultPiSdkDeps.load();
  for (const allow of [false, true]) {
    const cwd = checkout(`factory-${allow}`, true);
    const marker = join(cwd, "factory-ran");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "probe.ts"),
      `import { writeFileSync } from 'node:fs';\nexport default function(pi) { writeFileSync(${JSON.stringify(marker)}, 'loaded'); pi.on('session_start', async (_event, ctx) => { const value = await ctx.ui.input('startup question'); ctx.ui.notify('answered: ' + value); }); }\n`);
    let release!: (allow: boolean) => void;
    let entered!: () => void;
    const decision = new Promise<boolean>((resolve) => { release = resolve; });
    const gated = new Promise<void>((resolve) => { entered = resolve; });
    const creating = sdk.createRuntime({
      cwd, sessionPath: null, model: null, thinkingLevel: null,
      appendSystemPrompt: [], toolEnv: { PATH: process.env.PATH ?? "" },
      projectTrust: () => { entered(); return decision; },
    });
    await gated;
    assert.equal(existsSync(marker), false);
    sdk.setProjectTrust(cwd, allow);
    assert.equal(sdk.projectTrust(cwd), allow);
    release(allow);
    const runtime = await creating;
    try {
      assert.equal(existsSync(marker), allow);
      const { PiUIBridge } = await import("../src/server/harness/pi/sdk-ui.ts");
      let requested = false;
      const ui = new PiUIBridge((event) => {
        if (event.kind === "request") {
          requested = true;
          ui.answer(event.request.id, { kind: "form", answers: [{ question: "startup question", labels: [], text: "safe fixture" }] });
        }
      }, () => {});
      await runtime.session.bindExtensions(ui);
      assert.equal(requested, allow, "the startup handler receives the host UI before it runs");
      ui.close();
    } finally { await runtime.dispose(); }
  }
});

/** A checkout the vendor will accept as a cwd. */
function checkout(name: string, withProjectPi = false): string {
  const cwd = join(home, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "README.md"), "seam\n");
  if (withProjectPi) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
  }
  return cwd;
}

test("the seam loads the pinned package and projects every method the driver calls", async () => {
  const sdk = await defaultPiSdkDeps.load();
  for (const name of [
    "agentDir",
    "hasTrustRequiringProjectResources",
    "projectTrust",
    "findSessionFile",
    "createRuntime",
  ] as const) {
    assert.equal(typeof sdk[name], "function", `the projection is missing ${name}`);
  }
  // Pi's OWN resolution, not ours: `getAgentDir()` reads this variable before falling back
  // to `~/.pi/agent`, which is why a managed session finds the credential an operator
  // created with `/login` rather than one in a disposable home.
  assert.equal(sdk.agentDir(), agentDir);
});

test("project trust is read from Pi's own store, and undecided reads as undecided", async () => {
  const sdk = await defaultPiSdkDeps.load();
  const plain = checkout("plain");
  const gated = checkout("gated", true);

  // The question the driver asks before it decides what to load. A checkout with nothing
  // project-local needs no decision at all; one with `.pi` does.
  assert.equal(sdk.hasTrustRequiringProjectResources(plain), false);
  assert.equal(sdk.hasTrustRequiringProjectResources(gated), true);

  // Nobody has decided, and the driver must read that as undecided rather than as trust.
  assert.equal(sdk.projectTrust(gated), null);
});

test("an unknown session id resolves to nothing rather than to a look-alike", async () => {
  const sdk = await defaultPiSdkDeps.load();
  const cwd = checkout("resume-lookup");
  assert.equal(
    await sdk.findSessionFile(cwd, "00000000-0000-4000-8000-000000000000"),
    null,
  );
});

test("a real runtime is built, writes Pi's own session file, and disposes", async () => {
  // The whole construction path: services, the resource loader with project trust withheld,
  // a durable `SessionManager`, and `AgentSessionRuntime`. No model is selected, so Pi
  // follows its own configured default and nothing is ever prompted.
  const sdk = await defaultPiSdkDeps.load();
  const cwd = checkout("live-runtime");
  const runtime = await sdk.createRuntime({
    cwd,
    sessionPath: null,
    model: null,
    thinkingLevel: null,
    projectTrust: false,
    appendSystemPrompt: ["a standing instruction"],
    toolEnv: { PATH: process.env.PATH ?? "" },
  });
  try {
    const session = runtime.session;
    assert.match(session.sessionId, /^[0-9a-f-]{36}$/, session.sessionId);
    // Pi's own session store, under the agent dir above - the same file `pi --session <id>`
    // reopens and `piTranscript` reads back.
    assert.ok(session.sessionFile?.startsWith(join(agentDir, "sessions")), session.sessionFile ?? "");
    assert.ok(session.sessionFile?.endsWith(`_${session.sessionId}.jsonl`));
    assert.equal(session.idle, true);
    assert.equal(session.streaming, false);

    // The subscription the adapter attaches before turn one, and its release.
    let seen = 0;
    const unsubscribe = session.subscribe(() => (seen += 1));
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
    assert.equal(seen, 0);

    // Session-local thinking, applied through the vendor rather than recorded by us.
    session.setThinkingLevel("low");

    // And a fact about pi worth pinning, because two of our readers degrade on it: a new
    // session lives in MEMORY until its first record, so the file it names does not exist
    // yet and the lookup a restart uses cannot find it. That is why `piTranscript.locate`
    // returns null for a session that has not spoken, and why the driver reports the path
    // from the vendor rather than by searching for it.
    assert.equal(await sdk.findSessionFile(cwd, session.sessionId), null);
  } finally {
    await runtime.dispose();
  }
});

test("a model Pi does not offer is refused by the seam, before anything is created", async () => {
  // Fails in Pi's LOCAL catalog, so this reaches no auth path and no network. The refusal is
  // the contract `SdkSpec.launch` states: reject rather than fall back to a model nobody
  // chose, which on a paid provider is also a bill nobody agreed to.
  const sdk = await defaultPiSdkDeps.load();
  const cwd = checkout("unknown-model");
  await assert.rejects(
    () =>
      sdk.createRuntime({
        cwd,
        sessionPath: null,
        model: { provider: "amazon-bedrock", id: "no.such-model-v9:0" },
        thinkingLevel: null,
        projectTrust: false,
        appendSystemPrompt: [],
        toolEnv: {},
      }),
    (error: InstanceType<typeof PiSdkError>) => {
      assert.equal(error.kind, "model-unavailable");
      assert.match(error.message, /amazon-bedrock\/no\.such-model-v9:0/);
      return true;
    },
  );
});

test("reopening a stored conversation takes the exact file, and a missing one refuses", async () => {
  const sdk = await defaultPiSdkDeps.load();
  const cwd = checkout("reopen");

  // A conversation that has actually been written, because that is the only kind a restart
  // ever reopens - pi holds a new session in memory until its first record (above). Written
  // in pi's own on-disk shape rather than by driving a turn, which would need a model.
  const id = "01a08dd0-cbbe-7154-aced-c43cef5aba4b";
  const stamp = "2026-09-11T00-00-00-000Z";
  const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stamp}_${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-11T00:00:00.000Z", cwd })}\n`,
  );

  // The lookup a restart uses finds it by exact id, which is what the driver resolves before
  // it asks for a runtime at all.
  assert.equal(await sdk.findSessionFile(cwd, id), path);

  const reopened = await sdk.createRuntime({
    cwd,
    sessionPath: path,
    model: null,
    thinkingLevel: null,
    projectTrust: false,
    appendSystemPrompt: [],
    toolEnv: {},
  });
  try {
    assert.equal(reopened.session.sessionId, id, "a resume must continue, not look alike");
    assert.equal(reopened.session.sessionFile, path);
  } finally {
    await reopened.dispose();
  }

  await assert.rejects(
    () =>
      sdk.createRuntime({
        cwd,
        sessionPath: join(cwd, "definitely-not-a-session.jsonl"),
        model: null,
        thinkingLevel: null,
        projectTrust: false,
        appendSystemPrompt: [],
        toolEnv: {},
      }),
    (error: InstanceType<typeof PiSdkError>) => {
      assert.equal(error.kind, "resume-unavailable");
      return true;
    },
  );
});

test("the module override is honoured, and a module without the factory is refused", async () => {
  // `MISSION_PI_SDK_MODULE` is the redirection the browser suite points at its fake, and it
  // is the one production seam with no subprocess behind it - so its failure modes are
  // pinned here rather than only exercised by that suite.
  const good = join(home, "fake-sdk.mjs");
  writeFileSync(good, "export const createPiSdk = () => ({ agentDir: () => '/injected' });\n");
  const bad = join(home, "no-factory.mjs");
  writeFileSync(bad, "export const somethingElse = 1;\n");
  const before = process.env.MISSION_PI_SDK_MODULE;
  try {
    process.env.MISSION_PI_SDK_MODULE = good;
    assert.equal((await defaultPiSdkDeps.load()).agentDir(), "/injected");

    process.env.MISSION_PI_SDK_MODULE = bad;
    await assert.rejects(() => defaultPiSdkDeps.load(), /exports no createPiSdk/);

    process.env.MISSION_PI_SDK_MODULE = join(home, "does-not-exist.mjs");
    await assert.rejects(() => defaultPiSdkDeps.load(), /could not be loaded/);
  } finally {
    if (before === undefined) delete process.env.MISSION_PI_SDK_MODULE;
    else process.env.MISSION_PI_SDK_MODULE = before;
  }
});

/** Pi's tool `execute` demands its live extension context; this seam has no session. */
type BashExecute = (id: string, params: { command: string }) => Promise<unknown>;

test("the bash tool's environment admits Pi's five session variables and nothing else", async () => {
  // The isolation boundary, driven through the REAL bash tool rather than asserted about it.
  //
  // Pi builds the tool's environment from `getShellEnv()`, which is the DAEMON's whole
  // `process.env`. The driver replaces that wholesale with `sdkSubprocessEnv` and then
  // carries Pi's own session variables back across. If that carry-back were a `PI_` prefix
  // match, every `PI_*` the operator had exported to the daemon would ride back in with
  // them - so this sets a decoy and proves it does not.
  const pi = await import("@earendil-works/pi-coding-agent");
  const cwd = checkout("bash-env");
  const decoy = "PI_NOT_A_SESSION_VARIABLE";
  process.env[decoy] = "must-not-reach-the-agent";
  process.env.PI_SESSION_ID = "daemon-value-that-pi-replaces";
  try {
    let captured: NodeJS.ProcessEnv | null = null;
    const isolated = { PATH: process.env.PATH ?? "", MISSION_ISOLATED: "yes" };
    const tool = pi.createBashToolDefinition(cwd, {
      spawnHook: (context) => {
        // Exactly what `createRuntime` installs, including the helper under test.
        const env = { ...isolated, ...piVariables(context.env) };
        captured = env;
        return { ...context, env };
      },
    });

    // `ctx` is Pi's live extension context, which a seam test has no session for. Pi reads it
    // only to repopulate its own session variables, and reaching the hook is what this test
    // is about - so it is passed as undefined through the same single cast the adapter uses
    // for this vendor's tool types.
    await (tool.execute as unknown as BashExecute)("call-1", { command: "true" });
    assert.ok(captured, "Pi never invoked the spawn hook, so the driver never got its say");

    const env = captured as NodeJS.ProcessEnv;
    assert.equal(env.MISSION_ISOLATED, "yes", "the isolated environment survived");
    assert.equal(env[decoy], undefined, "an unrelated PI_* variable reached the agent's shell");
    // Every name that DID cross is one Pi itself owns.
    const crossed = Object.keys(env).filter((name) => name.startsWith("PI_"));
    for (const name of crossed) {
      assert.ok(
        PI_SESSION_VARIABLES.includes(name as (typeof PI_SESSION_VARIABLES)[number]),
        `${name} crossed the boundary but is not one of Pi's session variables`,
      );
    }
  } finally {
    delete process.env[decoy];
    delete process.env.PI_SESSION_ID;
  }
});
