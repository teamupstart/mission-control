import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubSecrets } from "../src/server/inspector/scrub.ts";

// Leak-defence layer 5, and the one written on the assumption that the other four
// failed.
//
// The reviewer reads files, with a diff that anyone who can open a pull request
// controls, and its output is published where the whole internet can read it. Four
// layers exist to stop a crafted diff turning that into an exfiltration channel; this
// is what stands there when one of them has a hole. It cannot be clever, because it
// runs after the clever parts have already lost.
//
// Its job is therefore to redact SHAPES. A false positive mangles a code sample; a
// false negative publishes a credential. Those are not comparable, and every case here
// is written from that asymmetry.

const CASES: [name: string, input: string][] = [
  ["a GitHub PAT", "The default is ghp_AbCdEf0123456789AbCdEf0123456789abcd here."],
  ["a fine-grained GitHub PAT", "token github_pat_11ABCDEFG0abcdefghijkl_XyZ0123456789 leaked"],
  ["an Anthropic key", "ANTHROPIC_API_KEY is sk-ant-api03-AbCdEf0123456789-XyZ"],
  ["an OpenAI key", "use sk-AbCdEf0123456789AbCdEf0123456789AbCdEf01 for that"],
  ["an AWS access key id", "id AKIAIOSFODNN7EXAMPLE is in the config"],
  ["a Google API key", "AIzaSyA0123456789abcdefghijklmnopqrstuvw is the key"],
  ["a Slack token", "xoxb-0123456789-0123456789-AbCdEfGhIjKlMnOp is set"],
  ["a JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u"],
];

for (const [name, input] of CASES) {
  test(`${name} never reaches the page`, () => {
    const out = scrubSecrets(input);
    assert.match(out, /\[redacted\]/, `${name} should be redacted`);
    // The specific secret substring must be gone, not merely annotated.
    const secret = input.match(/\S{20,}/)![0];
    assert.ok(!out.includes(secret), `the raw ${name} should not survive: ${out}`);
  });
}

test("a private key block is redacted whole, not chopped into surviving pieces", () => {
  const pem = [
    "Found this committed:",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qJ4KZLQxE0ZAOB2ll3zn3Uc9Wp",
    "AoGBAJ7yqK2Q4Z1mVQXn3xY8sT0uW9vP1kL2mN3oP4qR5sT6uV7wX8yZ9aB0cD1e",
    "-----END RSA PRIVATE KEY-----",
    "in src/config.ts.",
  ].join("\n");
  const out = scrubSecrets(pem);
  assert.ok(!out.includes("MIIEowIBAAKCAQEA"), "no key material may survive");
  assert.ok(!out.includes("AoGBAJ7yqK2Q4Z1m"), "not even the middle of the block");
  assert.match(out, /\[redacted\]/);
  assert.match(out, /in src\/config\.ts\./, "the surrounding sentence should still read");
});

test("a quoted or long assignment is redacted, keeping the key name", () => {
  const out = scrubSecrets('api_key = "sk-live-0123456789abcdef" in the constructor');
  assert.ok(!out.includes("sk-live-0123456789abcdef"));
  assert.match(out, /api_key = \[redacted\]/, "the NAME should survive so the note still makes sense");
});

test("credentials embedded in a URL are stripped, the host is not", () => {
  const out = scrubSecrets("connects to postgres://admin:hunter2hunter2@db.internal:5432/app");
  assert.ok(!out.includes("hunter2hunter2"));
  assert.match(out, /db\.internal:5432\/app/, "the host is the useful half of the finding");
});

// The other half of the asymmetry. A scrubber that redacts every occurrence of the word
// "token" makes the reviewer useless at discussing exactly the code most worth
// discussing - auth, sessions, secrets handling - so it must leave ordinary prose and
// short symbolic code alone.
test("ordinary talk about credentials is left completely alone", () => {
  for (const ok of [
    "The `token` variable is never cleared on logout.",
    "const token = readToken();",
    "password: userInput,",
    "Consider renaming apiKey to credential for clarity.",
    "This calls process.env.GITHUB_TOKEN without checking it is set.",
    "secret = null;",
  ]) {
    assert.equal(scrubSecrets(ok), ok, `should be untouched: ${ok}`);
  }
});

test("scrubbing is idempotent, so a body can pass through twice safely", () => {
  const once = scrubSecrets("key ghp_AbCdEf0123456789AbCdEf0123456789abcd here");
  assert.equal(scrubSecrets(once), once);
});
