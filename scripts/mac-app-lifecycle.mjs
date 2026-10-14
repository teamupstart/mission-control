// Shared by Electron and its detached updater. OS reads are bounded, read-only and
// fail closed. Never print launchd environments or process command lines.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processIdentity } from "./update-lock.mjs";

export const APP_ID = "com.mission-control.app";
export const LAUNCH_TIMEOUT_MS = 25_000;
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const POLL_MS = 250;
export const launchAckPath = (directory, nonce) => join(directory, `update-launch-${nonce}.json`);

export function realMacAppOps(directory) {
  return {
    uid: process.getuid(), now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: (command, args, timeout = 2000) => new Promise((resolve, reject) => {
      execFile(command, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error && (typeof error.code !== "number" || error.killed)) {
          reject(new Error("Could not inspect macOS launch state within the time limit."));
        } else resolve({code: error?.code ?? 0, stdout});
      });
    }),
    identity: processIdentity,
    kill: (pid, signal) => process.kill(pid, signal),
    readAck: (nonce) => {
      try { return JSON.parse(readFileSync(launchAckPath(directory, nonce), "utf8")); }
      catch { return null; }
    },
  };
}

async function read(ops, command, args, timeout) {
  const result = await ops.run(command, args, timeout);
  if (result.code !== 0) throw new Error("Could not inspect macOS launch state. Check launchctl and lsappinfo before retrying.");
  return result.stdout;
}

export function parseAppProcesses(output) {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return match ? [{pid: Number(match[1]), ppid: Number(match[2]), state: match[3], executable: match[4]}] : [];
  });
}

export function parseLaunchServices(output) {
  return output.split(/(?=^\s*\d+\) )/m).flatMap((block) => {
    const bundle = /^\s*bundle path="(.*)"\s*$/m.exec(block)?.[1];
    const id = /^\s*bundleID="(.*)"\s*$/m.exec(block)?.[1];
    const pid = /\bpid = (\d+)/.exec(block)?.[1];
    const type = /\btype="([^"]+)"/.exec(block)?.[1];
    return bundle && pid ? [{bundle, id, pid: Number(pid), type}] : [];
  });
}

function canonical(path) {
  try { return realpathSync(path); } catch { return path; }
}
function inBundle(executable, bundle) {
  return canonical(executable).startsWith(`${canonical(bundle)}/Contents/`);
}
function isMain(executable, bundle) {
  return canonical(executable).startsWith(`${canonical(bundle)}/Contents/MacOS/`);
}
const apps = async (ops, timeout) => parseLaunchServices(await read(ops, "/usr/bin/lsappinfo", ["list"], timeout));
const processes = async (ops, timeout) => {
  const rows = parseAppProcesses(await read(ops, "/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,comm="], timeout));
  if (!rows.length) throw new Error("Could not inspect macOS bundle processes.");
  return rows;
};
const registered = (rows, bundle, pid) => rows.some((row) => row.id === APP_ID && canonical(row.bundle) === canonical(bundle) && row.pid === pid && row.type === "Foreground");

