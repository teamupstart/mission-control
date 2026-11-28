import assert from "node:assert/strict";
import test from "node:test";
import { verifyMicrophoneAccess } from "../scripts/verify-distribution.mjs";
import { tempDir } from "./temp-root.mjs";

test("distribution requires a usage string and a true audio-input entitlement on the signed parent", () => {
  function check(usage: string, value?: boolean | string) {
    verifyMicrophoneAccess("/Example.app", (cmd: string, args: string[], input?: string) => {
      if (cmd.endsWith("PlistBuddy")) {
        assert.deepEqual(args, ["-c", "Print :NSMicrophoneUsageDescription", "/Example.app/Contents/Info.plist"]);
        return {stdout: usage};
      }
      if (cmd.endsWith("codesign")) {
        assert.equal(args.at(-1), "/Example.app");
        return {stdout: "<signed-plist/>"};
      }
      assert.equal(cmd, "/usr/bin/plutil");
      assert.equal(input, "<signed-plist/>");
      return {stdout: JSON.stringify({"com.apple.security.device.audio-input": value})};
    });
  }
  check("Voice listens locally", true);
  assert.throws(() => check(" ", true), /usage description/);
  for (const value of [false, undefined, "true"]) assert.throws(() => check("Voice", value), /entitlement/);
});

test("read microphone policy from a hardened parent signature, leaving the child policy unchanged", {
  skip: process.platform !== "darwin",
}, async t => {
  const { cpSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = tempDir("voice-signed-policy-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "Fixture.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  const plist = join(app, "Contents/Info.plist");
  writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>Fixture</string>
    <key>CFBundleIdentifier</key><string>dev.fixture.voice</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>NSMicrophoneUsageDescription</key><string>Fixture voice access</string>
    </dict></plist>`);
  cpSync("/usr/bin/true", join(app, "Contents/MacOS/Fixture"));
  const sign = (entitlements: string) => execFileSync("/usr/bin/codesign",
    ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, app], {stdio: "pipe"});
  sign("build/entitlements.inherit.plist");
  assert.throws(() => verifyMicrophoneAccess(app), /Missing signed parent microphone entitlement/);
  sign("build/entitlements.mac.plist");
  verifyMicrophoneAccess(app);
  execFileSync("/usr/libexec/PlistBuddy", ["-c", "Delete :NSMicrophoneUsageDescription", plist]);
  sign("build/entitlements.mac.plist");
  assert.throws(() => verifyMicrophoneAccess(app));
});
