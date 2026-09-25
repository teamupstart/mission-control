import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { validateNativeSymlinkPublicationBinding } from "../../src/server/symlink-publication.ts";
import { ensureNativeStateLockAddon } from "./native-state-lock.ts";

const require = createRequire(import.meta.url);

/** Inject at the syscall boundary, after every JavaScript identity check. */
export function mockSymlinkPublication(t: TestContext, method: keyof ReturnType<typeof validateNativeSymlinkPublicationBinding>,
  run: (original: (source: string, destination: string) => void, source: string, destination: string) => void) {
  const path = ensureNativeStateLockAddon();
  const cached = require.cache[path]!;
  const original = cached.exports;
  const binding = validateNativeSymlinkPublicationBinding(original);
  const fault = t.mock.fn((source: string, destination: string) => run(binding[method], source, destination));
  const replacement = Object.create(original, { [method]: { value: fault } });
  cached.exports = replacement;
  const restore = () => { if (cached.exports === replacement) cached.exports = original; };
  t.after(restore);
  return { mock: fault.mock, restore };
}
