import assert from "node:assert/strict";
import test from "node:test";
import {
  DAEMON_PROTOCOL_CAPABILITIES,
  daemonHealthCompatibility,
  daemonHealthSupports,
  workflowEvidenceNeedsCriterionMappedCapability,
} from "../src/shared/daemon-protocol.ts";

const capability = DAEMON_PROTOCOL_CAPABILITIES.criterionMappedWorkflowEvidence;
const executableCapability = DAEMON_PROTOCOL_CAPABILITIES.daemonExecutableEnvironment;

test("daemon health requires the named criterion-mapped evidence capability", () => {
  assert.equal(daemonHealthCompatibility(null, capability), "unreachable");
  assert.equal(
    daemonHealthCompatibility({ service: "another-service", capabilities: [capability] }, capability),
    "unreachable",
  );
  assert.equal(
    daemonHealthCompatibility({ service: "mission-control" }, capability),
    "incompatible",
  );
  assert.equal(
    daemonHealthCompatibility(
      { service: "mission-control", capabilities: [capability] },
      capability,
    ),
    "compatible",
  );
  assert.equal(daemonHealthSupports({ service: "mission-control" }, capability), false);
  assert.equal(
    daemonHealthSupports({ service: "mission-control", capabilities: [] }, capability),
    false,
  );
  assert.equal(
    daemonHealthSupports({ service: "another-service", capabilities: [capability] }, capability),
    false,
  );
  assert.equal(
    daemonHealthSupports({ service: "mission-control", capabilities: [capability] }, capability),
    true,
  );
});

test("only new workflow evidence fields require the criterion-mapped capability", () => {
  assert.equal(workflowEvidenceNeedsCriterionMappedCapability({}), false);
  assert.equal(
    workflowEvidenceNeedsCriterionMappedCapability({ commandOutputs: [{ exitCode: 0 }] }),
    false,
    "legacy evidence remains usable with an older daemon",
  );
  assert.equal(
    workflowEvidenceNeedsCriterionMappedCapability({ coverage: [{ criterion: "Rendered UI" }] }),
    true,
    "coverage must not be silently stripped by an older daemon",
  );
  assert.equal(
    workflowEvidenceNeedsCriterionMappedCapability({ commandOutputs: [{ exitCode: -15 }] }),
    true,
    "signed process exit codes must not be sent to the old nonnegative schema",
  );
});

test("executable environment adoption is an independent append-only capability", () => {
  assert.equal(
    daemonHealthCompatibility(
      { service: "mission-control", capabilities: [capability] },
      executableCapability,
    ),
    "incompatible",
  );
  assert.equal(
    daemonHealthCompatibility(
      { service: "mission-control", capabilities: [capability, executableCapability] },
      executableCapability,
    ),
    "compatible",
  );
});
