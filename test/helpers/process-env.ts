/**
 * Apply a scoped process environment for one test and restore every declared key afterward.
 *
 * `undefined` means the key must be absent while the callback runs. Snapshotting the keys
 * from `overrides` keeps the ownership list beside the values each test needs, while this
 * helper remains the one implementation of lossless restoration.
 */
export async function withProcessEnv<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  run: () => T | Promise<T>,
): Promise<T> {
  const original = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]] as const),
  );
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
