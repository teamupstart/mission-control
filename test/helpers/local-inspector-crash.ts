/*
 * Child process for the Local Inspector process-death test. It inherits the parent test
 * worker's disposable state home and runs one review on the real engine, stage, adapter and
 * executor. The fake provider returns a reply, and the process is SIGKILLed in the next check
 * phase: after the executor has received that reply, before the supervisor's stream poll can
 * read it. No exit hook, cleanup or replay runs.
 *
 * argv: <id> <repo> <base> <head> <tree> [--without-sink]
 */
const [id, repo, base, head, tree] = process.argv.slice(2) as [string, string, string, string, string];
const { WorkflowEngine } = await import("../../src/server/workflows/engine.ts");
const { DEFAULT_WORKFLOW_POLICY } = await import("../../src/shared/workflow.ts");
const { seed, capture, audit, clean, usage, enableLocalInspector, localExecutor } =
  await import("./local-inspector-accounting-fixture.ts");

enableLocalInspector();
const submissionId = `submission-${id}`;
const store = seed(id, repo);
await capture(store, submissionId, { repo, base, head, tree });
const executor = localExecutor(store, async launch => {
  await audit(launch);
  setImmediate(() => process.kill(process.pid, "SIGKILL"));
  return { verdict: clean, usage };
});
if (process.argv.includes("--without-sink")) {
  // The round-3 behavior: the executor reports its return only through the stream.
  const dispatch = executor.dispatch.bind(executor);
  executor.dispatch = (request, signal) => dispatch(request, signal);
}
const engine = new WorkflowEngine(store, undefined, {
  workflowPolicy: () => ({ ...DEFAULT_WORKFLOW_POLICY, checksEnabled: true, repoAllowlist: [repo] }),
  repositoryExecutor: executor,
});
engine.start();
engine.activateSubmission(submissionId);
// The provider never ran: tell the parent so it does not mistake this for the boundary.
setTimeout(() => process.exit(82), 20_000);
