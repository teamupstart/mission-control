import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "mission-command-artifacts-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const {
  CommandArtifactReadError,
  WorkflowCommandArtifactService,
} = await import("../src/server/workflows/command-artifacts.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { WORKFLOW_COMMAND_OUTPUT_LIMITS } = await import("../src/shared/workflow.ts");

const db = openDb();
const bodies = join(home, "command-output-test");
const service = new WorkflowCommandArtifactService(db, bodies);

after(() => rmSync(home, { recursive: true, force: true }));

function capture(attemptId: string, runId = "run-1") {
  return service.beginCapture({ runId, submissionId: "submission-1", attemptId });
}

for (const failure of ["begin", "insert", "commit"] as const) test(`failed findings ${failure} settles only its reservation immediately`, (t) => {
  const input = { runId: `publication-${failure}`, submissionId: "publication-sub", attemptId: `publication-${failure}` };
  const output = service.beginCapture({ ...input, semanticBytes: 4 * 1024 * 1024 });
  output.push("stdout", Buffer.from("retained raw review\n"));
  const stdout = output.finalize(true).find(a => a.kind === "stdout")!;
  const other = service.beginCapture({ ...input, attemptId: `${input.attemptId}-live` });
  const exec = db.exec.bind(db);let injected = false;
  if (failure === "insert") exec(`CREATE TEMP TRIGGER fail_findings_insert BEFORE INSERT ON workflow_command_artifacts
    WHEN NEW.kind = 'findings' AND NEW.availability = 'retained' BEGIN SELECT RAISE(ABORT, 'fixture publication failure'); END`);
  else t.mock.method(db, "exec", (sql: string) => {
    if (!injected && sql === (failure === "begin" ? "BEGIN IMMEDIATE" : "COMMIT")) { injected = true; throw new Error("fixture publication failure"); }
    return exec(sql);
  });
  try {
    assert.throws(() => service.publishFindings(input, Buffer.from("finding\n"), true), /fixture publication failure/);
    const row = db.prepare("SELECT state, retained_bytes FROM workflow_command_artifact_reservations WHERE attempt_id = ?").get(input.attemptId) as {state:string;retained_bytes:number};
    assert.equal(row.state, "interrupted");
    assert.equal(row.retained_bytes, stdout.retainedBytes);
    assert.equal((db.prepare("SELECT state FROM workflow_command_artifact_reservations WHERE attempt_id = ?").get(`${input.attemptId}-live`) as {state:string}).state, "reserved");
    assert.equal(service.read({ runId: input.runId, attemptId: input.attemptId, artifactId: stdout.id }).text, "retained raw review\n");
    const findings = service.listForAttempt(input.attemptId).find(a => a.kind === "findings")!;
    assert.equal(findings.availability, "unavailable");
    assert.equal(findings.captureState, "partial");
  } finally {
    if (failure === "insert") exec("DROP TRIGGER fail_findings_insert");
    other.finalize(false);
  }
});

test("retains stdout and stderr separately and pages on UTF-8 boundaries", () => {
  const output = capture("attempt-mixed");
  output.push("stdout", Buffer.from("\u001b[31m🙂\u001b[0mX", "utf8"));
  output.push("stderr", Buffer.from("problem\n", "utf8"));
  const artifacts = output.finalize(true);

  assert.equal(artifacts.length, 2);
  const stdout = artifacts.find((artifact) => artifact.kind === "stdout")!;
  const stderr = artifacts.find((artifact) => artifact.kind === "stderr")!;
  assert.equal(stdout.captureState, "complete");
  assert.equal(stdout.observedBytes, Buffer.byteLength("\u001b[31m🙂\u001b[0mX"));

  const first = service.read({
    runId: "run-1", attemptId: "attempt-mixed", artifactId: stdout.id, limit: 13,
  });
  assert.equal(first.text, "🙂");
  assert.ok(first.nextCursor);
  const second = service.read({
    runId: "run-1", attemptId: "attempt-mixed", artifactId: stdout.id,
    cursor: first.nextCursor, limit: 64,
  });
  assert.equal(second.text, "X");
  assert.equal(second.nextCursor, null);
  assert.equal(service.read({
    runId: "run-1", attemptId: "attempt-mixed", artifactId: stderr.id,
  }).text, "problem\n");
});

test("strips an ANSI sequence split across output pages", () => {
  const output = capture("attempt-split-ansi", "run-split-ansi");
  output.push("stdout", Buffer.from("A\u001b[31mB", "utf8"));
  const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;

  const first = service.read({
    runId: "run-split-ansi",
    attemptId: "attempt-split-ansi",
    artifactId: stdout.id,
    limit: WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMin,
  });
  assert.equal(first.text, "A");
  assert.ok(first.nextCursor);

  const second = service.read({
    runId: "run-split-ansi",
    attemptId: "attempt-split-ansi",
    artifactId: stdout.id,
    cursor: first.nextCursor,
    limit: WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMin,
  });
  assert.equal(second.text, "B");
  assert.equal(second.nextCursor, null);
});

test("pages consecutive escape bytes without blocking the reader", () => {
  // A synchronous reader regression cannot be interrupted by this worker's own timer.
  if (process.env.MISSION_TEST_ESC_READER_CHILD !== "1") {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, MISSION_TEST_ESC_READER_CHILD: "1" };
    // Start an independent test runner; keep the inherited isolation markers and preload.
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [
      "--test", "--test-name-pattern", "pages consecutive escape bytes",
      "--import", "./test/setup-state.mjs", "--import", "tsx", fileURLToPath(import.meta.url),
    ], {
      env: childEnv,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    assert.equal(child.error, undefined, `reader child failed: ${child.error?.message}`);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /consecutive ESC paging assertions completed/);
    return;
  }

  for (const [index, body] of [
    "A\u001b\u001bBtail",
    "ABC\u001b\u001b[31mD",
    "ABC\u001b\u001b\u001bXtail",
  ].entries()) {
    const attemptId = `attempt-consecutive-esc-${index}`;
    const output = capture(attemptId, "run-consecutive-esc");
    output.push("stdout", Buffer.from(body));
    const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;
    let cursor: string | null = null;
    let text = "";
    let pages = 0;
    do {
      const page = service.read({
        runId: "run-consecutive-esc", attemptId, artifactId: stdout.id, cursor,
        limit: WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMin,
      });
      text += page.text;
      cursor = page.nextCursor;
      assert.ok(++pages <= body.length, "paging must advance to the retained end");
    } while (cursor !== null);
    assert.equal(text, ["ABtail", "ABCD", "ABCXtail"][index]);
  }
  console.log("consecutive ESC paging assertions completed");
});

