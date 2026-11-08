/**
 * Whether a failed workflow Command failed because the REPOSITORY does not provide it.
 *
 * A Command slot's global default is repository-neutral by design, and an operator who sets
 * `make test` once for every checkout will meet a repository with no Makefile, or one whose
 * Makefile has no `test` target. That failure says nothing about the change under review:
 * the command never reached the code. Handed to the session as an ordinary "fix the failing
 * check" packet, the cheapest edit that turns the gate green is to write the missing
 * Makefile, which forces a build file nobody asked for on every adopter whose repository runs
 * its tests some other way.
 *
 * A repository can also provide a perfectly good `make test` or `npm test` that runs a
 * NESTED command which cannot find its own target - `npm test --prefix fixtures` in a fixture
 * package with no `test` script prints exactly the refusal the outer `npm test` would. That
 * is a real failure inside a real test command, and telling the session to reconfigure the
 * workflow would hide it. So two things must both hold, and the second is what tells the
 * outer command from a nested one:
 *
 * 1. a line is the configured launcher refusing exactly the target, script, recipe or program
 *    the argv asked for;
 * 2. EVERY line of output is something that launcher prints before it starts any work. A
 *    lifecycle banner (`> pkg@1.0.0 test`), an echoed recipe line, a sub-make's `make[1]:`,
 *    an outer make's `*** [test] Error 2`, npm's `Lifecycle script ... failed`, or any line
 *    from another program is evidence the configured command started, and then whatever
 *    refused was something it ran.
 *
 * Callers pass only complete output: a refusal is a few lines, so output that had to be
 * truncated came from a command that ran.
 *
 * Returns the refusal line, trimmed, so the repair packet can quote the exact sentence that
 * decided it; null for anything else, which keeps the ordinary failure request.
 */
export function commandMisfitSignal(
  command: readonly string[] | null | undefined,
  output: string,
): string | null {
  if (!command || command.length === 0) return null;
  const launcher = launcherRefusal(command);
  if (!launcher) return null;
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.every(launcher.own)) return null;
  const refusal = lines.find(launcher.refusal);
  if (!refusal) return null;
  return refusal.length > 300 ? `${refusal.slice(0, 300)}…` : refusal;
}

type LineTest = (line: string) => boolean;

interface LauncherRefusal {
  /** The launcher refusing exactly what the argv asked it to run. */
  refusal: LineTest;
  /** A line this launcher prints before it has started any work. */
  own: LineTest;
}

function any(tests: readonly RegExp[]): LineTest {
  return (line) => tests.some((test) => test.test(line));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Any of make's or a shell's quoting styles around one exact name. */
function quoted(name: string): string {
  return `[\`'"]?${escape(name)}['"\`]?`;
}

/** make options whose value is the next argument when not attached. */
const MAKE_VALUE_OPTIONS = new Set(["-C", "-f", "-I", "-o", "-W", "--directory", "--file",
  "--makefile", "--include-dir", "--old-file", "--assume-old", "--what-if", "--new-file",
  "--assume-new"]);

function makeTargets(args: readonly string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (MAKE_VALUE_OPTIONS.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-") || arg.includes("=")) continue;
    targets.push(arg);
  }
  return targets;
}

/**
 * Positional arguments, skipping each option's value when it is a separate argument.
 *
 * `pnpm --dir packages/app test` asks for `test`, not `packages/app`. An attached value
 * (`--dir=packages/app`) is one argument that starts with `-` and is skipped with its option.
 */
function positionals(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueOptions.has(arg)) { index += 1; continue; }
    if (!arg.startsWith("-")) found.push(arg);
  }
  return found;
}

/** Options whose value is the next argument, per launcher. */
const VALUE_OPTIONS: Record<"npm" | "pnpm" | "yarn" | "just" | "task", ReadonlySet<string>> = {
  npm: new Set(["--prefix", "-w", "--workspace", "--loglevel", "--userconfig", "--cache", "--registry"]),
  pnpm: new Set(["-C", "--dir", "-F", "--filter", "--filter-prod", "--loglevel", "--reporter",
    "--test-pattern", "--changed-files-ignore-pattern"]),
  yarn: new Set(["--cwd", "--modules-folder", "--cache-folder", "--mutex", "--network-timeout"]),
  just: new Set(["-f", "--justfile", "-d", "--working-directory", "--shell", "--shell-arg",
    "--dotenv-filename", "--dotenv-path", "--color", "--chooser"]),
  task: new Set(["-d", "--dir", "-t", "--taskfile", "-o", "--output", "-c", "--concurrency",
    "--output-group-begin", "--output-group-end", "--interval"]),
};

/** The script an npm, pnpm or Yarn invocation asks for, or null when it names none. */
function packageScript(tool: "npm" | "pnpm" | "yarn", args: readonly string[]): string | null {
  const [first, second] = positionals(args, VALUE_OPTIONS[tool]);
  if (!first) return null;
  if (["run", "run-script", "rum", "urn"].includes(first)) return second ?? null;
  if (tool === "npm") {
    if (["test", "t", "tst"].includes(first)) return "test";
    return ["start", "stop", "restart"].includes(first) ? first : null;
  }
  return first;
}

