/**
 * What is at stake: a link that says it opened when it did not.
 *
 * `openExternalUrl` is the first renderer caller `missionDesktop.openExternal` has ever had,
 * and the bridge is backed by `shell.openExternal` in main - whose promise rejects on a
 * malformed URL or a scheme with no registered handler. A caller that fired and forgot would
 * both report success over a link that never opened and leave an unhandled rejection behind
 * it, so the contract is that this REJECTS and the context menu routes the failure into the
 * same notice `Paste` uses.
 *
 * The browser arm is here for a different reason: it is what every non-desktop operator gets,
 * and the e2e spec cannot reach it, because that spec has to stub the desktop bridge to assert
 * anything about the desktop path at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openExternalUrl } from "../src/web/lib/desktop.ts";

test("the desktop bridge is preferred, and the app window never navigates", async () => {
  const opened: string[] = [];
  const windowOpens: string[] = [];
  await openExternalUrl("https://example.test/run/9", {
    desktop: {
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
    open: (url) => {
      windowOpens.push(url);
      return null;
    },
  });
  assert.deepEqual(opened, ["https://example.test/run/9"]);
  assert.deepEqual(windowOpens, [], "the shell owns this, so the tab must not also be opened");
});

test("a shell that refuses reaches the caller instead of the console", async () => {
  await assert.rejects(
    openExternalUrl("mailto:nobody", {
      desktop: { openExternal: () => Promise.reject(new Error("No application knows how")) },
    }),
    /No application knows how/,
  );
});

test("a browser tab opens a new tab, and never hands it a handle back", async () => {
  const calls: Array<[string, string, string]> = [];
  await openExternalUrl("https://example.test/docs", {
    desktop: null,
    open: (url, target, features) => {
      calls.push([url, target, features]);
      return null;
    },
  });
  // `noopener` is why this arm cannot report a blocked popup - it makes `window.open` return
  // null on success too - and it is also why that is the right trade: without it the opened
  // page would hold a reference to the dashboard.
  assert.deepEqual(calls, [["https://example.test/docs", "_blank", "noopener"]]);
});

test("nowhere to open from is an error, not a silent no-op", async () => {
  await assert.rejects(openExternalUrl("https://example.test", { desktop: null, open: null }));
});
