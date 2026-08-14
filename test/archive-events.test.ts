import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The invalidation event's two ends.
 *
 * `ServerEvent` is exhaustive across the daemon and the browser, and `test/session-contracts`
 * already proves that a variant the hook does not handle fails typecheck. What that cannot
 * see is the SHAPE of the handling: a counter that is bumped on the event but not on
 * reconnect compiles perfectly and silently leaves a page showing whatever it had before the
 * stream dropped, because archive history rides no snapshot to restore it.
 */

const hook = readFileSync(new URL("../src/web/useEventStream.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");
const registry = readFileSync(new URL("../src/server/registry.ts", import.meta.url), "utf8");

test("the invalidation event exists on the wire and carries no history", () => {
  assert.match(types, /\|\s*\{\s*type:\s*"archive_changed"\s*\}/);
  assert.equal(
    /type:\s*"archive_changed";/.test(types),
    false,
    "the frame must stay content-free - a library is unbounded and must not ride the stream",
  );
  assert.match(registry, /emitArchiveChanged\(\): void \{\s*\n\s*this\.emitEvent\(\{ type: "archive_changed" \}\);/);
});

test("the browser reduces it into a revision, bumped on the event AND on reconnect", () => {
  assert.match(hook, /case "archive_changed":/);
  assert.match(hook, /const \[archivesRevision, setArchivesRevision\] = useState\(0\);/);
  assert.match(hook, /archivesRevision: number;/);
  // Two separate bumps: one inside `es.onopen`, one inside the switch.
  const bumps = hook.match(/setArchivesRevision\(\(n\) => n \+ 1\);/g) ?? [];
  assert.equal(bumps.length, 2, "reconnect and the event must each raise the revision");
  const onOpen = hook.slice(hook.indexOf("es.onopen"), hook.indexOf("es.onerror"));
  assert.match(onOpen, /setArchivesRevision/, "regaining the stream must re-read, since no snapshot restores this");
  assert.match(hook, /\n    archivesRevision,\n/, "the revision must reach consumers of the hook");
});

test("the reducer stays exhaustive", () => {
  assert.match(hook, /const unhandled: never = msg;/);
});

test("no archive history enters the snapshot or starts a poller", () => {
  // A FIELD rather than a mention: the snapshot's prose legitimately says "archived" about
  // other catalogs (a retired SessionAction, a retired schedule), and matching on the word
  // would fail on those while still missing a collection called something else. What must
  // never appear is a member carrying bundles.
  const snapshot = types.slice(types.indexOf('type: "snapshot"'));
  assert.equal(
    /\n\s*archives\??:/.test(snapshot.slice(0, snapshot.indexOf("};"))),
    false,
    "the snapshot event must not grow an archive collection",
  );
  assert.equal(hook.includes("/api/archives"), false, "the event-stream hook never fetches");
});
