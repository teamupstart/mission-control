// Run in a disposable child with --expose-gc so collection does not depend on host memory pressure.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { seal } from "../../src/server/workflows/repository-artifact/seal.ts";

const [checkout, pending, probeCommit, commitSize, treeSize] = process.argv.slice(2);
const commits = [], trees = [];
const allocate = Buffer.allocUnsafe;
Buffer.allocUnsafe = (size) => {
  const buffer = allocate(size);
  if (size === Number(commitSize)) commits.push(new WeakRef(buffer));
  if (size === Number(treeSize)) trees.push(new WeakRef(buffer));
  return buffer;
};

const write = fs.writeFile;
const counts = refs => ({ allocated: refs.length, live: refs.filter(ref => ref.deref()).length });
let sample;
fs.writeFile = async (...args) => {
  if (args[0] === join(pending, "artifact", probeCommit)) {
    await setImmediate();
    global.gc();
    sample = { commits: counts(commits), trees: counts(trees) };
  }
  return write(...args);
};
syncBuiltinESMExports();
await seal({ checkout, sourceBase: null }, pending, new AbortController().signal);
console.log(JSON.stringify(sample));
