import type { Page } from "@playwright/test";
import { expect, test as base } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { createTestAuthority, type TestAuthority } from "../fixtures/tls-authority.ts";
import { startModelServer, type ModelServer } from "../fixtures/voice.ts";

// The speech model download behind a TLS-inspecting proxy, end to end. The model stand-in is served
// over HTTPS with a chain whose root is a throwaway authority, the way a corporate proxy re-signs
// Hugging Face. Where that root lives is the whole difference:
//
// - In no store, Download reads the operator's original error: "self-signed certificate in
//   certificate chain".
// - Only in the operating system's store, with no NODE_EXTRA_CA_CERTS (the daemon a Finder or
//   LaunchAgent launch starts), Download verifies. That holds only because the daemon adds the
//   system store to its default roots at startup (`system-trust-startup.ts`).
//
// The second case runs on Linux, where the system store is OpenSSL's and `SSL_CERT_FILE` names it.
// On macOS the system store is the keychain, which a spec cannot change.

type TrustRoot = "nowhere" | "system store";

const test = base.extend<{ trustRoot: TrustRoot; authority: TestAuthority; models: ModelServer }>({
  trustRoot: ["nowhere", { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
  authority: async ({}, use) => {
    const authority = createTestAuthority();
    try {
      await use(authority);
    } finally {
      authority.dispose();
    }
  },
  models: async ({ authority }, use) => {
    const models = await startModelServer({ tls: { key: authority.key, cert: authority.chain } });
    try {
      await use(models);
    } finally {
      await models.close();
    }
  },
  daemonEnv: async ({ models, authority, trustRoot }, use) => {
    await use({
      ...models.env,
      // Empty is unset to Node: the proxy root never arrives the way a shell profile would put it.
      NODE_EXTRA_CA_CERTS: "",
      ...(trustRoot === "system store" ? { SSL_CERT_FILE: authority.caPath } : {}),
    });
  },
});

const MODEL_ROW = "dependency-voice-model";

async function put(daemon: DaemonHandle, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `PUT ${path}`).toBe(true);
}

async function openVoiceSetup(page: Page, daemon: DaemonHandle): Promise<void> {
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"]) {
    await put(daemon, "/api/feature-flags", { kind: "flag", id, enabled: true });
  }
  await put(daemon, "/api/voice/config", { backend: "fluidaudio" });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "voice");
  await expectRowStatus(page, MODEL_ROW, "Missing");
}

test("a proxy root in no trust store reads as the certificate error, with Retry", async ({ dashboard: page, daemon, models }) => {
  await openVoiceSetup(page, daemon);
  const row = setupRow(page, MODEL_ROW);

  await row.getByRole("button", { name: "Download" }).click();

  await expectRowStatus(page, MODEL_ROW, "Needs setup");
  await expect(row).toContainText(/could not start: fetch failed \(self[- ]signed certificate in certificate chain\)/);
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(models.requests).toEqual([]);
});

test.describe("a proxy root only in the system store", () => {
  test.use({ trustRoot: "system store" });
  test.skip(process.platform === "darwin", "the macOS system store is the keychain, which a spec cannot change");

  test("downloads and verifies the model", async ({ dashboard: page, daemon, models }) => {
    await openVoiceSetup(page, daemon);
    const row = setupRow(page, MODEL_ROW);

    await row.getByRole("button", { name: "Download" }).click();

    await expectRowStatus(page, MODEL_ROW, "Ready");
    await expect(row).toContainText(`voice/models/fluidaudio/${models.manifest.revision} · checksum verified`);
    await expect(row).not.toContainText("certificate");
    expect(models.requests.length).toBeGreaterThan(0);
  });
});
