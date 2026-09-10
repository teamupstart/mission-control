import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_FAILURE_MESSAGE_CAP,
  PiSdkError,
  REDACTED,
  classifyPiFailure,
  redact,
} from "../src/server/harness/pi/sdk-errors.ts";

// What is at stake: a secret in the database, and an operator with no way to fix a session.
//
// Bedrock failures are the reason both halves exist. An expired-token error from AWS quotes
// the request's own `Authorization` header and its `X-Amz-Security-Token` back at the
// caller, and that string is on its way to a session row, a task note and a dashboard. And
// the same error, unclassified, reads as "something went wrong" - while the repair is one
// command in a program Mission Control is not even running.
//
// Every case below is a SYNTHETIC error. Nothing here reads Pi's auth file, contacts a
// provider, or needs a credential to exist.

test("AWS access key ids never survive, whatever sentence they arrive in", () => {
  for (const prefix of ["AKIA", "ASIA", "AROA", "AIDA"]) {
    const key = `${prefix}IOSFODNN7EXAMPLE`;
    const redacted = redact(`The security token included in the request for ${key} is expired`);
    assert.doesNotMatch(redacted, new RegExp(key));
    assert.match(redacted, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  }
});

test("credential assignments are removed by SHAPE, not by the wording around them", () => {
  // Matched on the assignment itself so a provider that reformats its error next release
  // does not silently start leaking. Each of these is one AWS or OAuth spelling.
  const cases = [
    "aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    "aws_session_token: FQoGZXIvYXdzEBYaDMOCK",
    "x-amz-security-token=FQoGZXIvYXdzEBYaDMOCK",
    "Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260101",
    "Bearer sk-ant-api03-0123456789abcdefghijklmnop",
    "api_key = sk-proj-abcdefghijklmnop",
    "refresh_token=1//0abcdefghijklmnopqrstuv",
  ];
  for (const secret of cases) {
    const redacted = redact(`request failed: ${secret}`);
    assert.match(redacted, /request failed/, redacted);
    assert.doesNotMatch(redacted, /wJalrXUtnFEMIK7MDENG/, redacted);
    assert.doesNotMatch(redacted, /FQoGZXIvYXdzEBYaDMOCK/, redacted);
    assert.doesNotMatch(redacted, /sk-ant-api03-0123456789/, redacted);
    assert.doesNotMatch(redacted, /sk-proj-abcdefghijklmnop/, redacted);
    assert.doesNotMatch(redacted, /0abcdefghijklmnopqrstuv/, redacted);
  }
});

test("Authorization: Bearer <token> loses the TOKEN, not just the word Bearer", () => {
  // The commonest header shape there is, and the one a whitespace-bounded value pattern gets
  // exactly wrong: `\S+` stops at the space after `Bearer`, redacting the scheme and leaving
  // the secret - and destroying the word the dedicated Bearer rule needed to find it by. The
  // earlier tests missed this because they exercised the two halves as separate strings.
  const token = "sk-ant-api03-0123456789abcdefghijklmnop";
  const redacted = redact(`Authorization: Bearer ${token}`);
  assert.doesNotMatch(redacted, /sk-ant-api03/, redacted);
  assert.equal(redacted, REDACTED);

  // The prose around it survives, so a diagnostic is still readable.
  const inSentence = redact(`request failed with Authorization: Bearer ${token}, retry later`);
  assert.doesNotMatch(inSentence, /sk-ant-api03/, inSentence);
  assert.match(inSentence, /^request failed with .* retry later$/);

  // Both other spellings of the same header, and a scheme-less value.
  for (const header of [
    `authorization=${token}`,
    `Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260101`,
    `x-amz-security-token: FQoGZXIvYXdzEBYaDMOCK`,
  ]) {
    const out = redact(header);
    assert.doesNotMatch(out, /sk-ant-api03|AKIAIOSFODNN7EXAMPLE|FQoGZXIvYXdzEBYaDMOCK/, out);
  }
});

test("a JWT is removed even though nothing around it names a credential", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
  const redacted = redact(`upstream rejected ${jwt} for this account`);
  assert.doesNotMatch(redacted, /eyJ/);
  assert.match(redacted, /upstream rejected .* for this account/);
});

