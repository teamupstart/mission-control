// Load the BUILT Electron main bundle with Electron and the child process stood in for.
//
// `src/main/index.ts` is the entry point: it reaches for `app` at import time and starts a
// window, a daemon and an updater after Electron readiness, so it cannot be imported by a test
// in-process. Load the bundle and signal readiness to observe the real migration gate and
// hand-over. Deny the single-instance lock by default to stop before any runtime can start.
//
// So this runs as its own process. `electron` is external in the bundle and reached through
// `require`, and `node:child_process` is required as a namespace whose property is read at
// call time, so both can be replaced before the bundle is loaded. Apart from native inventory, the
// identity classification, the receipt read, the executable, the argv and the ordering are all
// the production path.
// The launch-registration mode permits startup with a simulated macOS inventory
// and window, observing the real durable log, startup page and dialog delivery.
//
// Observations go to stdout as one JSON line. See `test/main-entry-handover.test.ts`.

const Module = require("node:module");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { resolve } = require("node:path");

const launchRegistration = process.env.HARNESS_LAUNCH_REGISTRATION;
const observed = { app: [], spawn: [], inspection: [], pages: [], dialogs: [], signals: [], loadError: null };
const deadline = setTimeout(() => {
  process.stderr.write("The entry point did not finish its startup decision.\n");
  process.exit(1);
}, 5000);
let finishing = false;
function finish() {
  if (finishing) return;
  finishing = true;
  // An exit may be followed by quit in the same decision. Capture both before reporting.
  setImmediate(() => {
    clearTimeout(deadline);
    process.stdout.write(`${JSON.stringify({ ...observed, logged })}\n`);
    process.exit(0);
  });
}

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
    return process.env.HARNESS_BACKGROUND_FAILURE === "1" || !!launchRegistration;
  },
  getLoginItemSettings: () => ({openAtLogin: false}),
  exit(code) {
    observed.app.push(`exit(${code})`);
    finish();
  },
  quit() {
    observed.app.push("quit");
    finish();
  },
  on() {},
  // Startup first awaits the migration gate inside this callback. The denied lock above
  // prevents the window, daemon, Foreman and updater from starting after that decision.
  whenReady: () => Promise.resolve(),
};

const electron = new Proxy(
  { app, dialog: {showErrorBox(title) { observed.app.push(`showErrorBox(${title})`); finish(); }} },
  {
    get(target, property) {
      if (property in target) return target[property];
      return stub(`electron.${String(property)}`);
    },
  },
);

if (launchRegistration) {
  // Reach the real packaged macOS startup branch on every test host. Only the OS
  // inventory and Electron boundary are simulated; detection, logging, startup
  // page construction and dialog routing all remain in the production bundle.
  Object.defineProperty(process, "platform", {value: "darwin"});
  process.getuid = () => 501;
  process.kill = (pid, signal) => { observed.signals.push({pid, signal}); return true; };
  const bundle = resolve(process.env.HARNESS_APP_PATH, "../../..");
  const binary = `${bundle}/Contents/MacOS/Mission Control`;
  childProcess.execFile = (command, args, _options, callback) => {
    observed.inspection.push({command, args});
    let stdout;
    if (command === "/usr/bin/lsappinfo") stdout = launchRegistration === "foreground"
      ? `1) "Mission Control" ASN:0x0-0x123:\n bundleID="com.mission-control.app"\n bundle path="${bundle}"\n pid = ${process.pid} type="Foreground"\n` : "";
    else if (command === "/bin/ps") stdout = `${process.pid} 1 S ${binary}\n`;
    else if (command === "/bin/launchctl" && args[0] === "list") stdout = "PID\tStatus\tLabel\n-\t0\tcom.fixture.startup-respawner\n";
    else if (command === "/bin/launchctl" && args[0] === "print") stdout = `program = ${binary}\n`;
    else throw new Error(`Unexpected startup subprocess: ${command}`);
    callback(null, stdout);
  };
  // The existing development-server ownership seam prevents any real daemon or
  // Foreman spawn. No network or login shell can escape this fixture either.
  process.env.MISSION_DEV_SERVER_URL = "http://127.0.0.1:1";
  childProcess.spawn = () => { throw new Error("fixture subprocess unavailable"); };
  global.fetch = () => new Promise(() => {});
  const ipc = new EventEmitter();
  ipc.handle = () => {};
  electron.ipcMain = ipc;
  electron.screen = {getPrimaryDisplay: () => ({workAreaSize: {width: 1400, height: 860}})};
  electron.BrowserWindow = class extends EventEmitter {
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false, isLoading: () => false,
        setWindowOpenHandler() {}, stop() {}, executeJavaScript: async () => true,
        send(channel, content) {
          if (channel === "mission:update-dialog") observed.dialogs.push(content);
        },
      });
      setImmediate(() => {
        ipc.emit("mission:update-dialog-ready", {sender: this.webContents});
        // Drain the presenter's host wait before collecting both positive and
        // negative results. Completion does not depend on a warning existing.
        setImmediate(finish);
      });
    }
    isDestroyed() { return false; }
    isVisible() { return true; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    async loadURL(url) {
      if (url.startsWith("data:text/html")) observed.pages.push(decodeURIComponent(url.slice(url.indexOf(",") + 1)));
    }
  };
}

// These fixtures run from persistent copies. Keep mount inventory at the native
// subprocess boundary so the real location policy runs on Linux and macOS alike.
childProcess.execFileSync = (command, args) => {
  observed.inspection.push({command, args});
  if (command === "/usr/bin/hdiutil") return "fixture image inventory";
  if (command === "/usr/bin/plutil") return JSON.stringify({images: []});
  throw new Error(`Unexpected startup subprocess: ${command}`);
};

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

if (process.env.HARNESS_BACKGROUND_FAILURE === "1") {
  // No shell or network may escape this startup fixture. The locator falls back,
  // then the real daemon supervisor refuses this old daemon's health response.
  childProcess.spawn = () => { throw new Error("fixture login shell unavailable"); };
  global.fetch = async () => Response.json({service: "mission-control", capabilities: []});
}

const logged = [];
console.error = (line) => logged.push(String(line));

try {
  require(process.env.HARNESS_MAIN_BUNDLE);
} catch (error) {
  observed.loadError = error instanceof Error ? error.message : String(error);
  finish();
}
