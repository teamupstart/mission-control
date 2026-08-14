import { ARCHIVES_DIR, LEGACY_SCOUTS_DIR } from "../config.ts";

/**
 * Which directories are the archive library, and which single one new bundles land in.
 *
 * `config.ts` says nothing else in the daemon may resolve a library root, because a second
 * resolver silently splits the catalog. This class is what honours that comment now that
 * there are two roots to resolve: everything - capture, discovery, reads, deletion - asks
 * this object, and nobody else joins `STATE_DIR` to a library name.
 *
 * The asymmetry is the whole design, and it is what keeps the format's append-only promise
 * concrete:
 *
 * - **One write root.** Every bundle this build publishes goes under `archives/`, in the
 *   `mission-control/archive` format, carrying its kind.
 * - **Every read root.** Discovery walks the write root and then each legacy root, so a
 *   bundle published by an earlier build keeps being found where it already is. Nothing is
 *   moved, re-signed, or re-serialized - a published bundle is immutable, and "migrating"
 *   one would mean rewriting evidence somebody may already have cited by path.
 *
 * Order is significant and stated rather than incidental: the write root comes first, so a
 * bundle that exists under two roots - an operator who copied one across by hand - is
 * indexed from the write root and skipped in the legacy one, rather than flipping between
 * two identical rows on alternate passes.
 */
export class ArchiveLibrary {
  /** Where this daemon publishes. Staging, trash, and new producer namespaces live here. */
  readonly writeRoot: string;
  /** Every root discovery walks, write root first. */
  readonly roots: readonly string[];

  constructor(options: { writeRoot?: string; legacyRoots?: readonly string[] } = {}) {
    this.writeRoot = options.writeRoot ?? ARCHIVES_DIR;
    // A caller that named its own write root gets ONLY that root unless it also named the
    // legacy ones. A test or an isolated daemon pointing at a temp directory is saying
    // "this is the library", and quietly adding the machine's real one would make its
    // assertions depend on whatever else is on the disk.
    const legacy =
      options.legacyRoots ?? (options.writeRoot === undefined ? [LEGACY_SCOUTS_DIR] : []);
    this.roots = [this.writeRoot, ...legacy.filter((root) => root !== this.writeRoot)];
  }
}
