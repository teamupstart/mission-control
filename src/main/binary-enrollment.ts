import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { binaryEnrollmentChoice, type BinaryEnrollment } from "../shared/binary-enrollment.ts";
import { validateBinaryBuildMetadata } from "../shared/binary-distribution.mjs";
import { binaryPublisherPolicy } from "../shared/binary-publisher-policy.mjs";
import { verifyBinaryPublisher } from "../../scripts/install-staged-app.mjs";
import { readBinaryReceipt, temporaryInstallLocation } from "../../scripts/binary-install-policy.mjs";

export function readBinaryEnrollment(bundle: string, stateDirectory: string): BinaryEnrollment | null {
  const metadata = JSON.parse(readFileSync(join(bundle, "Contents/Resources/app/package.json"), "utf8")).missionBinary;
  if (!metadata) return null; // Source/developer builds retain their explicit installer.
  const problem = validateBinaryBuildMetadata(metadata);
  if (problem) return {action: null, destination: bundle, message: problem};
  try {
    verifyBinaryPublisher(bundle, binaryPublisherPolicy());
    return binaryEnrollmentChoice({bundle, home: homedir(), temporary: temporaryInstallLocation(bundle), managedPath: readBinaryReceipt(stateDirectory)?.appPath ?? null});
  } catch (error) {
    return {action: null, destination: bundle, message: error instanceof Error ? error.message : String(error)};
  }
}

export async function startBinaryEnrollment(bundle: string, stateDirectory: string): Promise<{started: boolean; message: string}> {
  const status = readBinaryEnrollment(bundle, stateDirectory);
  if (!status?.action) throw new Error(status?.message ?? "This source build uses the source installer");
  const root = join(bundle, "Contents/Resources/app");
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).missionBinary;
  const args = [join(root, "scripts/install.sh"), "--ref", metadata.releaseTag ?? metadata.commit];
  if (status.action === "enroll") {
    args.push("--enroll", ...(dirname(bundle) === "/Applications" ? ["--scope", "system"] : ["--apps-dir", dirname(bundle)]));
  }
  // No destination override on mounted installs: the shared resolver preserves a
  // current receipt, or chooses the canonical personal directory for a fresh user.
  mkdirSync(stateDirectory, {recursive: true, mode: 0o700});
  const logPath = join(stateDirectory, "binary-install.log");
  const fd = openSync(logPath, "a", 0o600);
  const env: NodeJS.ProcessEnv = {...process.env, MISSION_HOME: stateDirectory};
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  try { child = spawn("/bin/bash", args, {env, detached: status.action === "install", stdio: ["ignore", fd, fd]}); }
  finally { closeSync(fd); }
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  if (status.action === "install") {
    child.unref();
    return {started: true, message: `Installation started. Progress and recovery details: ${logPath}`};
  }
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  if (code !== 0) throw new Error(`Enrollment could not complete. Your existing installation was preserved. See ${logPath} for the reason.`);
  return {started: true, message: "This copied app is now managed. Automatic binary updates will be available in a later build; use the signed installer for manual replacement."};
}