function firstPositional(tool: "just" | "task", args: readonly string[]): string | null {
  return positionals(args, VALUE_OPTIONS[tool])[0] ?? null;
}

/** The program a `sh -c` script starts, skipping leading environment assignments. */
function shellProgram(script: string): string | null {
  for (const token of script.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return token && /^[\w./+-]+$/.test(token) ? token : null;
  }
  return null;
}

/** A shell reporting a program not found, for one program name pattern. */
function shellNotFound(name: string): RegExp[] {
  return [
    new RegExp(`^(?:\\S*/)?(?:sh|bash|dash|ksh)(?:: line \\d+)?: (?:\\d+: )?${name}: (?:command )?not found$`, "i"),
    new RegExp(`^zsh(?::\\d+)?: command not found: ${name}$`, "i"),
  ];
}

function launcherRefusal(command: readonly string[]): LauncherRefusal | null {
  const tool = basename(command[0]!);
  const args = command.slice(1);

  if (["make", "gmake", "bmake"].includes(tool)) {
    // The top-level make only: `make[1]:` is a sub-make inside a recipe that did run.
    const prefix = `^(?:\\S*/)?${escape(tool)}: `;
    const targets = makeTargets(args);
    const refusal = targets.length === 0
      ? any([new RegExp(`${prefix}\\*\\*\\* No targets specified and no makefile found\\.`, "i"),
        new RegExp(`${prefix}\\*\\*\\* No targets\\.\\s+Stop\\.`, "i")])
      : any(targets.flatMap((target) => [
        // Ends at the target: `..., needed by 'test'` is a missing prerequisite, a real failure.
        new RegExp(`${prefix}\\*\\*\\* No rule to make target ${quoted(target)}\\.\\s+Stop\\.$`, "i"),
        new RegExp(`${prefix}don't know how to make ${quoted(target)}\\.?(?:\\s+Stop\\.?)?$`, "i"),
      ]));
    const ownPrefix = new RegExp(prefix);
    // `*** [test] Error 2` (or `[Makefile:3: test]`) is make reporting a recipe that RAN.
    const ranRecipe = /\*\*\* \[[^\]]*\] Error \d+|\bError code \d+/;
    return { refusal, own: (line) => ownPrefix.test(line) && !ranRecipe.test(line) };
  }

  if (tool === "npm") {
    const script = packageScript(tool, args);
    if (!script) return null;
    // npm prefixes every line of its own diagnostics; a script that ran prints `> pkg test`
    // banners, and a failed one adds `Lifecycle script ... failed` / `command failed`.
    const started = /lifecycle script|\bELIFECYCLE\b|\bcommand failed\b|\bnpm (?:error|ERR!) command\b/i;
    return {
      refusal: any([new RegExp(`^npm (?:error|ERR!) missing script:\\s*${quoted(script)}\\s*$`, "i")]),
      own: (line) => /^npm (?:error|ERR!|warn|WARN|notice)(?:\s|$)/.test(line) && !started.test(line),
    };
  }

  if (tool === "pnpm") {
    const script = packageScript(tool, args);
    if (!script) return null;
    return {
      refusal: any([new RegExp(`\\bERR_PNPM_NO_SCRIPT\\b.*\\bmissing script:\\s*${quoted(script)}\\s*$`, "i")]),
      own: any([/\bERR_PNPM_NO_SCRIPT\b/, /^Command "[^"]+" not found\.?$/i, /^Did you mean\b/i]),
    };
  }

  if (tool === "yarn") {
    const script = packageScript(tool, args);
    if (!script) return null;
    return {
      refusal: any([
        new RegExp(`^error Command "${escape(script)}" not found\\.?$`, "i"),
        new RegExp(`^Usage Error: Couldn't find a script named "${escape(script)}"`, "i"),
      ]),
      // Yarn 1's header and docs hint, and Yarn 2+'s usage line, which also starts with `$`
      // but names `yarn run` itself rather than a script's command.
      own: any([/^yarn run v\d/i, /^error Command "[^"]+" not found\.?$/i, /^info Visit https?:\/\//i,
        /^Usage Error: Couldn't find a script named /i, /^\$ yarn run \[/]),
    };
  }

  if (tool === "just") {
    const recipe = firstPositional("just", args);
    const tests = [/^error: no justfile found\b/i];
    if (recipe) tests.push(new RegExp(`^error: justfile does not contain recipe ${quoted(recipe)}`, "i"));
    return {
      refusal: any(tests),
      own: (line) => (/^error: /i.test(line) && !/^error: recipe .* failed/i.test(line)) || /^Did you mean\b/i.test(line),
    };
  }

  if (tool === "task") {
    const name = firstPositional("task", args) ?? "default";
    return {
      refusal: any([/^task: no taskfile found\b/i, new RegExp(`^task: task "${escape(name)}" does not exist`, "i")]),
      // `task: [test] <cmd>` is go-task announcing a command it is running.
      own: (line) => /^task: /i.test(line) && !/^task: \[/i.test(line) && !/failed to run task/i.test(line),
    };
  }

  if (["sh", "bash", "dash", "ksh", "zsh"].includes(tool) && args[0] === "-c" && args[1]) {
    const program = shellProgram(args[1]);
    if (!program) return null;
    return { refusal: any(shellNotFound(escape(program))), own: any(shellNotFound("\\S+")) };
  }

  return null;
}

/** The MCP tool a session uses to set a repository's Command; registered in `src/mcp/server.ts`. */
export const CONFIGURE_WORKFLOW_COMMAND_TOOL = "configure_workflow_command";

export interface CommandFitInput {
  slot: string;
  command: readonly string[] | null;
  commandSource: "override" | "default" | null | undefined;
  runId: string;
}

function argvText(command: readonly string[] | null): string {
  return command && command.length > 0 ? command.join(" ") : "the configured command";
}

function configureCall(input: CommandFitInput): string {
  return `${CONFIGURE_WORKFLOW_COMMAND_TOOL}({ runId: ${JSON.stringify(input.runId)}, `
    + `slot: ${JSON.stringify(input.slot)}, command: [<confirmed argv>] })`;
}

function resubmitCall(runId: string): string {
  return `trigger_workflow_action({ request: { action: "resubmit", runId: ${JSON.stringify(runId)}, `
    + `parameters: { requestId: <new id>, resubmitUnchanged: true } } })`;
}

/**
 * The requested change for a Command the repository does not provide.
 *
 * Replaces "Fix the failing <slot> check" outright rather than appending to it: an agent
 * handed both reads the familiar title and writes the Makefile. The procedure is fixed and
 * numbered because each step guards a different mistake - inspecting finds the real command,
 * `request_input` keeps a person in charge of what the daemon will execute in their
 * repository, the tool writes the override where Library › Commands shows it, and an explicit
 * unchanged resubmission is the only way a round that changed no files reaches review again.
 */
export function misfitCommandRepair(
  input: CommandFitInput & { signal: string },
): { title: string; guidance: string } {
  const where = input.commandSource === "override"
    ? "the Command configured for this repository"
    : "Mission Control's machine-wide default for this slot, not a command configured for this repository";
  return {
    title: `Configure the ${input.slot} Command for this repository; do not add files to satisfy it`,
    guidance: [
      `The ${input.slot} gate ran \`${argvText(input.command)}\`, which is ${where}. It stopped `
        + "before reaching your change because the repository does not provide it:",
      `  ${input.signal}`,
      "",
      "This is a workflow configuration problem, not a defect in your change. Do not create a "
        + "Makefile, package script, task file or any other file to make this command pass.",
      "1. Inspect the repository to learn how it runs its "
        + `${input.slot}: package.json scripts, Makefile, justfile, Taskfile, pyproject.toml, tox.ini, `
        + "Cargo.toml, go.mod, Gradle or Maven files, CI workflows, README and CONTRIBUTING.",
      `2. Call ${configureCall(input)} with the argv you found. It asks the operator to confirm `
        + "through a request_input card that Mission Control writes, naming this run, the slot, the "
        + "repository and the exact argv, and waits for their answer; nothing is configured unless "
        + "they choose Configure this Command. It sets this repository's override in Library › "
        + "Commands, never the machine-wide default, and lets the corrected command run again in "
        + "this workflow run. If they decline, ask them with request_input which command to use, "
        + "then call it again with that argv.",
      "3. A configuration-only repair changes no files, so the engine cannot see it and would "
        + "refuse the round as unchanged. This is the one case where you resubmit yourself: "
        + `${resubmitCall(input.runId)}. If you also changed files for other requested changes, `
        + "finish those first and let the engine resubmit instead. If the operator declines, stop and say so.",
    ].join("\n"),
  };
}

/**
 * The note appended to an ordinary failure of a machine-wide default.
 *
 * Output this module does not recognize may still be a repository that runs the slot another
 * way - a custom wrapper, a localized message - so the session is told what the default is
 * and handed the same procedure, without being told the failure IS a configuration problem.
 */
export function defaultCommandFailureNote(input: CommandFitInput): string {
  return [
    `Note: \`${argvText(input.command)}\` is Mission Control's machine-wide default for the `
      + `${input.slot} slot, not a command configured for this repository.`,
    "If the output shows the command does not apply here rather than a defect in your change, "
      + "do not add files to satisfy it. Find how the repository runs this slot and call "
      + `${configureCall(input)}, which asks the operator to confirm through request_input; then, `
      + `because a configuration-only repair changes no files the engine can see, resubmit with `
      + `${resubmitCall(input.runId)}.`,
  ].join("\n");
}
