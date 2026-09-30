// Optional validation preload. A unit fixture reaching the real host fails visibly before
// spawning a scan; all other subprocesses retain their normal behavior and lifetime.
import { ChildProcess } from "node:child_process";
import { basename } from "node:path";

if (process.env.NODE_TEST_CONTEXT) {
  const started = performance.now();
  const spawn = ChildProcess.prototype.spawn;
  let scans = 0;
  let spawned = 0;
  let active = 0;
  let peak = 0;
  ChildProcess.prototype.spawn = function (options) {
    if (["ps", "lsof"].includes(basename(options.file))) {
      scans++;
      if (scans === 1) console.error("HOST_SCAN_ATTEMPT", new Error(options.file).stack);
      throw new Error("host scan refused by validation audit");
    }
    const result = spawn.call(this, options);
    spawned++;
    active++;
    peak = Math.max(peak, active);
    this.once("close", () => { active--; });
    return result;
  };
  process.on("exit", () => {
    console.error("CHILD_AUDIT", JSON.stringify({ worker: basename(process.argv[1]), elapsedMs: Math.round(performance.now() - started), hostScanAttempts: scans, spawned, peak, remaining: active }));
    if (scans) process.exitCode = 1;
  });
}
