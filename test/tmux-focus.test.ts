import { test } from "node:test";
import assert from "node:assert/strict";
import { findSessionHostPane, weztermEnv, type WeztermPane } from "../src/server/discovery/wezterm.ts";

function pane(paneId: number, tabId: number, tty: string | null): WeztermPane {
  return {
    paneId,
    tabId,
    windowId: 0,
    tabTitle: "",
    windowTitle: "",
    cwd: "",
    tty,
    isActive: true,
  };
}

// tmux reports client ttys as "/dev/ttysNN"; wezterm strips the "/dev/".
const clients = [
  { tty: "/dev/ttys004", session: "cyc-1" },
  { tty: "/dev/ttys019", session: "cyc-1" },
  { tty: "/dev/ttys020", session: "AI2" },
];
const panes = [
  pane(2, 1, "ttys004"), // hosts cyc-1
  pane(17, 9, "ttys020"), // hosts AI2
  pane(19, 10, "ttys022"), // hosts nothing tmux
];

test("findSessionHostPane: matches the wezterm pane hosting the session's client", () => {
  assert.equal(findSessionHostPane("AI2", clients, panes)?.paneId, 17);
});

test("findSessionHostPane: returns the first host when a session has several clients", () => {
  // cyc-1 has two clients (ttys004, ttys019) but only ttys004 maps to a pane.
  assert.equal(findSessionHostPane("cyc-1", clients, panes)?.tabId, 1);
});

test("findSessionHostPane: returns null when no tab hosts the session", () => {
  // Session is attached, but its client's tty isn't a wezterm pane.
  const detached = [{ tty: "/dev/ttys099", session: "loner" }];
  assert.equal(findSessionHostPane("loner", detached, panes), null);
});

test("findSessionHostPane: returns null when the session has no client at all", () => {
  assert.equal(findSessionHostPane("ghost", clients, panes), null);
});

test("findSessionHostPane: ignores panes with no tty", () => {
  const withNullTty = [pane(5, 3, null), ...panes];
  assert.equal(findSessionHostPane("AI2", clients, withNullTty)?.paneId, 17);
});

test("weztermEnv drops an inherited (possibly stale) WEZTERM_UNIX_SOCKET", () => {
  // Launched-from-a-wezterm-pane daemon inherits a socket pinned to that pane's
  // GUI; if that GUI later restarts the socket goes stale and every `wezterm cli`
  // call fails, so all wezterm tabs fall back to `claude <pid>` names. Stripping
  // the var lets wezterm resolve its live default socket.
  const env = weztermEnv({
    WEZTERM_UNIX_SOCKET: "/Users/x/.local/share/wezterm/gui-sock-79736",
    PATH: "/usr/bin",
  });
  assert.equal(env.WEZTERM_UNIX_SOCKET, undefined);
  assert.equal(env.PATH, "/usr/bin"); // other vars pass through untouched
});

test("weztermEnv is a no-op when no socket is inherited", () => {
  const env = weztermEnv({ PATH: "/usr/bin" });
  assert.equal(env.WEZTERM_UNIX_SOCKET, undefined);
  assert.equal(env.PATH, "/usr/bin");
});
