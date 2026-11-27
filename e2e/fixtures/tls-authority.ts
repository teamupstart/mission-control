import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-root.mjs";

/**
 * A throwaway certificate authority and a loopback server certificate it signed, standing in for a
 * TLS-inspecting proxy's root. The root is in no store until a spec puts it in one, so a daemon
 * reaching a server that presents `chain` fails exactly the way an operator behind such a proxy
 * did: `self-signed certificate in certificate chain`.
 *
 * Made with the `openssl` CLI, which macOS and the Linux runners ship. Valid for one day.
 */
export interface TestAuthority {
  /** The root alone, PEM, for a spec to place in a trust store. */
  caPath: string;
  /** The server key and the leaf-then-root chain it presents, PEM. */
  key: string;
  chain: string;
  dispose(): void;
}

export function createTestAuthority(): TestAuthority {
  const dir = tempDir("mission-e2e-tls-");
  const at = (name: string) => join(dir, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Mission Control E2E Proxy Root", "-keyout", at("ca.key"), "-out", at("ca.pem"));
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", at("leaf.key"), "-out", at("leaf.csr"));
  writeFileSync(at("leaf.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  openssl("x509", "-req", "-days", "1", "-in", at("leaf.csr"), "-CA", at("ca.pem"), "-CAkey", at("ca.key"), "-CAcreateserial", "-extfile", at("leaf.ext"), "-out", at("leaf.pem"));
  const ca = readFileSync(at("ca.pem"), "utf8");
  return {
    caPath: at("ca.pem"),
    key: readFileSync(at("leaf.key"), "utf8"),
    chain: readFileSync(at("leaf.pem"), "utf8") + ca,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
