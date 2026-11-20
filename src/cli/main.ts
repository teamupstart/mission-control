import { runCli } from "./index.ts";

/** The `mctl` entry point (`bin.mctl`, `npm run mctl`). All behavior lives in `index.ts`. */
process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  stdinIsTty: process.stdin.isTTY === true,
});
