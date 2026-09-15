// Load the BUILT Electron main bundle with Electron and the child process stood in for.
//
// `src/main/index.ts` is the entry point: it reaches for `app` at import time and starts a
// window, a daemon and an updater as a side effect of being loaded, so it cannot be imported
// by a test in-process. Everything it does before that, though - deciding which installed app
// this is and handing the launch over - happens at module scope, which means loading the
// bundle IS the way to observe it.
//
// So this runs as its own process. `electron` is external in the bundle and reached through
// `require`, and `node:child_process` is required as a namespace whose property is read at
// call time, so both can be replaced before the bundle is loaded. Nothing else is faked: the
// identity classification, the receipt read, the executable, the argv and the ordering are all
// the production path.
//
// Observations go to stdout as one JSON line. See `test/main-entry-handover.test.ts`.

const Module = require("node:module");
const childProcess = require("node:child_process");

const observed = { app: [], spawn: [], loadError: null };

/** Stand in for anything a bundled module reaches for, without having to enumerate Electron. */
function stub(name) {
  const callable = function () {
    return proxy;
  };
  callable.displayName = name;
  const proxy = new Proxy(callable, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toPrimitive || property === "toString") return () => name;
      return stub(`${name}.${String(property)}`);
    },
    construct() {
      return proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

const app = {
  setName() {},
  isPackaged: true,
  getAppPath: () => process.env.HARNESS_APP_PATH,
  getVersion: () => "1.2.3",
  requestSingleInstanceLock() {
    observed.app.push("requestSingleInstanceLock");
    return process.env.HARNESS_LOCK !== "0";
  },
  exit(code) {
    observed.app.push(`exit(${code})`);
  },
  quit() {
    observed.app.push("quit");
  },
  on() {},
  // Never resolves, so the window, daemon, Foreman and updater that live inside
  // `app.whenReady().then(...)` are never started by this harness.
  whenReady: () => new Promise(() => {}),
};

const electron = new Proxy(
  { app },
  {
    get(target, property) {
      if (property in target) return target[property];
      return stub(`electron.${String(property)}`);
    },
  },
);

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
  return load.call(this, request, parent, isMain);
};

// Replaced on the namespace object the bundle already holds, so the call site picks this up.
childProcess.spawnSync = (command, args) => {
  observed.spawn.push({ command, args });
  const status = Number(process.env.HARNESS_OPEN_STATUS ?? "0");
  if (process.env.HARNESS_OPEN_ERROR) {
    return { status: null, stderr: "", error: new Error(process.env.HARNESS_OPEN_ERROR) };
  }
  return { status, stderr: process.env.HARNESS_OPEN_STDERR ?? "" };
};

const logged = [];
console.error = (line) => logged.push(String(line));

try {
  require(process.env.HARNESS_MAIN_BUNDLE);
} catch (error) {
  observed.loadError = error instanceof Error ? error.message : String(error);
}

process.stdout.write(`${JSON.stringify({ ...observed, logged })}\n`);
// The bundle registers timers and listeners it never gets to clean up here, and the daemon it
// would have started is deliberately unreachable, so end the process rather than waiting.
process.exit(0);
