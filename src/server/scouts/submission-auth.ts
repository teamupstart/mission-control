import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scoutSubmissionCredentialPath } from "@shared/harness-runtime.mjs";
import { STATE_DIR } from "../config.ts";

/**
 * A task checkout's unforgeable authority to submit one scout's evidence.
 *
 * The shared harness token authenticates a local Mission MCP client, but deliberately does
 * not identify WHICH client. This second bearer is minted by the daemon for one task and
 * checkout, signed with a separate key the MCP process never receives, and re-checked against
 * the live task/session binding before capture. A process that only holds the shared token can
 * no longer select another session by putting its id or cwd in a request body.
 */

const KEY_PATH = join(STATE_DIR, "scout-submission.key");
const TOKEN_VERSION = 1;
const TOKEN_MAX_CHARS = 2_048;

export interface ScoutSubmissionAuthority {
  taskId: string;
  cwd: string;
}

interface CredentialPayload extends ScoutSubmissionAuthority {
  v: typeof TOKEN_VERSION;
  nonce: string;
}

let cachedKey: Buffer | null = null;

function signingKey(): Buffer {
  if (cachedKey) return cachedKey;
  try {
    const existing = readFileSync(KEY_PATH, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return (cachedKey = Buffer.from(existing, "hex"));
  } catch {
    // Missing or unreadable falls through to an atomic replacement below.
  }
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  const key = randomBytes(32);
  const tmp = `${KEY_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${key.toString("hex")}\n`, { mode: 0o600 });
    renameSync(tmp, KEY_PATH);
  } finally {
    rmSync(tmp, { force: true });
  }
  cachedKey = key;
  return key;
}

function signature(encoded: string): Buffer {
  return createHmac("sha256", signingKey())
    .update("mission-scout-submission\0")
    .update(encoded)
    .digest();
}

function encode(authority: ScoutSubmissionAuthority): string {
  const payload: CredentialPayload = {
    v: TOKEN_VERSION,
    taskId: authority.taskId,
    cwd: resolve(authority.cwd),
    nonce: randomBytes(16).toString("hex"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded).toString("base64url")}`;
}

/**
 * Mint and atomically publish the credential an MCP server in `cwd` will read at call time.
 *
 * Reading at call time matters for an assigned agent: its MCP process can outlive several
 * tasks, while this file is replaced at every handoff before the new prompt is delivered.
 */
export function provisionScoutSubmissionCredential(taskId: string, cwd: string): string {
  const canonical = resolve(cwd);
  const token = encode({ taskId, cwd: canonical });
  const file = scoutSubmissionCredentialPath(canonical);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return token;
}

/** Verify the signature and bounded payload before any task or session is looked up. */
export function verifyScoutSubmissionCredential(value: string | undefined): ScoutSubmissionAuthority | null {
  if (!value || value.length > TOKEN_MAX_CHARS) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [encoded, claimed] = parts;
  if (!encoded || !claimed) return null;
  let claimedBytes: Buffer;
  try {
    claimedBytes = Buffer.from(claimed, "base64url");
  } catch {
    return null;
  }
  const expected = signature(encoded);
  if (claimedBytes.length !== expected.length || !timingSafeEqual(claimedBytes, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Partial<CredentialPayload>;
  if (
    candidate.v !== TOKEN_VERSION ||
    typeof candidate.taskId !== "string" ||
    candidate.taskId.length < 1 ||
    candidate.taskId.length > 256 ||
    typeof candidate.cwd !== "string" ||
    candidate.cwd.length < 1 ||
    candidate.cwd.length > 4_096 ||
    resolve(candidate.cwd) !== candidate.cwd ||
    typeof candidate.nonce !== "string" ||
    !/^[0-9a-f]{32}$/.test(candidate.nonce)
  ) {
    return null;
  }
  return { taskId: candidate.taskId, cwd: candidate.cwd };
}
