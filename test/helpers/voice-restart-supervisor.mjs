// Each invocation is a separate launcher. Its credential host owns fd 4; IPC carries only public data.
import { createVoiceSupervisor } from "../../src/server/voice/supervisor-auth.ts";
import { fstatSync } from "node:fs";

const signer = createVoiceSupervisor("shell", 4);
try {
  fstatSync(4);
  throw new Error("Credential descriptor still open");
} catch (error) {
  if (error.code !== "EBADF") throw error;
}
process.on("message", async request => {
  if (request.state === "started") {
    // The HTTP test runs the fake player independently of these two restartable parents.
    // Pause at announcement so the fixture can model a parent dying at this boundary.
    await signer.launch(request.home, process.execPath, [], {}, (instance, proof) => {
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
