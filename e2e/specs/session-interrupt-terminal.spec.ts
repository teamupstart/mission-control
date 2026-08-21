import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * What is at stake: the half of the interrupt gesture that phase 1 could not ship.
 *
 * `session-interrupt.spec.ts` proves ⌃C stops an Agent SDK turn, where the mechanism is a
 * driver method and the driver answers. This spec proves the OTHER mechanism, and the thing
 * that makes it a separate risk is that the byte is different from the gesture. The operator
 * presses ⌃C; what must reach the pane is `Escape`. Forwarding the literal ⌃C would clear
 * the TUI's input line and, pressed twice, quit the CLI - destroying the session the key was
 * meant to interrupt.
 *
 * Nothing above the pane can tell those two apart. The route returns 200 either way, the
 * card leaves `working` either way, and a build that sent ⌃C would pass every assertion a
 * browser can make. So the load-bearing assertion here is on the BYTES that arrived on the
 * far side of a real pty: exactly one 0x1B.
 *
 * ## Why this spec is built differently from every other one in the suite
 *
 * A terminal-runtime session cannot be dispatched into existence. `runtime: "terminal"` is
 * stamped in exactly one place - `registry.ts:mergeDiscovered` - so passive discovery is the
 * only door, and the suite turns discovery off for every other file (`MISSION_POLL_MS: "0"`,
 * `daemon.ts`) because a machine-wide sweep adopts whatever agents the developer happens to
 * be running. This file turns it back on for its own daemon, which is the only way to
 * exercise the path at all, and pays for it by never asserting on the fleet as a whole: it
 * addresses its own card by the tmux session name it generated, and touches nothing else.
 *
 * The agent in the pane is a symlink to `node` NAMED `claude`, which is not a trick played
 * on the detector but the shape it is built to recognise - `harnessOf` matches argv0's
 * basename against each harness's declared `detect.commands`. It reads its pty raw and
 * appends every byte it receives to a file. That file is the assertion surface, and it is
 * the terminal-runtime counterpart of reading the fake multiplexer's recorded argv.
 *
 * Real tmux, because tmux is the one multiplexer with no binary override (`TMUX_BIN` has
 * `env: null`), so it cannot be faked the way `CMUX_BIN` is - and because a real pty is what
 * makes "one 0x1B arrived" a fact about the product rather than about a fixture. CI installs
 * it for this file.
 */

/** Discovery, on and brisk - this file's daemon only. See the header for why that is safe. */
test.use({ daemonEnv: { MISSION_POLL_MS: "400" } });

const INTERRUPT = "Control+c";
const EVIDENCE = artifactsDir("session-interrupt-terminal");
/** Long enough for two sweeps at the cadence above, short enough to fail rather than hang. */
const DISCOVERY_TIMEOUT = 20_000;

function tmux(args: string[]): void {
  execFileSync("tmux", args, { stdio: "pipe" });
}

/**
 * The pane-side agent: raw stdin, every byte appended as hex, and it never exits on its own.
 *
 * Raw mode is the point - a cooked pty would let the line discipline eat or transform what
 * arrives, and the claim being tested is about the exact byte.
 */
const PANE_AGENT = `
import { appendFileSync, writeFileSync } from "node:fs";
const log = process.argv[2];
writeFileSync(log, "");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (buf) => {
  appendFileSync(log, [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ") + "\\n");
});
setInterval(() => {}, 1 << 30);
`;

interface Pane {
  session: string;
  bytes: () => string;
  cleanup: () => void;
}

/**
 * A real tmux session running something the daemon will discover as a Claude session.
 *
 * The session name is unique per test so a parallel worker's pane, or a stray one from an
 * earlier run, can never be the card this spec drives.
 */
function startPane(): Pane {
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-esc-pane-"));
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  // argv0's basename is what `harnessOf` matches, so the LINK's name is the whole disguise.
  symlinkSync(execPath, join(bin, "claude"));
  const script = join(dir, "agent.mjs");
  const log = join(dir, "bytes.log");
  writeFileSync(script, PANE_AGENT);

  const session = `mc-e2e-esc-${process.pid}-${Date.now()}`;
  tmux([
    "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", dir,
    `${join(bin, "claude")} ${script} ${log}`,
  ]);

  return {
    session,
    bytes: () => {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return "";
      }
    },
    cleanup: () => {
      spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Skipped rather than failed when tmux is absent, so a contributor without it is not blocked
 * by a spec about someone else's multiplexer. CI installs tmux for this suite, which is what
 * stops the skip from quietly turning this file into decoration - the place that guarantee
 * lives is `.github/workflows/ci.yml`, and it is the reason this is a `skip` and not a
 * silent `return`.
 */
const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;

test.describe("terminal-runtime interrupt", () => {
  test.skip(tmuxMissing, "tmux is not installed on this machine");

  let pane: Pane | undefined;
  test.afterEach(() => {
    pane?.cleanup();
    pane = undefined;
  });

  test("Ctrl+C writes Escape into the pane, and not the operator's Ctrl+C", async ({
    dashboard,
  }) => {
    pane = startPane();

    // Find OUR card, by the tmux session name we just generated. Never "the only card":
    // discovery is on, so the developer's own agents are on this fleet too.
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: pane.session });
    await expect(row).toHaveCount(1, { timeout: DISCOVERY_TIMEOUT });

    // Nothing has been typed into that pane yet, which is what makes the byte assertion at
    // the end unambiguous.
    expect(pane.bytes()).toBe("");

    // Select the card, so the action bar the chord dispatches through is mounted.
    await row.click();
    await expect(row).toHaveClass(/selected/);
    const detail = dashboard.locator(".console-detail");
    // The runtime is the precondition of the whole spec, and the Console detail states it
    // by naming the pane it is bound to - `tmux · %<id>`, where an Agent SDK detail says
    // "Agent SDK". Asserted rather than assumed so this cannot become a weaker driver test.
    await expect(detail).toContainText(/tmux · %\d+/);

    // The control is live - this is the capability declaration doing its job. Before this
    // phase the same card drew it disabled with "can't yet stop a Claude Code turn running
    // in a terminal".
    const interrupt = detail.getByRole("button", { name: "interrupt" });
    await expect(interrupt).toBeEnabled();

    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      // Off every control first: a resting pointer portals a tooltip over the row.
      await dashboard.mouse.move(0, 0);
      await detail.screenshot({ path: `${EVIDENCE}terminal-detail-interrupt-enabled.png` });
    }

    await dashboard.keyboard.press(INTERRUPT);

    // THE assertion. One 0x1B, on the far side of a real pty.
    //
    // `03` is what a forwarded Ctrl+C would look like and is called out by name, because
    // that build is the one this spec exists to fail: it would satisfy every other
    // assertion here and then quit the operator's agent on the second press.
    await expect
      .poll(() => pane!.bytes(), {
        message: "a bare ESC should have reached the pane's pty",
        timeout: 10_000,
      })
      .toBe("1b\n");
    expect(pane.bytes(), "a literal Ctrl+C (0x03) must never reach a TUI").not.toContain("03");
  });
});
