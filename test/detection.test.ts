import { test } from "node:test";
import assert from "node:assert/strict";
import { allHarnesses } from "../src/server/harness/index.ts";
import type { AgentType } from "../src/shared/types.ts";
import { classifyAgent, nativeAgent } from "../src/server/discovery/processes.ts";

// What is at stake: detection is the only way a session gets onto the dashboard at all. A
// harness that isn't recognised has no card, no transcript and no queue - it simply isn't
// there, with nothing anywhere reporting a problem.
//
// So these are driven off the registry (`src/server/harness/`) rather than written per
// agent: every claim below is made about EVERY declared harness, and a new one gets the
// same coverage by existing. The samples are the one thing a table can't invent - a regex
// can't produce a command line that matches it - so they live in a `Record<AgentType, …>`
// that does not compile until the new harness supplies real argv for itself.

/**
 * Real command lines, per harness. Observed in `ps`, not invented: this file is where a
 * guess about how a harness looks on the process table gets caught.
 */
interface DetectionSamples {
  /** The actual binary, however it disguises itself. Detected, and detected as NATIVE. */
  native: readonly string[];
  /** Launchers that merely run it. Detected, but never native - their cwd is not its cwd. */
  wrapped: readonly string[];
}

const SAMPLES: Record<AgentType, DetectionSamples> = {
  claude: {
    native: [
      "claude",
      "claude --resume",
      "/Users/me/.claude/local/claude",
      "/Users/me/.local/share/claude/versions/2.1.204 --session-id abc",
      "node /x/node_modules/@anthropic-ai/claude-code/cli.js",
    ],
    wrapped: [
      "/Applications/Xcode.app/Contents/Developer/usr/bin/make claude",
      "docker exec -it ctr zsh -lc claude",
    ],
  },
  codex: {
    native: [
      "codex",
      "/opt/homebrew/bin/codex",
      "node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    ],
    wrapped: ["sh -c codex", "make codex"],
  },
};

/** Every harness paired with its samples, which is what every table below walks. */
const CASES = allHarnesses().map((h) => ({ h, samples: SAMPLES[h.id] }));

// ---- the samples: what each harness actually looks like in `ps` ----

test("a real agent binary is detected, and detected as native", () => {
  for (const { h, samples } of CASES) {
    assert.ok(samples.native.length > 0, `${h.id} needs at least one real argv sample`);
    for (const command of samples.native) {
      assert.equal(classifyAgent(command), h.id, `should be ${h.id}: ${command}`);
      assert.equal(nativeAgent(command), h.id, `should be native ${h.id}: ${command}`);
    }
  }
});

test("a launcher is detected but is not the agent", () => {
  // The distinction `chooseAgentRoot` spends a whole comment on: `make claude` runs in the
  // repo you typed it in, while the agent it spawns runs in (and writes its transcript
  // under) a worktree. Picking the launcher as the session's representative process names
  // the card after the wrong directory.
  for (const { h, samples } of CASES) {
    for (const command of samples.wrapped) {
      assert.equal(classifyAgent(command), h.id, `should be ${h.id}: ${command}`);
      assert.equal(nativeAgent(command), null, `launcher is not native: ${command}`);
    }
  }
});

test("every background role a harness declares is not a session", () => {
  // Derived rather than sampled, so a role added to a spec is covered the moment it is
  // declared. The verbatim `ps` lines for Claude's five real forms - which is where a
  // guess about their SHAPE gets caught - live in `process-background-filter.test.ts`.
  for (const { h } of CASES) {
    const cmd = h.detect.commands[0]!;
    for (const sub of h.detect.background.subcommands) {
      const command = `/usr/local/bin/${cmd} ${sub} --whatever /tmp/x.sock`;
      assert.equal(classifyAgent(command), null, `not a session: ${command}`);
      assert.equal(nativeAgent(command), null, `not a session: ${command}`);
    }
    for (const flag of h.detect.background.flags) {
      const command = `/usr/local/bin/${cmd} ${flag} /tmp/x.sock 171 58`;
      assert.equal(classifyAgent(command), null, `not a session: ${command}`);
    }
  }
});

test("a background role named in PROSE is still a session", () => {
  // The property that cost two rewrites of this filter: a role token means what it means
  // in argv position and nowhere else. A dispatched session carries a state-dir path and a
  // ~1.2KB inline prompt on its command line, so anything reachable by a substring search
  // is reachable by an operator's directory name or by prompt prose - and a session that
  // fails this vanishes from the dashboard with no error anywhere.
  for (const { h } of CASES) {
    const cmd = h.detect.commands[0]!;
    const roles = [...h.detect.background.subcommands, ...h.detect.background.flags];
    for (const role of roles) {
      const command = `${cmd} -p Explain when ${role} is matched, and why only there`;
      assert.equal(classifyAgent(command), h.id, `prose is not a role: ${command}`);
    }
  }
});

// ---- the declarations: everything a harness says about itself must hold ----

test("every declared command is detected, bare and path-qualified", () => {
  for (const { h } of CASES) {
    assert.ok(h.detect.commands.length > 0, `${h.id} must declare a command name`);
    for (const name of h.detect.commands) {
      for (const command of [name, `${name} --resume`, `/usr/local/bin/${name} --flag`]) {
        assert.equal(nativeAgent(command), h.id, `should be native ${h.id}: ${command}`);
      }
    }
  }
});

test("every declared argv signature is detected as native", () => {
  // A signature exists to see through a re-exec or a node shim, where the harness's own
  // name is nowhere in argv0 - so it has to hold with an unrelated argv0 in front of it.
  for (const { h } of CASES) {
    for (const sig of h.detect.argvSignatures) {
      const command = `node /opt/x${sig}/entry --flag`;
      assert.equal(nativeAgent(command), h.id, `should be native ${h.id}: ${command}`);
    }
  }
});

test("a bare command name counts only under a known wrapper", () => {
  for (const { h } of CASES) {
    for (const name of h.detect.commands) {
      for (const wrapper of ["make", "sh -c", "docker exec -it ctr zsh -lc", "sudo"]) {
        assert.equal(classifyAgent(`${wrapper} ${name}`), h.id, `${wrapper} ${name}`);
      }
      // The reason the wrapper list exists: a command that merely mentions the agent.
      assert.equal(classifyAgent(`git commit -m "fix ${name} bug"`), null, name);
      assert.equal(classifyAgent(`vim ${name}.md`), null, name);
      assert.equal(classifyAgent(`rg ${name} src`), null, name);
    }
  }
});

test("no two harnesses answer to the same command name", () => {
  // Detection walks the registry in order, so an overlap would silently resolve every
  // session of one harness to whichever was declared first.
  const seen = new Map<string, AgentType>();
  for (const { h } of CASES) {
    for (const name of h.detect.commands) {
      const other = seen.get(name);
      assert.equal(other, undefined, `${h.id} and ${other} both claim "${name}"`);
      seen.set(name, h.id);
    }
  }
});

test("ordinary processes are not agents", () => {
  for (const command of ["zsh", "node server.js", "/usr/bin/ssh host", ""]) {
    assert.equal(classifyAgent(command), null, command);
    assert.equal(nativeAgent(command), null, command);
  }
});