/** Read shell words and mark expansion, without evaluating it or reading environment values. */
function literalShellWords(command) {
  const words = [];
  let word = "", quote = "", expanded = false;
  const finish = () => {
    if (word) words.push({value: word, expanded, operator: false});
    word = "";
    expanded = false;
  };
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      const next = command[index + 1];
      // Inside double quotes, backslash only escapes these shell characters.
      if (next !== undefined && (!quote || /[$`"\\\n]/.test(next))) {
        if (next !== "\n") word += next;
        index++;
      } else word += character;
    } else if (quote) {
      if (character === quote) quote = "";
      else {
        if (quote !== "'" && /[$`]/.test(character)) expanded = true;
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && !word) {
      while (index < command.length && command[index] !== "\n") index++;
    } else if (/[\s;|&()<>]/.test(character)) {
      finish();
      let operator = character;
      if ((character === "<" || character === ">") && [character, "&"].includes(command[index + 1])) operator += command[++index];
      if (character === "\n" || !/\s/.test(character)) words.push({value: operator, expanded: false, operator: true});
    } else {
      if (/[$`]/.test(character)) expanded = true;
      word += character;
    }
  }
  finish();
  return words;
}

// launchctl prints one argument per line. Decode executable paths separately from
// shell source, whose quoting must survive until literalShellWords reads it.
const printedPath = (value) => value.replace(/\\([\\ "'])/g, "$1").replace(/^(["'])(.*)\1$/, "$2");

/** Inspect open's launch targets, excluding app argv, I/O paths and shell redirections. */
function openLaunchesBundle(words, bundle, shell) {
  const args = [];
  let redirect = false;
  for (const [index, word] of words.entries()) {
    if (word.operator) {
      if (!/^[<>]/.test(word.value)) break;
      redirect = true;
    } else if (redirect) redirect = false;
    else if (!(/^\d+$/.test(word.value) && words[index + 1]?.operator && /^[<>]/.test(words[index + 1].value))) {
      args.push({...word, value: shell ? word.value : printedPath(word.value)});
    }
  }
  const matchesBundle = (word) => {
    if (word.expanded) return true; // An unresolved launch target cannot be declared safe.
    let path = word.value;
    if (/^file:/i.test(path)) {
      try { path = fileURLToPath(path); } catch { return false; }
    }
    return canonical(path) === canonical(bundle);
  };
  const appName = basename(bundle).replace(/\.app$/i, "").toLowerCase();
  const applications = [];
  let target = false, reveal = false, editor = false, options = true;
  const select = (flag, word) => {
    if (!word) return;
    applications.push(word.expanded || (flag === "b" ? word.value === APP_ID
      : matchesBundle(word) || (!word.value.includes("/") && word.value.replace(/\.app$/i, "").toLowerCase() === appName)));
  };
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (options && word.value === "--args") break;
    if (options && word.value === "--") { options = false; continue; }
    if (options && ["--env", "--stdin", "--stdout", "--stderr", "--arch"].includes(word.value)) { index++; continue; }
    if (options && word.value.startsWith("-")) {
      if (word.value.startsWith("--")) continue;
      for (let offset = 1; offset < word.value.length; offset++) {
        const flag = word.value[offset];
        if (flag === "R") reveal = true;
        if ("etfh".includes(flag)) editor = true;
        if ("abs".includes(flag)) {
          const value = word.value.slice(offset + 1);
          const argument = value ? {...word, value} : args[++index];
          if (flag !== "s") select(flag, argument);
          break;
        }
      }
      continue;
    }
    target ||= matchesBundle(word);
  }
  // An explicitly selected application receives file operands as data. -R only reveals them.
  return !reveal && (applications.length ? applications.some(Boolean) : !editor && target);
}

function commandLaunchesBundle(words, bundle, shell = false) {
  let executable = true, wrapper = "", optionValue = false, redirect = false;
  for (const [index, word] of words.entries()) {
    if (word.operator) {
      if (/^[<>]/.test(word.value)) redirect = true;
      else { executable = true; wrapper = ""; optionValue = false; }
      continue;
    }
    if (redirect) { redirect = false; continue; }
    if (optionValue) { optionValue = false; continue; }
    if (/^\d+$/.test(word.value) && words[index + 1]?.operator && /^[<>]/.test(words[index + 1].value)) continue;
    if (!executable || /^[A-Za-z_]\w*=/.test(word.value)) continue;
    if (word.expanded) return true;
    if (["!", "if", "then", "else", "elif", "do", "while", "until", "{"].includes(word.value)) continue;
    const path = shell ? word.value : printedPath(word.value);
    const name = path.split("/").at(-1);
    if (["exec", "env", "command", "nohup", "nice", "arch"].includes(name) || (shell && path === "builtin")) { wrapper = name; continue; }
    if (wrapper && word.value.startsWith("-")) {
      optionValue = (wrapper === "exec" && word.value === "-a")
        || (wrapper === "env" && ["-u", "--unset", "-C", "--chdir"].includes(word.value))
        || (wrapper === "nice" && word.value === "-n")
        || (wrapper === "arch" && ["-arch", "-d", "-e"].includes(word.value));
      continue;
    }
    // eval reparses its arguments as shell source, including deferred expansion.
    // Refuse it at an executable position without evaluating or logging that source.
    if (shell && path === "eval") return true;
    if (path.startsWith("/") && isMain(path, bundle)) return true;
    if ((path === "open" || canonical(path) === canonical("/usr/bin/open")) && openLaunchesBundle(words.slice(index + 1), bundle, shell)) return true;
    if (/(?:^|\/)(?:sh|bash|zsh|dash|ksh)$/.test(canonical(path))) {
      // A nested shell can interpret quoted data as executable source again.
      // Refuse that uncertainty without evaluating code or reading environments.
      if (shell) return true;
      for (let argument = index + 1; argument < words.length; argument++) {
        const option = words[argument].value;
        if (option === "--" || !/^[+-]/.test(option)) break;
        if (words[argument].expanded) return true;
        if (option === "--command" || /^-[^-oO]*c/.test(option)) {
          // Only the next argument is source; remaining arguments are $0, $1, ...
          const source = words[argument + 1];
          return !source || source.expanded || commandLaunchesBundle(literalShellWords(source.value), bundle, true);
        }
        // -o/+o and bash -O/+O consume a named option, even in a flag cluster.
        // Its operand must not hide a subsequent -c from preflight.
        if (/^[+-][^-]*[oO]$/.test(option) || ["--rcfile", "--init-file"].includes(option)) {
          if (!words[++argument] || words[argument].expanded) return true;
          continue;
        }
        if (/^[+-][a-zA-Z]+$/.test(option) && !/[oO]/.test(option)) continue;
        if (["--login", "--noprofile", "--norc", "--posix", "--restricted", "--verbose", "--nolineediting"].includes(option)) continue;
        // Unknown option syntax could consume another operand. Do not guess where
        // executable source begins or evaluate it to find out.
        return true;
      }
      return false;
    }
    executable = false;
  }
  return false;
}

/** Match executable positions; expanded or nested shell execution fails closed. */
export function jobLaunchesBundle(text, bundle) {
  const program = /^\s*program = (.*)$/m.exec(text)?.[1] ?? "";
  const argumentsBlock = /^\s*arguments = \{\n([\s\S]*?)^\s*\}/m.exec(text)?.[1] ?? "";
  const argv = argumentsBlock.trim() ? argumentsBlock.trim().split("\n").map((line) => line.trim()) : [];
  // Program controls exec; when present, argv[0] is only the process's display name.
  // Actual argv entries have no shell expansion or control-operator semantics.
  return commandLaunchesBundle([program.trim() || argv[0] || "", ...argv.slice(1)]
    .map((value) => ({value, expanded: false, operator: false})), bundle);
}

export async function inspectAppLaunch(bundle, ops = realMacAppOps(), timeout = 15_000) {
  const deadline = ops.now() + timeout;
  const budget = () => {
    const remaining = deadline - ops.now();
    if (remaining <= 0) throw new Error("Could not inspect all launchd jobs before the time limit. Retry the update after checking launchctl.");
    return Math.min(2000, remaining);
  };
  const registrations = await apps(ops, budget());
  const running = await processes(ops, budget());
  const listing = await read(ops, "/bin/launchctl", ["list"], budget());
  if (!/^PID\s+Status\s+Label/m.test(listing)) throw new Error("Could not inspect the user launchd job list.");
  const labels = listing.split("\n").flatMap((line) => {
    const match = /^(?:\d+|-)\s+-?\d+\s+(.+)$/.exec(line);
    return match ? [match[1]] : [];
  });
  const jobs = [];
  // Bounded concurrency avoids serially paying one subprocess startup per login item.
  let next = 0;
  await Promise.all(Array.from({length: Math.min(8, labels.length)}, async () => {
    while (next < labels.length) {
      const label = labels[next++];
      const result = await ops.run("/bin/launchctl", ["print", `gui/${ops.uid}/${label}`], budget());
      // launchctl list includes inherited user-domain services, and jobs can exit mid-read.
      if (result.code === 113) continue; // no service in this GUI domain
      if (result.code !== 0) throw new Error("Could not inspect a GUI launchd job. Check launchctl before retrying.");
      if (!jobLaunchesBundle(result.stdout, bundle)) continue;
      const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1]);
      const managed = /^\s*managed_by = com\.apple\.runningboard\s*$/m.test(result.stdout);
      if (managed && registered(registrations, bundle, pid)) continue;
      jobs.push(label);
    }
  }));
  return {
    jobs: jobs.sort(),
    unregistered: running.filter((row) => isMain(row.executable, bundle) && !registered(registrations, bundle, row.pid)).map((row) => row.pid),
  };
}

const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
export function launchConflictMessage(conflicts, uid) {
  const lines = [];
  for (const label of conflicts.jobs) {
    // Control characters cannot safely be displayed as a command. Refuse, never rewrite one.
    if ([...label].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      lines.push("A launchd job with a non-printable label launches this app. Inspect launchctl list and remove that job manually.");
    } else {
      lines.push(`Launchd job ${label} can restart Mission Control outside the updater. Remove it yourself in Terminal: launchctl bootout ${quote(`gui/${uid}/${label}`)}`);
    }
  }
  if (conflicts.unregistered.length) lines.push(`Mission Control process ${conflicts.unregistered.join(", ")} is not registered as a Foreground app in LaunchServices. Quit that instance after removing any respawn job, then open Mission Control from Finder or the Dock.`);
  return lines.length ? `${lines.join("\n")}\nNo launchd job was removed. Retry the update after resolving this launch conflict.` : null;
}

export async function assertSafeAppLaunch(bundle, ops = realMacAppOps()) {
  const message = launchConflictMessage(await inspectAppLaunch(bundle, ops), ops.uid);
  if (message) throw new Error(message);
}

async function poll(ops, timeout, check, message) {
  const deadline = ops.now() + timeout;
  do {
    if (await check(Math.max(1, Math.min(2000, deadline - ops.now())))) return;
    const remaining = deadline - ops.now();
    if (remaining <= 0) break;
    await ops.sleep(Math.min(POLL_MS, remaining));
  } while (ops.now() < deadline);
  throw new Error(typeof message === "function" ? message() : message);
}

export async function waitForBundleExit(bundle, ops, timeout = 120_000) {
  let remaining = [];
  await poll(ops, timeout, async (budget) => {
    remaining = (await processes(ops, budget)).filter((row) => inBundle(row.executable, bundle));
    return remaining.length === 0;
  }, () => `Mission Control bundle processes did not exit: ${remaining.map((row) => row.pid).join(", ")}. Close them before retrying; no further bundle replacement is safe while they remain.`);
}

export async function prepareAppLaunch(bundle, ops, timeout = LAUNCH_TIMEOUT_MS) {
  await read(ops, LSREGISTER, ["-f", bundle], Math.min(timeout, 5000));
  await poll(ops, timeout, async (budget) => !(await apps(ops, budget)).some((row) => canonical(row.bundle) === canonical(bundle)),
    "LaunchServices still lists an old instance. The app was not relaunched. Restart macOS if Finder and other apps also cannot open.");
}

export async function verifyAppLaunch(bundle, nonce, ops, timeout = LAUNCH_TIMEOUT_MS) {
  let detail = "no renderer acknowledgment";
  await poll(ops, timeout, async (budget) => {
    const registrations = await apps(ops, budget);
    const running = await processes(ops, budget);
    const ack = ops.readAck(nonce);
    const main = running.find((row) => row.pid === ack?.pid && isMain(row.executable, bundle));
    detail = `registered=${registrations.some((row) => row.id === APP_ID && canonical(row.bundle) === canonical(bundle))}; process=${main?.state ?? "missing"}; renderer=${ack?.nonce === nonce}`;
    return ack?.nonce === nonce && typeof ack?.bundle === "string" && canonical(ack.bundle) === canonical(bundle) && ack?.identity && ops.identity(ack.pid) === ack.identity && main && !/[TZUX]/.test(main.state) && registered(registrations, bundle, main.pid);
  }, () => `LaunchServices launch could not be verified (${detail}). Check daemon.log and update.log. If other apps also cannot open or the Dock says "not open anymore", restart macOS before trying again.`);
}

/** Only this attempt's argv, executable and rechecked start identity authorize a signal. */
export async function stopAttemptLaunch(bundle, nonce, ops) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("Invalid update launch identity.");
  const owned = [];
  for (const row of await processes(ops)) {
    if (!isMain(row.executable, bundle)) continue;
    const identity = ops.identity(row.pid);
    const command = await read(ops, "/bin/ps", ["-ww", "-p", String(row.pid), "-o", "args="]);
    if (!command.includes(`--mission-update-launch ${nonce}`) || !identity) throw new Error("An app outside this update attempt is running. Close it manually before recovery; no process was signalled.");
    owned.push({pid: row.pid, identity});
  }
  for (const row of owned) if (ops.identity(row.pid) === row.identity) ops.kill(row.pid, "SIGTERM");
  try { await waitForBundleExit(bundle, ops, 5000); }
  catch {
    for (const row of owned) if (ops.identity(row.pid) === row.identity) ops.kill(row.pid, "SIGKILL");
    await waitForBundleExit(bundle, ops, 5000);
  }
}