test("short writes are completed before retained byte counts are published", () => {
  const writes: number[] = [];
  const shortWriteService = new WorkflowCommandArtifactService(
    db,
    join(home, "short-write-output"),
    {
      write: (fd, buffer, offset, length) => {
        const written = Math.min(3, length);
        writes.push(written);
        return writeSync(fd, buffer, offset, written);
      },
    },
  );
  const output = shortWriteService.beginCapture({
    runId: "run-short-write",
    submissionId: "submission-short-write",
    attemptId: "attempt-short-write",
  });
  output.push("stdout", Buffer.from("partial writes still retain every byte"));
  const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;

  assert.ok(writes.length > 1, "the fixture did not force a partial write");
  assert.equal(stdout.availability, "retained");
  assert.equal(stdout.retainedBytes, Buffer.byteLength("partial writes still retain every byte"));
  assert.equal(shortWriteService.read({
    runId: "run-short-write",
    attemptId: "attempt-short-write",
    artifactId: stdout.id,
  }).text, "partial writes still retain every byte");
});

test("the reader rejects a retained body that ends before its recorded byte count", () => {
  const output = capture("attempt-short-body", "run-short-body");
  output.push("stdout", Buffer.from("recorded body"));
  const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;
  const row = db.prepare(
    `SELECT storage_key FROM workflow_command_artifacts WHERE id = ?`,
  ).get(stdout.id) as { storage_key: string };
  truncateSync(join(bodies, "retained", row.storage_key), 0);

  assert.throws(
    () => service.read({
      runId: "run-short-body",
      attemptId: "attempt-short-body",
      artifactId: stdout.id,
    }),
    (error: unknown) => error instanceof CommandArtifactReadError
      && error.code === "command_output_unavailable",
  );
});

test("an obstructed output root starts and reports later capture as unavailable", () => {
  const outputRoot = join(home, "obstructed-output-root");
  writeFileSync(outputRoot, "not a directory");
  const obstructedService = new WorkflowCommandArtifactService(db, outputRoot);
  const output = obstructedService.beginCapture({
    runId: "run-obstructed-root",
    submissionId: "submission-obstructed-root",
    attemptId: "attempt-obstructed-root",
  });
  output.push("stdout", Buffer.from("command output was still observed"));
  const artifacts = output.finalize(true);

  assert.equal(artifacts.length, 2);
  assert.equal(artifacts.every((artifact) => artifact.availability === "unavailable"), true);
  assert.equal(
    artifacts.find((artifact) => artifact.kind === "stdout")?.observedBytes,
    Buffer.byteLength("command output was still observed"),
  );
});

