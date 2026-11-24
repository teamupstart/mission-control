// Each invocation is a separate launcher. Its credential host owns fd 4; IPC carries only public data.
import { createVoiceSupervisor } from "../../src/server/voice/supervisor-auth.ts";
import { fstatSync } from "node:fs";
import { once } from "node:events";

const signer = createVoiceSupervisor("shell", 4);
try {
  fstatSync(4);
  throw new Error("Credential descriptor still open");
} catch (error) {
  if (error.code !== "EBADF") throw error;
}
process.on("message", async request => {
  if (request.state === "ack") return;
  if (request.state === "play") {
    const { child } = await signer.launch(request.home, process.execPath,
      ["-e", "require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR, 'playing'), 'sample'); process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      {}, async (instance, state, proof) => {
        if (state !== "started") throw new Error("Unexpected exit before release");
        const ack = once(process, "message");
        process.send({ instance, env: signer.daemonEnv, proof });
        await ack;
      });
    await once(child.stdout, "data");
    process.send({ pid: child.pid });
  } else if (request.state === "started") {
    // The HTTP test runs the fake player independently of these two restartable parents.
    // Pause at announcement so the fixture can model a parent dying at this boundary.
    await signer.launch(request.home, process.execPath, [], {}, (instance, state, proof) => {
      if (state !== "started") throw new Error("Unexpected exit before the test player starts");
      process.send({ instance, env: signer.daemonEnv, proof });
      return new Promise(() => {});
    });
  } else {
    try {
      process.kill(request.pid, 0);
      process.send({ proof: null });
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      process.send({ proof: signer.exitProof(request.instance) });
    }
  }
});
