import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { transferFixture } from "./session-transfer-fixture.ts";
import { handOffToTerminal } from "../../src/server/sdk/handoff.ts";

// Inherits the parent worker's disposable home and isolation capture. Exiting here
// interrupts the real coordinator; no completed transfer is rewritten into a crash state.
test("interrupt the prelaunch boundary", async (t) => {
  const point = process.argv[2]!.replace("taskless-", "");
  const f = transferFixture(t, { task: !process.argv[2]!.startsWith("taskless-"), workflows: 2 });
  // A real source process can outlive the crashing daemon. No SDK exit callback records
  // its eventual exit, so restart must observe the saved lifetime, not alter the SDK row.
  const sourceProcess = ["stop-entered", "stop-intent-persisted"].includes(point)
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }) : null;
  sourceProcess?.unref();
  if (sourceProcess) t.mock.method(f.supervisor, "handleFor", () => ({ recoveryProcessId: sourceProcess.pid }));
  writeFileSync(process.argv[3]!, JSON.stringify({ sourceId: f.source.id, taskId: f.task?.id ?? null,
    bindings: f.bindings, sourcePid: sourceProcess?.pid ?? null }));
  const publish = f.registry.publishSessionTransfers.bind(f.registry);
  t.mock.method(f.registry, "publishSessionTransfers", (transfer: Parameters<typeof publish>[0]) => {
    if (point === "prepared-persisted" && transfer?.state === "prepared") process.exit(81);
    if (point === "stopping-persisted" && transfer?.state === "stopping") process.exit(81);
    if (point === "stop-intent-persisted" && transfer?.facts.stopStarted) process.exit(81);
    return publish(transfer);
  });
  const upsert = f.registry.upsertTask.bind(f.registry);
  t.mock.method(f.registry, "upsertTask", (task: Parameters<typeof upsert>[0]) => {
    const detaching = task.id === f.task?.id && task.sessionId === null;
    if (detaching && point === "sdk-detached") process.exit(81);
    const result = upsert(task);
    if (detaching && point === "task-detached") process.exit(81);
    return result;
  });
  t.mock.method(f.supervisor, "stop", async () => {
    writeFileSync(`${process.argv[3]}.stop`, "entered");
    if (point === "stop-entered") process.exit(81);
    throw new Error("The crash point did not interrupt before stop");
  });
  await handOffToTerminal(f.registry, f.supervisor, f.source, {
    ...f.deps,
    spawn: async () => { writeFileSync(`${process.argv[3]}.launch`, "entered"); throw new Error("Unexpected launch"); },
  });
  process.exit(82);
});
