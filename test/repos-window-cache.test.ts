import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { REPO_INDEX_IDENTITY_HEADER, REPOS_SCANNED_AT_HEADER } from "../src/shared/repo-index.ts";

/**
 * The window's repository list behind the Dispatch Repo picker (`fetchRepos` and
 * `cachedRepos` in `src/web/lib/api.ts`). A picker opens on it before it asks the daemon, so
 * what it holds after a failed, late, or out-of-date answer is what the operator can pick.
 *
 * Every case loads its own module instance: the list is module state, and a case that
 * inherited another's would prove nothing about its own sequence.
 */
type Api = typeof import("../src/web/lib/api.ts");
let instance = 0;
async function freshApi(): Promise<Api> {
  instance += 1;
  return await import(`../src/web/lib/api.ts?window-${instance}`) as Api;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Reply = () => Response | Promise<Response>;

/** Answer each `/api/repos` request with the next scripted reply, recording what was asked. */
function scriptFetch(replies: Reply[]): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    const reply = replies.shift();
    if (!reply) throw new Error(`unscripted request ${String(input)}`);
    return await reply();
  }) as typeof fetch;
  return asked;
}

function list(repos: string[], scannedAt?: number, identity = "index-a"): Reply {
  return () => new Response(JSON.stringify(repos), {
    status: 200,
    headers: {
      "content-type": "application/json",
      [REPO_INDEX_IDENTITY_HEADER]: identity,
      ...(scannedAt === undefined ? {} : { [REPOS_SCANNED_AT_HEADER]: String(scannedAt) }),
    },
  });
}
const serverError: Reply = () => new Response("boom", { status: 500 });
const notAList: Reply = () => new Response(JSON.stringify({ error: "nope" }), { status: 200 });
const refused: Reply = () => {
  throw new TypeError("Failed to fetch");
};

test("a failed read with no list held answers empty, and holds nothing", async () => {
  const api = await freshApi();
  scriptFetch([serverError, notAList, refused]);
  assert.deepEqual(await api.fetchRepos(), []);
  assert.deepEqual(await api.fetchRepos(), []);
  assert.deepEqual(await api.fetchRepos({ rescan: true }), []);
  assert.equal(api.cachedRepos(), null, "a failure is never cached as an empty list");
});

test("every kind of failed read answers with the list already held", async () => {
  const api = await freshApi();
  scriptFetch([list(["/w/alpha", "/w/beta"], 100), serverError, notAList, refused]);
  assert.deepEqual(await api.fetchRepos(), ["/w/alpha", "/w/beta"]);
  for (const kind of ["a 500", "a body that is not a list", "a refused connection"]) {
    assert.deepEqual(
      await api.fetchRepos({ rescan: true }),
      ["/w/alpha", "/w/beta"],
      `${kind} leaves the picker selectable`,
    );
  }
  assert.deepEqual(api.cachedRepos(), ["/w/alpha", "/w/beta"]);
});

test("a late answer from an older scan never replaces a newer list", async () => {
  const api = await freshApi();
  // Dispatch sends both reads at once. The rescan lands first with a new clone; the
  // ordinary one, answered from the scan before it, lands after.
  let releaseOrdinary!: () => void;
  const ordinaryHeld = new Promise<void>((resolve) => {
    releaseOrdinary = resolve;
  });
  const asked = scriptFetch([
    async () => {
      await ordinaryHeld;
      return list(["/w/alpha"], 100)();
    },
    list(["/w/alpha", "/w/new-clone"], 200),
  ]);
  const ordinary = api.fetchRepos();
  const fresh = await api.fetchRepos({ rescan: true });
  assert.deepEqual(asked, ["/api/repos", "/api/repos?rescan=1"]);
  assert.deepEqual(fresh, ["/w/alpha", "/w/new-clone"]);

  releaseOrdinary();
  assert.deepEqual(await ordinary, ["/w/alpha", "/w/new-clone"], "the caller is handed the newer list");
  assert.deepEqual(api.cachedRepos(), ["/w/alpha", "/w/new-clone"], "the next open starts from it");
});

test("a newer scan replaces the list, whichever read brought it", async () => {
  const api = await freshApi();
  scriptFetch([list(["/w/alpha"], 100), list(["/w/alpha", "/w/beta"], 150)]);
  await api.fetchRepos({ rescan: true });
  assert.deepEqual(await api.fetchRepos(), ["/w/alpha", "/w/beta"]);
  assert.deepEqual(api.cachedRepos(), ["/w/alpha", "/w/beta"]);
});

test("an answer stamped no later than the held list does not replace it", async () => {
  const api = await freshApi();
  scriptFetch([list(["/w/alpha", "/w/beta"], 200), list(["/w/alpha"], 200), list(["/w/alpha"], 150)]);
  await api.fetchRepos({ rescan: true });
  assert.deepEqual(await api.fetchRepos(), ["/w/alpha", "/w/beta"], "an equal stamp is the same scan");
  assert.deepEqual(await api.fetchRepos(), ["/w/alpha", "/w/beta"], "an earlier stamp is an older scan");
  assert.deepEqual(api.cachedRepos(), ["/w/alpha", "/w/beta"]);
});

