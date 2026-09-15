// Types for the parts of `embed-guide-images.mjs` that `test/setup-guide-embedding.test.ts`
// imports under `noImplicitAny`. Same convention as `scripts/demo/launch.d.mts`: the generator
// itself stays plain JavaScript, because it runs with no build step.

export interface EmbeddedFigure {
  /** The source path as written in `data-embed`, relative to `docs/`. */
  source: string;
  /** sha256 of the source file's bytes at embed time. */
  digest: string;
  /** Size of the source file in bytes. */
  bytes: number;
}

/**
 * Rewrite every `<img>` in the guide as a `data:` URI, recording its source and digest.
 *
 * `write: false` computes the result without touching the file, which is how a test asks
 * "would this change anything?" without needing a working copy it may modify.
 */
export function embedGuideImages(options?: {
  guidePath?: string;
  write?: boolean;
}): { embedded: EmbeddedFigure[]; changed: boolean; bytes: number };
