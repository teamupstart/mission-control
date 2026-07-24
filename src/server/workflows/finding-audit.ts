import { createHash } from "node:crypto";

const FINDING_FINGERPRINT_EVENT_LIMIT = 100;

export function findingFingerprintAudit(fingerprints: readonly string[]): {
  findingFingerprints: string[];
  findingFingerprintsTruncated?: true;
  findingFingerprintCount?: number;
  findingFingerprintsSha256?: string;
} {
  if (fingerprints.length <= FINDING_FINGERPRINT_EVENT_LIMIT) {
    return { findingFingerprints: [...fingerprints] };
  }
  return {
    findingFingerprints: fingerprints.slice(0, FINDING_FINGERPRINT_EVENT_LIMIT),
    findingFingerprintsTruncated: true,
    findingFingerprintCount: fingerprints.length,
    findingFingerprintsSha256: createHash("sha256")
      .update(JSON.stringify(fingerprints))
      .digest("hex"),
  };
}

export function priorFindingFingerprintAudit(fingerprints: readonly string[]): {
  priorFindingFingerprints: string[];
  priorFindingFingerprintsTruncated?: true;
  priorFindingFingerprintCount?: number;
  priorFindingFingerprintsSha256?: string;
} {
  const audit = findingFingerprintAudit(fingerprints);
  if (!audit.findingFingerprintsTruncated) {
    return { priorFindingFingerprints: audit.findingFingerprints };
  }
  return {
    priorFindingFingerprints: audit.findingFingerprints,
    priorFindingFingerprintsTruncated: true,
    priorFindingFingerprintCount: audit.findingFingerprintCount,
    priorFindingFingerprintsSha256: audit.findingFingerprintsSha256,
  };
}