test("changing the indexed directories forgets the list, and drops a read sent before it", async () => {
  const api = await freshApi();
  let releaseOld!: () => void;
  const oldHeld = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  scriptFetch([
    list(["/old/alpha"], 100),
    async () => {
      await oldHeld;
      return list(["/old/alpha"], 300)();
    },
    // The Settings write itself.
    () => new Response(JSON.stringify({ ok: true, directories: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ]);
  assert.deepEqual(await api.fetchRepos(), ["/old/alpha"]);
  const inFlight = api.fetchRepos();

  await api.api.setRepoIndex({ directories: [{ path: "/new" }] });
  assert.equal(api.cachedRepos(), null, "a picker opened now cannot offer a removed directory's repo");

  releaseOld();
  assert.deepEqual(await inFlight, [], "an answer for the old directories is not handed back");
  assert.equal(api.cachedRepos(), null, "nor is it cached for the next open");
});

test("a reconnect naming the same index keeps the list; one naming another index drops it", async () => {
  const api = await freshApi();
  scriptFetch([list(["/w/alpha"], 100, "index-a")]);
  await api.fetchRepos();
  let drops = 0;
  const stop = api.onCachedReposDropped(() => {
    drops += 1;
  });
  try {
    // The common reconnect under load: nothing changed, so the picker keeps what it has.
    api.noteRepoIndexIdentity("index-a");
    assert.deepEqual(api.cachedRepos(), ["/w/alpha"]);
    assert.equal(drops, 0);

    // A window that missed `repo_index_changed` while disconnected learns of it here.
    api.noteRepoIndexIdentity("index-b");
    assert.equal(api.cachedRepos(), null, "a list for directories no longer indexed is dropped");
    assert.equal(drops, 1, "an open picker is told, so it stops offering the list too");
  } finally {
    stop();
  }
});

test("a list for a different index replaces the held one whatever its stamp", async () => {
  const api = await freshApi();
  // The new index's scan can carry a lower stamp than the old one (a restarted daemon on a
  // clock that moved back); the stamp orders scans of ONE index, never across two.
  scriptFetch([list(["/old/alpha"], 500, "index-a"), list(["/new/beta"], 100, "index-b")]);
  await api.fetchRepos();
  assert.deepEqual(await api.fetchRepos({ rescan: true }), ["/new/beta"]);
  assert.deepEqual(api.cachedRepos(), ["/new/beta"]);
});

test("forgetting the list tells every listener, and an unsubscribed one no longer hears it", async () => {
  const api = await freshApi();
  const heard: string[] = [];
  const stopA = api.onCachedReposDropped(() => heard.push("a"));
  const stopB = api.onCachedReposDropped(() => heard.push("b"));
  api.forgetCachedRepos();
  stopA();
  api.forgetCachedRepos();
  stopB();
  assert.deepEqual(heard, ["a", "b", "b"]);
});

/** A reply held until the returned release is called, answering `reply` then. */
function heldReply(reply: Reply): { reply: Reply; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reply: async () => { await held; return await reply(); }, release };
}

test("a first load in flight when another window changes the directories is not shown", async () => {
  const api = await freshApi();
  // The boot snapshot names index A; no list is held yet.
  api.noteRepoIndexIdentity("index-a");
  const first = heldReply(list(["/removed/alpha"], 100, "index-a"));
  scriptFetch([first.reply]);
  let drops = 0;
  const stop = api.onCachedReposDropped(() => {
    drops += 1;
  });
  try {
    const opening = api.fetchRepos();
    // Another window removes the directory while that read is still out.
    api.noteRepoIndexIdentity("index-b");
    assert.equal(drops, 1, "an open picker is told to ask again, though it held no list");
    first.release();
    assert.deepEqual(await opening, [], "the answer for the directories that were is dropped");
    assert.equal(api.cachedRepos(), null, "and never cached for the next open");
  } finally {
    stop();
  }
});

test("an answer for an index other than the announced one is refused, even with no list held", async () => {
  const api = await freshApi();
  const first = heldReply(list(["/removed/alpha"], 100, "index-a"));
  scriptFetch([first.reply, list(["/kept/beta"], 200, "index-b")]);
  // Sent before the window has heard of any index (the stream is still connecting).
  const opening = api.fetchRepos();
  // The first announcement already names the new index.
  api.noteRepoIndexIdentity("index-b");
  first.release();
  assert.deepEqual(await opening, []);
  assert.equal(api.cachedRepos(), null);
  // A read for the announced index is taken.
  assert.deepEqual(await api.fetchRepos({ rescan: true }), ["/kept/beta"]);
});

test("the window that saves takes its new index before its own announcement arrives", async () => {
  const api = await freshApi();
  api.noteRepoIndexIdentity("index-a");
  scriptFetch([
    list(["/old/alpha"], 100, "index-a"),
    () => new Response(JSON.stringify({ ok: true, directories: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    list(["/new/beta"], 200, "index-b"),
  ]);
  await api.fetchRepos();
  await api.api.setRepoIndex({ directories: [{ path: "/new" }] });
  // `repo_index_changed` for index B has not landed yet; the answer is still taken.
  assert.deepEqual(await api.fetchRepos({ rescan: true }), ["/new/beta"]);
  // When it lands it matches, so the list stays.
  api.noteRepoIndexIdentity("index-b");
  assert.deepEqual(api.cachedRepos(), ["/new/beta"]);
});
