import { createHash } from "node:crypto";
import {
  canonicalSettingsBackupJson,
  SettingsBackupCountsSchema,
  SettingsBackupEnvelopeBodyV1Schema,
  type SettingsBackupEnvelopeBodyV1,
  type SettingsBackupEnvelopeV1,
} from "@shared/settings-backups.ts";
import { SETTINGS_BACKUP_CATALOGS, parseSettingsCatalogPayload } from "./catalogs.ts";
import {
  SETTINGS_CONFIG_BACKUP_ENTRIES,
  parseSettingPayload,
} from "./config-registry.ts";

export function settingsBackupDigest(body: SettingsBackupEnvelopeBodyV1): string {
  return createHash("sha256").update(canonicalSettingsBackupJson(body), "utf8").digest("hex");
}

export function createSettingsBackupEnvelope(
  value: SettingsBackupEnvelopeBodyV1,
): SettingsBackupEnvelopeV1 {
  const body = SettingsBackupEnvelopeBodyV1Schema.parse(value);
  return { ...body, digest: settingsBackupDigest(body) };
}

export function settingsBackupFileText(snapshot: SettingsBackupEnvelopeV1): string {
  return `${canonicalSettingsBackupJson(snapshot)}\n`;
}

/** Validate every registered v1 domain and the redundant catalog counts. */
export function validateSettingsBackupDomains(snapshot: SettingsBackupEnvelopeV1): void {
  const configByDomain = new Map(SETTINGS_CONFIG_BACKUP_ENTRIES.map((entry) => [
    entry.backupDomain,
    entry,
  ]));
  const catalogDomains = new Set(SETTINGS_BACKUP_CATALOGS.map((entry) => entry.domain));
  const expectedDomains = new Set([
    ...configByDomain.keys(),
    ...catalogDomains,
  ]);

  for (const entry of snapshot.domains) {
    if (!expectedDomains.delete(entry.domain)) {
      throw new TypeError(`Snapshot contains an unregistered domain: ${entry.domain}`);
    }
    const config = configByDomain.get(entry.domain);
    if (config) parseSettingPayload(config, entry.payload);
    else parseSettingsCatalogPayload(entry.domain, entry.payload);
  }
  if (expectedDomains.size > 0) {
    throw new TypeError(`Snapshot is missing domains: ${[...expectedDomains].join(", ")}`);
  }

  const payloadLength = (domain: string): number => {
    const value = snapshot.domains.find((entry) => entry.domain === domain)?.payload;
    return Array.isArray(value) ? value.length : -1;
  };
  SettingsBackupCountsSchema.parse(snapshot.counts);
  const actual = {
    personas: payloadLength("personas"),
    sessionActions: payloadLength("session-actions"),
    workflowCommands: payloadLength("workflow-commands"),
    workflowDefinitions: payloadLength("workflow-definitions"),
    workflowVersions: payloadLength("workflow-versions"),
  };
  if (canonicalSettingsBackupJson(actual) !== canonicalSettingsBackupJson(snapshot.counts)) {
    throw new TypeError("Snapshot catalog counts do not match its payloads");
  }
}

export function verifySettingsBackupDigest(snapshot: SettingsBackupEnvelopeV1): boolean {
  const { digest, ...body } = snapshot;
  return digest === settingsBackupDigest(SettingsBackupEnvelopeBodyV1Schema.parse(body));
}