test("what is left is bounded, so a kilobyte of request echo cannot reach a card", () => {
  const redacted = redact(`failure: ${"detail ".repeat(500)}`);
  assert.equal(redacted.length, PI_FAILURE_MESSAGE_CAP);
  assert.ok(redacted.endsWith("…"));
  // Whitespace is collapsed on the way, so a multi-line provider dump reads as one line.
  assert.equal(redact("first\n\n  second\t third"), "first second third");
});

test("each condition is classified once, and names the repair in Pi", () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    [
      "ExpiredTokenException: The security token included in the request is expired",
      "credentials-expired",
      /refresh the credential in Pi with \/login amazon-bedrock/,
    ],
    [
      "Your SSO session has expired, please re-authenticate",
      "credentials-expired",
      /\/login amazon-bedrock/,
    ],
    [
      "AccessDeniedException: User is not authorized to perform bedrock:InvokeModel",
      "access-denied",
      /provider console/,
    ],
    [
      "No API key found for provider amazon-bedrock",
      "provider-signed-out",
      /open a Pi session and run \/login amazon-bedrock/,
    ],
    [
      "Authentication failed for \"amazon-bedrock\". Run '/login amazon-bedrock' to re-authenticate.",
      "provider-signed-out",
      /\/login amazon-bedrock/,
    ],
    [
      "ValidationException: The model is not supported in the region us-east-2",
      "region-unavailable",
      /choose a region/,
    ],
    [
      "ResourceNotFoundException: could not resolve the model",
      "model-unavailable",
      /pick a model Pi currently lists/,
    ],
  ];
  for (const [raw, kind, remedy] of cases) {
    const failure = classifyPiFailure(new Error(raw), "amazon-bedrock");
    assert.equal(failure.kind, kind, raw);
    assert.match(failure.message, remedy, raw);
  }
});

test("an unrecognized provider failure is passed through rather than given a wrong repair", () => {
  // A wrong repair instruction is worse than none: it sends an operator to re-run a login
  // that was never the problem, and leaves the real cause unread.
  const failure = classifyPiFailure(new Error("upstream returned 502"), "amazon-bedrock");
  assert.equal(failure.kind, "provider-error");
  assert.equal(failure.message, "upstream returned 502");
  assert.doesNotMatch(failure.message, /login/);
});

test("a failure with no provider of record still says something useful", () => {
  const failure = classifyPiFailure(new Error("No API key found"), null);
  assert.equal(failure.kind, "provider-signed-out");
  assert.match(failure.message, /\/login <provider>/);
});

test("classification is idempotent, so a rethrow does not restate the remedy", () => {
  const first = classifyPiFailure(new Error("ExpiredToken"), "amazon-bedrock");
  const second = classifyPiFailure(first, "amazon-bedrock");
  assert.equal(second, first);
  assert.equal(second.message.match(/\/login/g)?.length, 1);
});

test("a classified failure redacts its own message, so a raw one cannot be constructed", () => {
  const failure = new PiSdkError(
    "provider-error",
    "signing with AKIAIOSFODNN7EXAMPLE failed",
  );
  assert.doesNotMatch(failure.message, /AKIAIOSFODNN7EXAMPLE/);
  assert.equal(failure.name, "PiSdkError");
  // The original stays reachable for a log that is already inside the trust boundary, and
  // never for a message: `cause` is what a rethrow carries, not what a card renders.
  const wrapped = classifyPiFailure(new Error("boom AKIAIOSFODNN7EXAMPLE"), null);
  assert.doesNotMatch(wrapped.message, /AKIAIOSFODNN7EXAMPLE/);
  assert.equal((wrapped.cause as Error).message, "boom AKIAIOSFODNN7EXAMPLE");
});

test("a non-Error failure is still redacted and classified", () => {
  const failure = classifyPiFailure("AccessDeniedException on AKIAIOSFODNN7EXAMPLE", "openai");
  assert.equal(failure.kind, "access-denied");
  assert.doesNotMatch(failure.message, /AKIAIOSFODNN7EXAMPLE/);
});

test("nothing in this module reads Pi's auth file", async () => {
  // The rule the plan states as a contract: Mission Control never opens `auth.json`. Read
  // off the module's own source, because a future helper that "just checks whether the
  // credential exists" is exactly how that stops being true.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/server/harness/pi/sdk-errors.ts", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(source, /auth\.json/);
  assert.doesNotMatch(source, /readFile|readFileSync/);
});
