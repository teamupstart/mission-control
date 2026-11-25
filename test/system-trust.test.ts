import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("adds the system store to the default roots without dropping any", () => {
  const api = fakeTls({ default: ["bundled", "extra-from-env"], system: ["corporate-proxy-root"] });
  assert.equal(trustSystemCertificates(api), "trusted");
  assert.deepEqual(api.set, [["bundled", "extra-from-env", "corporate-proxy-root"]]);
});

test("a root already in the defaults, as under --use-system-ca, is not added twice", () => {
  const api = fakeTls({ default: ["bundled", "corporate-proxy-root"], system: ["corporate-proxy-root"] });
  assert.equal(trustSystemCertificates(api), "trusted");
  assert.deepEqual(api.set, [["bundled", "corporate-proxy-root"]]);
});

test("a Node without the API keeps its default roots", () => {
  assert.equal(trustSystemCertificates({}), "unsupported");
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

test("the daemon installs system trust before any subsystem starts", () => {
  const source = readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const trust = source.indexOf("\ntrustSystemCertificates();");
  const firstStartup = source.indexOf("\nawait initializeExecutableEnvironment();");
  assert.ok(trust > 0, "index.ts calls trustSystemCertificates()");
  assert.ok(trust < firstStartup, "system trust is installed before the executable environment and the database");
});
