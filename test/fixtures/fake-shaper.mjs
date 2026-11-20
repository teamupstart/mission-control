// A `command` shaper for tests. Run as `node fake-shaper.mjs <mode> [args...]`: it reads the
// shaping request from stdin and answers on stdout the way its mode says. No network, no tokens.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode = "ok", ...rest] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf8");
const request = text ? JSON.parse(text) : null;
const reply = (value) => process.stdout.write(JSON.stringify(value));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// A PID file appears whole or not at all: a test that waits for it to exist must never read it
// between its creation and its write, which an ordinary write allows.
const writePid = (path, pid) => {
  writeFileSync(`${path}.partial`, String(pid));
  renameSync(`${path}.partial`, path);
};

switch (mode) {
  case "echo": {
    // Everything the call saw: argv, working directory, the named variables, and the request.
    const env = Object.fromEntries(rest.filter((name) => name.startsWith("env=")).map((name) => name.slice(4))
      .map((name) => [name, process.env[name] ?? null]));
    reply({ guidance: [{ id: "echo", title: "Echo", body: JSON.stringify({
      argv: process.argv.slice(2), cwd: process.cwd(), env, envKeys: Object.keys(process.env), request,
    }) }] });
    break;
  }
  case "ok":
    reply({
      version: "v1.4.0",
      guidance: [{ id: `${request.stage}/one`, title: "One", body: `first entry for ${request.repo.name}` }],
      repo: request.stage === "gather" ? { facts: { language: "typescript" }, summary: `summary of ${request.repo.name}` } : undefined,
    });
    break;
  case "degraded":
    reply({ degraded: true, notes: ["The guidance model is unavailable."], guidance: [{ id: "fallback", body: "fallback entry" }] });
    break;
  case "garbage":
    process.stdout.write("this is not json");
    break;
  case "invalid":
    reply({ guidance: "not a list" });
    break;
  case "error":
    reply({ error: { code: "denied", message: "the caller may not read this guidance" } });
    break;
  case "fail":
    process.stderr.write("the shaper broke");
    process.exit(3);
    break;
  case "slow":
    await sleep(Number(rest[0] ?? 5000));
    reply({ guidance: [{ id: "late", body: "late entry" }] });
    break;
  case "overflow":
    // Exactly this many bytes of stdout, so a test can stand on either side of the cap.
    process.stdout.write("x".repeat(Number(rest[0] ?? 300 * 1024)));
    break;
  case "leak":
    // Repeats the value it was handed on stderr, then fails: its reason must not carry it.
    process.stderr.write(`could not authenticate with ${process.env[rest[0]] ?? "<unset>"}`);
    process.exit(4);
    break;
  case "leak-glued":
    // The value printed with letters on both sides, as part of a larger word.
    process.stderr.write(`login failed for user${process.env[rest[0]] ?? "<unset>"}x`);
    process.exit(4);
    break;
  case "leak-split": {
    // Repeats a non-ASCII value on stderr in two writes, split inside one of its multi-byte
    // characters, so the pipe delivers it as two chunks with the character cut between them.
    const bytes = Buffer.from(`could not authenticate with ${process.env[rest[0]] ?? "<unset>"}`, "utf8");
    let cut = bytes.length - 2;
    while (cut > 0 && (bytes[cut] & 0xc0) !== 0x80) cut--;
    process.stderr.write(bytes.subarray(0, cut));
    await sleep(100);
    process.stderr.write(bytes.subarray(cut));
    await sleep(50);
    process.exit(4);
    break;
  }
  case "leak-long": {
    // The value repeated many times, then padding, so the recorded tail's front edge cuts
    // through one copy of it. The front of the 2,000-character tail lands mid-value.
    const value = process.env[rest[0]] ?? "<unset>";
    process.stderr.write(`${value}\n`.repeat(12));
    process.exit(5);
    break;
  }
  case "reply-error-leak":
    // A structured error on stdout, exit 0, that repeats the value it was handed.
    reply({ error: { code: "denied", message: `rejected credential ${process.env[rest[0]] ?? "<unset>"}` } });
    break;
  case "version-leak":
    // A version string that repeats the value it was handed, on an otherwise good reply.
    reply({ version: `v2-${process.env[rest[0]] ?? "<unset>"}`, guidance: [{ id: "v", body: "versioned entry" }] });
    break;
  case "reply-notes-leak":
    reply({ degraded: true, notes: [`fell back after ${process.env[rest[0]] ?? "<unset>"} was refused`], guidance: [] });
    break;
  case "escape": {
    // A helper in a process group of its own that inherits this shaper's stdout and stderr, so
    // killing the shaper's group leaves both pipes held open.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: ["ignore", "inherit", "inherit"],
    });
    writePid(rest[0], helper.pid);
    helper.unref();
    await sleep(60_000);
    break;
  }
  case "escape-answer": {
    // A helper outside this shaper's group holds both pipes, so reaping the group cannot close
    // them; the shaper answers shortly before the call's deadline and exits.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: ["ignore", "inherit", "inherit"],
    });
    writePid(rest[0], helper.pid);
    helper.unref();
    await sleep(Math.max(0, Number(rest[1]) - Date.now()));
    reply({ guidance: [{ id: "on-time", body: "answered just before the deadline" }] });
    break;
  }
  case "pipe-helper": {
    // A helper in this shaper's process group that inherits its stdout and stderr and keeps
    // them open, while the shaper itself answers and exits successfully.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
    writePid(rest[0], helper.pid);
    helper.unref();
    reply({ guidance: [{ id: "answered", body: "answered while a helper held the pipes" }] });
    break;
  }
  case "orphan-helper": {
    // A helper in this shaper's own process group, with stdio of its own, left running after a
    // perfectly good reply. Nothing holds the pipes, so the call closes normally.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writePid(rest[0], helper.pid);
    helper.unref();
    reply({ guidance: [{ id: "answered", body: "answered, and left a helper behind" }] });
    break;
  }
  case "lock-cwd": {
    // Leaves a nested directory with no permissions in its working directory, so a plain
    // recursive removal of that directory fails, then answers normally.
    mkdirSync(join(process.cwd(), "locked", "inner"), { recursive: true });
    writeFileSync(join(process.cwd(), "locked", "inner", "file"), "x");
    // And a link out of the tree, which cleanup must never follow or change.
    if (rest[0]) symlinkSync(rest[0], join(process.cwd(), "outside"));
    chmodSync(join(process.cwd(), "locked"), 0o000);
    reply({ guidance: [{ id: "locked", body: process.cwd() }] });
    break;
  }
  case "grandchild": {
    // A descendant in the same process group, which a timeout must take down too.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writePid(rest[0], child.pid);
    await sleep(60_000);
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}`);
    process.exit(2);
}