test("orphan cleanup failure does not prevent startup or later capture", () => {
  const outputRoot = join(home, "orphan-cleanup-failure");
  const orphan = join(outputRoot, "retained", "orphan-directory");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "child"), "cannot be removed as a file");

  const recoveredService = new WorkflowCommandArtifactService(db, outputRoot);
  const output = recoveredService.beginCapture({
    runId: "run-orphan-cleanup",
    submissionId: "submission-orphan-cleanup",
    attemptId: "attempt-orphan-cleanup",
  });
  output.push("stdout", Buffer.from("command capture still works"));
  const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;

  assert.equal(stdout.availability, "retained");
  assert.equal(recoveredService.read({
    runId: "run-orphan-cleanup",
    attemptId: "attempt-orphan-cleanup",
    artifactId: stdout.id,
  }).text, "command capture still works");
});

test("the HTTP reader accepts a 64 KiB page and refuses adjacent out-of-range limits", async () => {
  const output = capture("attempt-page-limit", "run-page-limit");
  output.push(
    "stdout",
    Buffer.alloc(WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMax + 1, 120),
  );
  const artifact = output.finalize(true).find((item) => item.kind === "stdout")!;
  const registry = new Registry();
  const workflows = new WorkflowManager(registry, new WorkflowStore(db), {
    commandArtifacts: service,
  });
  const app = buildApp({
    registry,
    reviews: null as never,
    tasks: null as never,
    queues: null as never,
    workflows,
  });
  const read = (limit: number) => app.request(
    `/api/workflow-runs/run-page-limit/attempts/attempt-page-limit/command-output/${artifact.id}`
      + `?limit=${limit}`,
    { headers: { host: "127.0.0.1:7317" } },
  );

  assert.equal((await read(WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMin - 1)).status, 400);
  assert.equal((await read(WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMax + 1)).status, 400);

  const response = await read(WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMax);
  assert.equal(response.status, 200);
  const page = await response.json() as { text: string; nextCursor: string | null };
  assert.equal(
    Buffer.byteLength(page.text, "utf8"),
    WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMax,
    "the route returned more than its maximum page",
  );
  assert.ok(page.nextCursor, "one retained byte should remain for the next page");
});

test("retention caps bytes without changing observed byte accounting", () => {
  const output = capture("attempt-huge", "run-huge");
  const body = Buffer.alloc(WORKFLOW_COMMAND_OUTPUT_LIMITS.retainedBytesPerAttempt + 17, 120);
  output.push("stdout", body);
  const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;
  assert.equal(stdout.observedBytes, body.length);
  assert.equal(stdout.retainedBytes, WORKFLOW_COMMAND_OUTPUT_LIMITS.retainedBytesPerAttempt);
  assert.equal(stdout.droppedBytes, 17);
});

test("periodic reconciliation preserves files owned by an active capture", () => {
  const output = capture("attempt-active-reconcile", "run-active-reconcile");
  output.push("stdout", Buffer.from("before reconciliation\n"));

  service.reconcile();

  output.push("stdout", Buffer.from("after reconciliation\n"));
  const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;
  assert.equal(stdout.availability, "retained");
  assert.equal(service.read({
    runId: "run-active-reconcile",
    attemptId: "attempt-active-reconcile",
    artifactId: stdout.id,
  }).text, "before reconciliation\nafter reconciliation\n");
});

