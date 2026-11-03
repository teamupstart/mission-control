// Shared by Electron and its detached updater. OS reads are bounded, read-only and
// fail closed. Never print launchd environments or process command lines.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processIdentity } from "./update-lock.mjs";
import { CHECK_SUPERVISOR_MARKER } from "../src/shared/owned-runtime.mjs";

export const APP_ID = "com.mission-control.app";
export const LAUNCH_TIMEOUT_MS = 25_000;
/**
 * How long one macOS command may take when its caller has no deadline of its own to give it.
 *
 * A bound on a hung command, not a guess at a healthy one. It used to be 2s here and 5s for
 * `open` and `lsregister`, and a busy Mac blows through both: a command that runs out of time
 * rejects rather than being retried, so one slow `ps` failed the update it belonged to and then
 * that update's recovery. A caller that has a deadline passes what is left of it instead.
 */
export const COMMAND_TIMEOUT_MS = 15_000;
/**
 * How long a WHOLE launch-conflict inspection may take when its caller has no deadline to give:
 * the startup health check and the interactive preflight, both of which a person is waiting on.
 * Sized above the sweep's real cost (see `inspectAppLaunches`) and well below a migration's own
 * budget. A caller that owns a deadline passes what is left of it instead.
 */
export const LAUNCH_INSPECTION_TIMEOUT_MS = 60_000;
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const POLL_MS = 250;
export const launchAckPath = (directory, nonce) => join(directory, `update-launch-${nonce}.json`);

