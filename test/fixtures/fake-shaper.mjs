// A `command` shaper for tests. Run as `node fake-shaper.mjs <mode> [args...]`: it reads the
// shaping request from stdin and answers on stdout the way its mode says. No network, no tokens.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode = "ok", ...rest] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf8");
const request = text ? JSON.parse(text) : null;
const reply = (value) => process.stdout.write(JSON.stringify(value));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
  case "leak-long": {
    // The value repeated many times, then padding, so the recorded tail's front edge cuts
    // through one copy of it. The front of the 2,000-character tail lands mid-value.
    const value = process.env[rest[0]] ?? "<unset>";
    process.stderr.write(`${value}\n`.repeat(12));
    process.exit(5);
    break;
  }
  case "lock-cwd": {
    // Leaves a nested directory with no permissions in its working directory, so a plain
    // recursive removal of that directory fails, then answers normally.
    mkdirSync(join(process.cwd(), "locked", "inner"), { recursive: true });
    writeFileSync(join(process.cwd(), "locked", "inner", "file"), "x");
    chmodSync(join(process.cwd(), "locked"), 0o000);
    reply({ guidance: [{ id: "locked", body: process.cwd() }] });
    break;
  }
  case "grandchild": {
    // A descendant in the same process group, which a timeout must take down too.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(rest[0], String(child.pid));
    await sleep(60_000);
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}`);
    process.exit(2);
}