test("a retention cap cuts before a partial UTF-8 character and paging terminates", () => {
  const output = capture("attempt-utf8-cap", "run-utf8-cap");
  const ascii = Buffer.alloc(WORKFLOW_COMMAND_OUTPUT_LIMITS.retainedBytesPerAttempt - 1, 120);
  const body = Buffer.concat([ascii, Buffer.from("🙂", "utf8")]);
  output.push("stdout", body);
  const stdout = output.finalize(true).find((artifact) => artifact.kind === "stdout")!;

  assert.equal(stdout.observedBytes, body.length);
  assert.equal(stdout.retainedBytes, ascii.length);
  assert.equal(stdout.droppedBytes, Buffer.byteLength("🙂", "utf8"));

  let cursor: string | null = null;
  let readBytes = 0;
  do {
    const page = service.read({
      runId: "run-utf8-cap",
      attemptId: "attempt-utf8-cap",
      artifactId: stdout.id,
      cursor,
      limit: WORKFLOW_COMMAND_OUTPUT_LIMITS.readBytesMax,
    });
    const pageBytes = Buffer.byteLength(page.text, "utf8");
    assert.ok(pageBytes > 0, "a cursor returned an empty page instead of advancing");
    readBytes += pageBytes;
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(readBytes, ascii.length);
});

test("concurrent reservations cannot exceed the per-run retained quota", () => {
  const captures = Array.from({ length: 33 }, (_unused, index) =>
    capture(`attempt-quota-${index}`, "run-quota"));
  assert.equal(captures.slice(0, 32).every((item) =>
    item.capacity === WORKFLOW_COMMAND_OUTPUT_LIMITS.retainedBytesPerAttempt), true);
  assert.equal(captures[32]!.capacity, 0);
  for (const item of captures) item.finalize(false);
});

test("empty, partial, storage-failed and interrupted captures stay distinguishable", () => {
  const empty = capture("attempt-empty");
  const emptyArtifacts = empty.finalize(true);
  assert.deepEqual(empty.finalize(true), emptyArtifacts);
  assert.equal(emptyArtifacts.every((artifact) =>
    artifact.availability === "retained" && artifact.retainedBytes === 0), true);
  assert.equal(service.read({
    runId: "run-1", attemptId: "attempt-empty", artifactId: emptyArtifacts[0]!.id,
  }).text, "");

  const partial = capture("attempt-partial");
  partial.push("stdout", Buffer.from("before cancellation"));
  assert.equal(partial.finalize(false)[0]!.captureState, "partial");

  const failed = capture("attempt-storage-failed");
  failed.push("stdout", Buffer.from("cannot publish"));
  rmSync(join(bodies, ".tmp"), { recursive: true, force: true });
  const failedArtifacts = failed.finalize(true);
  assert.equal(failedArtifacts.every((artifact) => artifact.availability === "unavailable"), true);

  db.prepare(
    `INSERT INTO workflow_node_attempts
       (id, submission_id, node_id, attempt, state, input_fingerprint, created_at, updated_at)
     VALUES ('attempt-interrupted', 'submission-crash', 'check-1', 1, 'running', 'fp', 1, 1)`,
  ).run();
  const interrupted = capture("attempt-interrupted", "run-crash");
  interrupted.push("stdout", Buffer.from("not published"));
  const restarted = new WorkflowCommandArtifactService(db, bodies);
  const recovered = restarted.listForAttempt("attempt-interrupted");
  assert.equal(recovered.length, 2);
  assert.equal(recovered.every((artifact) =>
    artifact.availability === "unavailable" && artifact.captureState === "partial"), true);
});

test("reader binds ownership and cursor identity and reports pruning", () => {
  const output = capture("attempt-owned", "run-owned");
  output.push("stdout", Buffer.from("abcdef"));
  const artifact = output.finalize(true).find((item) => item.kind === "stdout")!;
  const page = service.read({
    runId: "run-owned", attemptId: "attempt-owned", artifactId: artifact.id, limit: 4,
  });
  assert.ok(page.nextCursor);

  assert.throws(
    () => service.read({ runId: "another-run", attemptId: "attempt-owned", artifactId: artifact.id }),
    (error: unknown) => error instanceof CommandArtifactReadError && error.status === 404,
  );
  assert.throws(
    () => service.read({
      runId: "run-owned", attemptId: "attempt-owned", artifactId: artifact.id,
      cursor: `${page.nextCursor}tampered`,
    }),
    (error: unknown) => error instanceof CommandArtifactReadError && error.code === "command_output_cursor",
  );

  db.prepare(
    `UPDATE workflow_command_artifacts SET availability = 'pruned', pruned_at = 2 WHERE id = ?`,
  ).run(artifact.id);
  service.reconcile();
  assert.throws(
    () => service.read({ runId: "run-owned", attemptId: "attempt-owned", artifactId: artifact.id }),
    (error: unknown) => error instanceof CommandArtifactReadError && error.status === 410,
  );
});

test("invalid UTF-8 and internal path tricks fail closed", () => {
  const invalid = capture("attempt-invalid");
  invalid.push("stdout", Buffer.from([0xc3, 0x28]));
  const invalidArtifact = invalid.finalize(true).find((item) => item.kind === "stdout")!;
  assert.throws(
    () => service.read({
      runId: "run-1", attemptId: "attempt-invalid", artifactId: invalidArtifact.id,
    }),
    (error: unknown) => error instanceof CommandArtifactReadError
      && error.code === "command_output_encoding",
  );

  const escaped = capture("attempt-path");
  escaped.push("stdout", Buffer.from("safe"));
  const escapedArtifact = escaped.finalize(true).find((item) => item.kind === "stdout")!;
  db.prepare(`UPDATE workflow_command_artifacts SET storage_key = '../outside' WHERE id = ?`)
    .run(escapedArtifact.id);
  assert.throws(
    () => service.read({ runId: "run-1", attemptId: "attempt-path", artifactId: escapedArtifact.id }),
    (error: unknown) => error instanceof CommandArtifactReadError
      && error.code === "command_output_path",
  );
});
