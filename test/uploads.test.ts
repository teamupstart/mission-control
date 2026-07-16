import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the state dir before uploads.ts reads config for UPLOADS_DIR.
process.env.FLEET_HOME = mkdtempSync(join(tmpdir(), "fleet-uploads-"));
const { UPLOADS_DIR, detectImageExt, saveImageUpload, sweepUploads, uploadFileName } = await import(
  "../src/server/uploads.ts"
);
import { formatAttachmentPath, withAttachments } from "../src/shared/attachments.ts";

// A dropped image becomes a PATH in a prompt - that's the whole mechanism, because
// the last hop to an agent is keystrokes into a pty and bytes can't make that trip.
// These tests hold the two ends of that bargain: what we agree to write to disk,
// and what the prompt is allowed to say about it.

/** A real 1x1 PNG - the sniff reads actual bytes, so the fixtures must be real. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new Uint8Array(Buffer.from("GIF89a\x01\x00", "binary"));
const WEBP = new Uint8Array(Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "binary"));

test("detectImageExt: names each format we accept", () => {
  assert.equal(detectImageExt(PNG), "png");
  assert.equal(detectImageExt(JPEG), "jpg");
  assert.equal(detectImageExt(GIF), "gif");
  assert.equal(detectImageExt(WEBP), "webp");
});

test("detectImageExt: rejects bytes that are not an image", () => {
  assert.equal(detectImageExt(new Uint8Array(Buffer.from("#!/bin/sh\nrm -rf /", "utf8"))), null);
  assert.equal(detectImageExt(new Uint8Array()), null);
  // A near-miss: RIFF, but a WAV rather than a WEBP. The format tag is the check.
  assert.equal(detectImageExt(new Uint8Array(Buffer.from("RIFF\x24\x00\x00\x00WAVE", "binary"))), null);
});

test("detectImageExt: a PNG signature is more than its three letters", () => {
  // Truncating the 8-byte magic must not still read as PNG - the trailing CR/LF
  // bytes are there to catch exactly this kind of mangling.
  assert.equal(detectImageExt(new Uint8Array(Buffer.from("\x89PNG!!!!", "binary"))), null);
});

test("uploadFileName: keeps a readable stem and adds the sniffed extension", () => {
  const name = uploadFileName("diagram.png", "png");
  assert.match(name, /^diagram-[0-9a-f]{8}\.png$/);
});

test("uploadFileName: the stored name can never need shell quoting", () => {
  // This name is about to be pasted into a live prompt, so anything a shell or a
  // TUI would read as syntax has to be gone before it reaches disk.
  const name = uploadFileName('Screen Shot 2026-07-15 at "9.41".png', "png");
  assert.match(name, /^[A-Za-z0-9._-]+$/);
  assert.equal(formatAttachmentPath(`/tmp/${name}`), `/tmp/${name}`, "should not need quoting");
});

test("uploadFileName: the client's filename cannot steer the write", () => {
  // A traversal attempt is stem text like any other - it never survives as a path.
  const name = uploadFileName("../../../../etc/authorized_keys", "png");
  assert.ok(!name.includes("/"), name);
  assert.ok(!name.includes(".."), name);
  assert.match(name, /^authorized_keys-[0-9a-f]{8}\.png$/);
});

test("uploadFileName: a nameless paste still lands somewhere sane", () => {
  assert.match(uploadFileName("", "jpg"), /^image-[0-9a-f]{8}\.jpg$/);
  // A name made entirely of stripped characters must not leave a bare "-abc123.png".
  assert.match(uploadFileName("???", "png"), /^image-[0-9a-f]{8}\.png$/);
});

test("uploadFileName: two drops of the same screenshot don't collide", () => {
  const a = uploadFileName("Screenshot.png", "png");
  const b = uploadFileName("Screenshot.png", "png");
  assert.notEqual(a, b);
});

test("saveImageUpload: writes the bytes and reports the path the agent will read", () => {
  const saved = saveImageUpload(PNG, "shot.png");
  assert.equal(saved.path, join(UPLOADS_DIR, saved.name));
  assert.equal(saved.bytes, PNG.byteLength);
  assert.deepEqual(new Uint8Array(readFileSync(saved.path)), PNG, "bytes must survive the trip");
});

test("saveImageUpload: refuses bytes that aren't an image, whatever they're called", () => {
  // The extension is earned by the content. Otherwise this endpoint is just a way
  // to write an arbitrary file that an agent has been told to go read.
  assert.throws(
    () => saveImageUpload(new Uint8Array(Buffer.from("rm -rf /", "utf8")), "innocent.png"),
    /not a recognised image/,
  );
});

test("sweepUploads: reclaims expired drops and spares live ones", () => {
  const old = saveImageUpload(PNG, "stale.png");
  const fresh = saveImageUpload(PNG, "recent.png");
  const dayMs = 24 * 60 * 60 * 1000;
  const longAgo = (Date.now() - 30 * dayMs) / 1000;
  utimesSync(old.path, longAgo, longAgo);

  assert.equal(sweepUploads(7 * dayMs), 1);
  assert.equal(existsSync(old.path), false);
  assert.equal(existsSync(fresh.path), true, "a recent drop must outlive the sweep");
});

test("sweepUploads: an absent uploads dir is not an error", () => {
  // The sweep runs at boot, which on a fresh install is before anything has ever
  // been dropped - housekeeping must never be the reason the daemon won't start.
  rmSync(UPLOADS_DIR, { recursive: true, force: true });
  assert.equal(sweepUploads(), 0);
  assert.equal(existsSync(UPLOADS_DIR), false, "a sweep shouldn't conjure the dir either");
});

test("withAttachments: appends bare paths, each on its own line", () => {
  const text = withAttachments("what's wrong here?", [
    { path: "/tmp/a-1234.png", name: "a.png" },
    { path: "/tmp/b-5678.png", name: "b.png" },
  ]);
  // Bare paths, no "attached:" preamble - the prompt belongs to the human, and the
  // path is already the whole instruction as far as the agent is concerned.
  assert.equal(text, "what's wrong here?\n\n/tmp/a-1234.png\n/tmp/b-5678.png");
});

test("withAttachments: an image with no words is a complete message", () => {
  assert.equal(withAttachments("   ", [{ path: "/tmp/a-1.png", name: "a.png" }]), "/tmp/a-1.png");
});

test("withAttachments: leaves a plain message untouched", () => {
  assert.equal(withAttachments("just text", []), "just text");
});

test("formatAttachmentPath: quotes a path only when it would otherwise split", () => {
  // The stored basename is always safe, but the state dir hangs off the user's home
  // - and "/Users/first last/..." would paste as two half-paths.
  assert.equal(formatAttachmentPath("/Users/ada/.fleet-control/uploads/a-1.png"), "/Users/ada/.fleet-control/uploads/a-1.png");
  assert.equal(formatAttachmentPath("/Users/first last/uploads/a-1.png"), '"/Users/first last/uploads/a-1.png"');
  assert.equal(formatAttachmentPath('/tmp/we"ird/a.png'), '"/tmp/we\\"ird/a.png"');
});

test("a saved upload's real path never needs quoting", () => {
  // The end-to-end version of the promise the two halves make each other: whatever
  // the client called it, what lands in the prompt is one bare token.
  const saved = saveImageUpload(PNG, "my screenshot (final).png");
  const line = withAttachments("look", [{ path: saved.path, name: saved.name }]);
  assert.ok(!line.includes('"'), line);
  assert.ok(line.endsWith(saved.path));
});

test("uploads land inside the state dir, not wherever the caller fancied", () => {
  const saved = saveImageUpload(PNG, "x.png");
  assert.ok(saved.path.startsWith(UPLOADS_DIR + "/"), saved.path);
  // And the dir is the daemon's own, alongside the db - not a world-writable temp.
  assert.ok(UPLOADS_DIR.startsWith(process.env.FLEET_HOME!), UPLOADS_DIR);
});