export function realMacAppOps(directory) {
  return {
    uid: process.getuid(), now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: (command, args, timeout = COMMAND_TIMEOUT_MS) => new Promise((resolve, reject) => {
      const env = {...process.env};
      if (command === "/usr/bin/open") delete env.ELECTRON_RUN_AS_NODE;
      // `launchctl dumpstate` is the largest read: 6.5MB on a developer Mac with ~470 GUI jobs.
      execFile(command, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 128 * 1024 * 1024, env }, (error, stdout) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new Error(`macOS launch state was larger than this inspection reads (${basename(command)}).`));
        } else if (error && (typeof error.code !== "number" || error.killed)) {
          // Name the executable, never its arguments: `launchctl print gui/<uid>/<label>` and
          // `lsregister -f <bundle>` carry a job label and a bundle path, and this message is
          // written to update.log. The name is what tells one probe's timeout from another's.
          reject(new Error(`Could not inspect macOS launch state within the time limit (${basename(command)}).`));
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
  let word = "", quote = "", expanded = false, commandSubstitution = false;
  const finish = () => {
    if (word) words.push({value: word, expanded, commandSubstitution, operator: false});
    word = "";
    expanded = false;
    commandSubstitution = false;
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
        if (quote !== "'" && (character === "`" || (character === "$" && command[index + 1] === "("))) commandSubstitution = true;
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
      if (character === "`" || (character === "$" && command[index + 1] === "(")) commandSubstitution = true;
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
  // Substitutions run before the outer command, including in data arguments,
  // assignments and redirects. Refuse them before skipping any such position.
  if (shell && words.some((word) => word.commandSubstitution)) return true;
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
      // env -S splits and expands a command string using its own grammar. Refuse
      // that execution source, including attached and clustered short options.
      if (wrapper === "env" && /^(?:-[iv0]*S|--split-string(?:=|$))/.test(word.value)) return true;
      optionValue = (wrapper === "exec" && word.value === "-a")
        || (wrapper === "env" && ["-u", "--unset", "-C", "--chdir"].includes(word.value))
        || (wrapper === "nice" && word.value === "-n")
        || (wrapper === "arch" && ["-arch", "-d", "-e"].includes(word.value));
      continue;
    }
    // eval and source builtins execute additional shell source. Refuse them at
    // an executable position without reading, evaluating or logging that source.
    if (shell && ["eval", ".", "source"].includes(path)) return true;
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
          // launchctl print does not delimit embedded newlines from later argv.
          // More printed lines could extend the source, not just supply $0/$1.
          // Refuse that ambiguity instead of inspecting only its first line.
          const source = words[argument + 1];
          return words.length !== argument + 2 || !source || source.expanded
            || commandLaunchesBundle(literalShellWords(source.value), bundle, true);
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
      // Without inline -c source, the shell can execute a script or stdin that
      // this read-only inventory cannot inspect. Do not declare it safe.
      return true;
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

/**
 * Every job in the user's GUI launchd domain, read from ONE `launchctl dumpstate`, or null when
 * that dump cannot be proven complete.
 *
 * `dumpstate` prints each service in exactly the shape `launchctl print gui/<uid>/<label>`
 * does, headed `gui/<uid>/<label> = {`, and launchd answers it from memory in a fraction of a
 * second where ~470 serial prints took 4-31s. A null sends the caller back to printing each job.
 *
 * A block runs from its header to the next column-0 header, never to the first closing brace,
 * because an argument with an embedded newline can print a `}` of its own at column 0. The same
 * newline can print a line that LOOKS like a header, which would end a job early and hand the
 * rest of its source - an `exec` of this bundle, say - to a section nobody reads. One dump holds
 * every domain, so it is accepted only when the whole of it is accounted for:
 *
 * - every column-0 line is a header in launchd's own grammar (`system`, `<kind>/<id>` or a
 *   service beneath one) or a bare `}`; launchd indents everything else with tabs;
 * - no header appears twice;
 * - launchd prints every service in one unbroken run directly after its own domain's block, so a
 *   service header beneath any other domain - `pid/1/<x>` inside a GUI job, say - is refused;
 * - every domain that states a service count holds exactly that many service blocks, and the
 *   GUI domain's blocks are exactly the labels it lists.
 *
 * Together these bound every GUI job but one by the next GUI job's own header: a forged header
 * of any kind inside it would interrupt the run. The run's LAST job is the exception, because a
 * forged DOMAIN header after it reads like the next domain launchd prints. The caller therefore
 * reads that one job with `launchctl print` rather than from the dump - see `readGuiJobs` - which
 * is exactly the evidence the per-job fallback holds for every job. Map order is dump order.
 */
const DUMP_HEADER = /^(system|(?:gui|user|login|pid)\/\d+)(?:\/.+)? = \{$/;
export function parseGuiJobs(dump, uid) {
  const domain = `gui/${uid}`;
  if (dump.split("\n").some((line) => line && !line.startsWith("\t") && line !== "}" && !DUMP_HEADER.test(line))) return null;
  const sections = new Map();
  const counted = new Map();
  const headers = [...dump.matchAll(/^(\S.*) = \{$/gm)];
  let current = null;
  for (const [index, header] of headers.entries()) {
    const name = header[1];
    if (sections.has(name)) return null;
    sections.set(name, dump.slice(header.index, headers[index + 1]?.index ?? dump.length));
    const owner = DUMP_HEADER.exec(header[0])?.[1];
    if (owner === name) { current = name; continue; }
    if (owner !== current) return null;
    counted.set(owner, (counted.get(owner) ?? 0) + 1);
  }
  for (const [name, text] of sections) {
    if (DUMP_HEADER.exec(`${name} = {`)?.[1] !== name) continue; // a service, not a domain
    const stated = /^\tservice count = (\d+)$/m.exec(text)?.[1];
    if (stated !== undefined && Number(stated) !== (counted.get(name) ?? 0)) return null;
  }
  const summary = sections.get(domain);
  if (!summary) return null;
  const count = Number(/^\s*service count = (\d+)\s*$/m.exec(summary)?.[1] ?? NaN);
  const listing = /^\s*services = \{\n([\s\S]*?)^\s*\}\s*$/m.exec(summary)?.[1];
  if (!Number.isInteger(count) || listing === undefined) return null;
  const listed = new Set();
  for (const line of listing.split("\n")) {
    if (!line.trim()) continue;
    const label = /^\s*\S+\s+\S+\s*\t(.+)$/.exec(line)?.[1];
    if (!label || listed.has(label)) return null;
    listed.add(label);
  }
  const jobs = new Map();
  for (const [name, text] of sections) if (name.startsWith(`${domain}/`)) jobs.set(name.slice(domain.length + 1), text);
  if (listed.size !== count || jobs.size !== count || [...listed].some((label) => !jobs.has(label))) return null;
  return jobs;
}

/**
 * The fallback when `dumpstate` is unreadable: `launchctl list`, then one print per label. Its
 * cost is the one recorded on `inspectAppLaunches`, and it is what every sweep paid before.
 */
async function printGuiJobs(ops, budget, evaluate) {
  const listing = await read(ops, "/bin/launchctl", ["list"], budget());
  if (!/^PID\s+Status\s+Label/m.test(listing)) throw new Error("Could not inspect the user launchd job list.");
  const labels = listing.split("\n").flatMap((line) => {
    const match = /^(?:\d+|-)\s+-?\d+\s+(.+)$/.exec(line);
    return match ? [match[1]] : [];
  });
  // Bounded concurrency avoids serially paying one subprocess startup per login item.
  let next = 0;
  await Promise.all(Array.from({length: Math.min(8, labels.length)}, async () => {
    while (next < labels.length) {
      const label = labels[next++];
      const printed = await printGuiJob(ops, label, budget());
      if (printed !== null) evaluate(label, printed);
    }
  }));
}

/** A GUI job's `launchctl print`, or null when it left the domain mid-read. */
async function printGuiJob(ops, label, timeout) {
  const result = await ops.run("/bin/launchctl", ["print", `gui/${ops.uid}/${label}`], timeout);
  // launchctl list includes inherited user-domain services, and jobs can exit mid-read.
  if (result.code === 113) return null; // no service in this GUI domain
  if (result.code !== 0) throw new Error("Could not inspect a GUI launchd job. Check launchctl before retrying.");
  return result.stdout;
}

/**
 * Evaluate every GUI job from one `dumpstate`, re-reading only the run's last job with `launchctl
 * print` because nothing in the dump bounds it (see `parseGuiJobs`). Returns false, having
 * evaluated nothing, when the dump is unreadable or unproven, so the caller prints each job.
 */
async function readGuiJobs(ops, budget, evaluate) {
  let result;
  const timeout = budget();
  try { result = await ops.run("/bin/launchctl", ["dumpstate"], timeout); } catch { return false; }
  const jobs = result.code === 0 ? parseGuiJobs(result.stdout, ops.uid) : null;
  if (!jobs) return false;
  const last = [...jobs.keys()].at(-1);
  for (const [label, text] of jobs) if (label !== last) evaluate(label, text);
  if (last !== undefined) {
    const printed = await printGuiJob(ops, last, budget());
    if (printed !== null) evaluate(last, printed);
  }
  return true;
}

// A probe gets whatever is left of its caller's deadline, never a smaller fixed slice. A probe
// that runs out of time rejects rather than being retried, so a per-probe cap bought nothing but
// an earlier failure: on a busy Mac one `ps` or `launchctl print` taking more than two seconds
// failed the whole update and then its recovery, well inside the deadline the caller had set.
//
// That holds for the whole sweep, not only the probes inside it, so the budget is a parameter all
// the way out to `assertSafeAppLaunch`.
export async function inspectAppLaunch(
  bundle,
  ops = realMacAppOps(),
  timeout = LAUNCH_INSPECTION_TIMEOUT_MS,
) {
  return (await inspectAppLaunches([bundle], ops, timeout))[0];
}

/**
 * ONE launchd sweep, evaluated for every bundle in `bundles`, in order.
 *
 * The sweep is machine-wide: `launchctl list` plus one `launchctl print` per user launchd label,
 * and nothing in it depends on which bundle is being asked about until the very last step, where
 * each printed job is tested against a bundle path. So several bundles share one sweep, and
 * every bundle still receives both checks - a respawn job that launches it, and a main process
 * that is not a registered Foreground app - against a snapshot at least as fresh as a second,
 * later sweep would have read.
 *
 * What a sweep costs, because it sets every deadline that guards one. This is the one place
 * these numbers are recorded; callers say only why they need their own deadline. The jobs come
 * from one `launchctl dumpstate` plus one print of its last GUI job (see `readGuiJobs`): about
 * 0.14s for the dump of 468 GUI jobs on a Mac whose
 * load average was 18, where printing them one at a time took 24s. The per-label fallback, and
 * every sweep before the dump, costs what follows. launchd answers
 * the prints essentially serially, so extra concurrency buys nothing (554 labels: 4.7s at 8-wide,
 * 4.1-4.4s at 16, 32 and 64), and the cost is set by the host's label count, which this app does
 * not control. On a developer Mac with ~550 labels one sweep took 4.1-5.3s idle and 19-31s under
 * a concurrency-6 test suite, which is why a fixed 15s cap refused 20 of 25 loaded sweeps. A
 * detached install used to run five sweeps - its parent-exit checkpoint asked about the source
 * and the target separately, twice - and now runs three (2,855 probe calls down to 1,738).
 */
export async function inspectAppLaunches(
  bundles,
  ops = realMacAppOps(),
  timeout = LAUNCH_INSPECTION_TIMEOUT_MS,
) {
  const deadline = ops.now() + timeout;
  const budget = () => {
    const remaining = deadline - ops.now();
    if (remaining <= 0) throw new Error("Could not inspect all launchd jobs before the time limit. Retry the update after checking launchctl.");
    return remaining;
  };
  const registrations = await apps(ops, budget());
  const running = await processes(ops, budget());
  const jobs = bundles.map(() => []);
  const evaluate = (label, text) => {
    // Read once per job; only the bundle comparison below differs between bundles.
    const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(text)?.[1]);
    const managed = /^\s*managed_by = com\.apple\.runningboard\s*$/m.test(text);
    for (const [index, bundle] of bundles.entries()) {
      if (!jobLaunchesBundle(text, bundle)) continue;
      if (managed && registered(registrations, bundle, pid)) continue;
      jobs[index].push(label);
    }
  };
  if (!(await readGuiJobs(ops, budget, evaluate))) await printGuiJobs(ops, budget, evaluate);
  return bundles.map((bundle, index) => ({
    jobs: jobs[index].sort(),
    unregistered: running.filter((row) => isMain(row.executable, bundle) && !registered(registrations, bundle, row.pid)).map((row) => row.pid),
  }));
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

export async function assertSafeAppLaunch(
  bundle,
  ops = realMacAppOps(),
  timeout = LAUNCH_INSPECTION_TIMEOUT_MS,
) {
  await assertSafeAppLaunches([bundle], ops, timeout);
}

/**
 * `assertSafeAppLaunch` for several bundles from ONE sweep - see `inspectAppLaunches`.
 *
 * Refuses on the first bundle, in the order given, that has a conflict, which is the same
 * refusal a run of sequential single-bundle checks would have raised first.
 */
export async function assertSafeAppLaunches(
  bundles,
  ops = realMacAppOps(),
  timeout = LAUNCH_INSPECTION_TIMEOUT_MS,
) {
  for (const inspection of await inspectAppLaunches(bundles, ops, timeout)) {
    const message = launchConflictMessage(inspection, ops.uid);
    if (message) throw new Error(message);
  }
}

async function poll(ops, timeout, check, message) {
  const deadline = ops.now() + timeout;
  do {
    // The rest of the deadline, for the reason `inspectAppLaunch` gives.
    if (await check(Math.max(1, deadline - ops.now()))) return;
    const remaining = deadline - ops.now();
    if (remaining <= 0) break;
    await ops.sleep(Math.min(POLL_MS, remaining));
  } while (ops.now() < deadline);
  throw new Error(typeof message === "function" ? message() : message);
}

/**
 * Why one process still inside the bundle is there, in words a person can act on.
 *
 * The command line is READ only to recognise the workflow-check supervisor marker and is never
 * returned: the file header's rule against printing command lines still holds, and this text
 * reaches update.log and the outcome dialog. An unreadable command line falls back to what the
 * executable path alone can say.
 */
async function describeBundleHolder(row, bundle, ops) {
  if (isMain(row.executable, bundle)) return `pid ${row.pid} (the Mission Control app is still running)`;
  let args = "";
  try {
    const result = await ops.run("/bin/ps", ["-ww", "-p", String(row.pid), "-o", "args="], COMMAND_TIMEOUT_MS);
    if (result.code === 0) args = result.stdout;
  } catch { /* The executable still identifies a helper below. */ }
  const orphaned = row.ppid === 1 ? " whose parent already exited" : "";
  if (args.includes(CHECK_SUPERVISOR_MARKER)) return `pid ${row.pid} (a workflow check${orphaned} is still running)`;
  return `pid ${row.pid} (${basename(row.executable)}${orphaned} is still running)`;
}

/**
 * Wait until nothing executes from `bundle`. A timeout names each blocking pid and its cause.
 *
 * The cause is worked out once, after the deadline, so the steady-state wait still costs one
 * `ps` per tick. A probe that failed is rethrown as itself: it says nothing about who holds the
 * bundle, and labelling it with the previous tick's processes would blame the wrong thing.
 */
export async function waitForBundleExit(bundle, ops, timeout = 120_000) {
  let remaining = [];
  let timedOut = false;
  try {
    await poll(ops, timeout, async (budget) => {
      remaining = (await processes(ops, budget)).filter((row) => inBundle(row.executable, bundle));
      return remaining.length === 0;
    }, () => { timedOut = true; return "Mission Control bundle processes did not exit."; });
  } catch (error) {
    if (!timedOut || !remaining.length) throw error;
    const holders = [];
    for (const row of remaining) holders.push(await describeBundleHolder(row, bundle, ops));
    throw new Error(`Mission Control bundle processes did not exit: ${holders.join("; ")}. Close them before retrying; no further bundle replacement is safe while they remain.`);
  }
}

export async function prepareAppLaunch(bundle, ops, timeout = LAUNCH_TIMEOUT_MS) {
  await read(ops, LSREGISTER, ["-f", bundle], timeout);
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
