import assert from "node:assert/strict";
import test from "node:test";
import { trustSystemCertificates, type SystemTrustApi } from "../src/server/system-trust.ts";

function fakeTls(roots: { default: string[]; system: string[] }): SystemTrustApi & { set: string[][] } {
  const set: string[][] = [];
  return {
    set,
    getCACertificates: (type) => [...roots[type]],
    setDefaultCACertificates: (certs) => {
      set.push(certs);
    },
  };
}

test("adds the system store to the default roots without dropping any, and says how many", (t) => {
  const log = t.mock.method(console, "log", () => undefined);
  const api = fakeTls({ default: ["bundled", "extra-from-env"], system: ["corporate-proxy-root"] });
  assert.equal(trustSystemCertificates(api), "trusted");
  assert.deepEqual(api.set, [["bundled", "extra-from-env", "corporate-proxy-root"]]);
  assert.equal(log.mock.calls[0]?.arguments[0], "[tls] added 1 root(s) from the system certificate store");
});

test("a root already in the defaults, as under --use-system-ca, is not added or counted twice", (t) => {
  const log = t.mock.method(console, "log", () => undefined);
  const api = fakeTls({ default: ["bundled", "corporate-proxy-root"], system: ["corporate-proxy-root"] });
  assert.equal(trustSystemCertificates(api), "trusted");
  assert.deepEqual(api.set, [["bundled", "corporate-proxy-root"]]);
  assert.equal(log.mock.calls[0]?.arguments[0], "[tls] added 0 root(s) from the system certificate store");
});

test("a Node without the API keeps its default roots and says the system store was not added", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  assert.equal(trustSystemCertificates({}), "unsupported");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /^\[tls\] the system certificate store was not added: Node \S+ lacks/);
});

test("an unreadable system store does not stop the daemon", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const api: SystemTrustApi = {
    getCACertificates: (type) => {
      if (type === "system") throw new Error("keychain locked");
      return ["bundled"];
    },
    setDefaultCACertificates: () => assert.fail("roots must stay untouched"),
  };
  assert.equal(trustSystemCertificates(api), "failed");
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /keychain locked/);
});
