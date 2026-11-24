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
process.on("message", request => {
  if (request.state === "started") {
    const instance = signer.newInstance();
    process.send({ instance, env: signer.daemonEnv, proof: signer.proof(instance, "started") });
  } else {
    try {
      process.kill(request.pid, 0);
      process.send({ proof: null });
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      process.send({ proof: signer.proof(request.instance, "exited") });
    }
  }
});
