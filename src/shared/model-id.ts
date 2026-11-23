import { z } from "zod";

/**
 * A model id, in the only shape that is safe to hand to a harness CLI.
 *
 * Terminal backends preserve argv boundaries, but the value still passes through each
 * harness's option parser. Requiring an alphanumeric first character rejects flag- and
 * path-shaped inputs, while the restricted remainder excludes whitespace and control
 * characters before the id is stored. Real Claude and Codex ids fit that alphabet
 * (`claude-opus-4-8`, `gpt-5.6-sol`). Note this deliberately excludes Claude's `[1m]`
 * long-context marker: the CLI takes the bare id and picks the window itself.
 */
export const ModelIdSchema = z
  .string()
  .max(80)
  // `/` and `:` are allowed only in the INTERIOR, never as the first character, so a
  // provider-qualified id like `openai/gpt-5.5` (Pi is multi-provider and its ids carry the
  // provider) passes while a path such as `../../etc/passwd` or a bare `-rf` still fails on
  // the leading-char class.
  //
  // `:` is here because Amazon Bedrock's own ids carry a version suffix - measured against
  // Pi 0.85.1, 41 of the 121 models it lists for `amazon-bedrock` are of the shape
  // `anthropic.claude-sonnet-4-5-20250929-v1:0`. Excluding it did not reject those ids at
  // the edge, it dropped a third of that provider's catalog silently: the row never reached
  // the picker, so the model simply did not exist as far as an operator could tell. It is
  // no weaker than the rest of the class - not whitespace, not a control character, not a
  // path separator, and not able to start the string.
  //
  // Terminal adapters own argv preservation; this schema owns the persisted id vocabulary.
  // Test: `dispatch-model.test.ts`.
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/, "model id must be alphanumeric with . _ - / : only");
