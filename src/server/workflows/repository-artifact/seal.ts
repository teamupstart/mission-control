import { locateExecutable } from "../../executables/locator.ts";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  REPOSITORY_HISTORY_POLICY_V1 as policy,
  type RepositoryViewDescriptor,
} from "@shared/repository-access.ts";
import { RepositoryPathSchema } from "@shared/repository-policy.ts";
import {
  allowed as pathAllowed,
  decodedPath,
  sample,
  validPath,
  workingFile,
  type Layer,
} from "./checkout.ts";
import { checkoutGit, openObjectReader } from "./git.ts";
import {
  descriptor,
  manifestSchema,
  RepositoryCaptureChanged,
  objectBytes,
  oid,
  sha256,
  unavailable,
  type Manifest,
  type ObjectRecord,
} from "./format.ts";

/** sourceBase is the resolved commit used by Workflow diff evidence, including stacked bases. */
export interface RepositoryCaptureInput {
  checkout: string;
  sourceBase: string | null;
}

type CheckoutState = Awaited<ReturnType<typeof sample>>;
function metadataBoundary(state: CheckoutState) {
  return JSON.stringify({ ...state, index: [...state.index], skipWorktree: [...state.skipWorktree] });
}
function checkoutBoundary(state: CheckoutState, working: Layer) {
  return sha256(JSON.stringify([metadataBoundary(state), [...working]]));
}

async function scanWorking(
  executable: string,
  state: CheckoutState,
  signal: AbortSignal,
  accept?: (id: string, bytes: Buffer) => Promise<void>,
) {
  const layer: Layer = new Map();
  const embedded = new Set(state.embedded);
  for (const key of state.paths) {
    const file = await workingFile(executable, state, key, embedded.has(key), signal);
    if (!file) continue;
    if (file.entry) layer.set(key, file.entry);
    else if (file.data && file.mode) {
      const id = createHash(state.format)
        .update(`blob ${file.data.length}\0`)
        .update(file.data)
        .digest("hex");
      layer.set(key, { id, mode: file.mode });
      if (accept) await accept(id, file.data);
    }
  }
  return layer;
}

export async function sampleCheckoutBoundary(checkout: string, signal: AbortSignal) {
  const git = await locateExecutable("git");
  if (!git) return unavailable();
  const state = await sample(git.path, checkout, signal);
  const work = await scanWorking(git.path, state, signal);
  if (metadataBoundary(state) !== metadataBoundary(await sample(git.path, checkout, signal))) {
    throw new RepositoryCaptureChanged();
  }
  return checkoutBoundary(state, work);
}

export async function seal(input: RepositoryCaptureInput, pending: string, signal: AbortSignal) {
  const git = await locateExecutable("git");
  if (!git) return unavailable();
  const state = await sample(git.path, input.checkout, signal);
  const { index, head, format, root, common } = state;
  // Workflow displays an abbreviated id. Expand that exact selection while the checkout
  // is still sampled, refusing ambiguous prefixes and never resolving a moving branch.
  let base = input.sourceBase ?? head;
  if (base !== null) {
    const width = format === "sha1" ? 40 : 64;
    if (!/^[0-9a-f]{4,64}$/.test(base) || base.length > width) unavailable();
    if (base.length < width) {
      // --disambiguate searches object ids only. A same-named ref cannot redirect a
      // short display id, and multiple matches are refused by the single-id parser.
      const matches = await checkoutGit(git.path, root, ["rev-parse", "--disambiguate=" + base], signal);
      base = oid.parse(matches.toString().trim());
    }
  }
  const pathPolicy = new Map<string, boolean>();
  const allowed = (key: string) => {
    if (!pathPolicy.has(key)) pathPolicy.set(key, pathAllowed(key));
    return pathPolicy.get(key)!;
  };
  const output = join(pending, "artifact");
  await mkdir(output);
  const objects = join(common, "objects");
  if ((await realpath(objects)) !== objects) unavailable();
  for (const file of ["info/alternates", "info/http-alternates"]) {
    if (
      await lstat(join(objects, file)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      })
    )
      unavailable();
  }
  const reader = await openObjectReader(
    git.path,
    join(pending, "wrapper"),
    objects,
    format === "sha256",
    signal,
  );
  const table = new Map<string, ObjectRecord>();
  const binary = new Set<string>();
  const denied = new Set<string>();
  const needed = new Set<string>();
  const sizes = new Map<string, number>();

  const hash = (data: Buffer) => createHash(format).update(data).digest("hex");
  async function save(type: ObjectRecord["type"], body: Buffer, expected?: string) {
    const bytes = objectBytes(type, body);
    const id = hash(bytes);
    if (expected && expected !== id) unavailable();
    if (!table.has(id)) {
      await writeFile(join(output, id), bytes, { flag: "wx", mode: 0o400, signal });
      table.set(id, { id, type, mode: 0o400, size: body.length, sha256: sha256(bytes) });
      if (type === "blob" && (body.includes(0) || !isUtf8(body))) binary.add(id);
    }
    return id;
  }

  const commits = new Map<
    string,
    { data: Buffer; record: RepositoryViewDescriptor["retainedRevisions"][number] }
  >();
  async function commit(id: string) {
    const cached = commits.get(id);
    if (cached) return cached;
    const { data } = await reader.get(id, "commit");
    const headers = data.toString("latin1").split("\n\n", 1)[0]!.split("\n");
    const tree = oid.parse(headers[0]?.match(/^tree (.+)$/)?.[1]);
    const parents = headers.filter((h) => h.startsWith("parent ")).map((h) => oid.parse(h.slice(7)));
    const result = { data, record: { id, tree, parents } };
    commits.set(id, result);
    return result;
  }

  const trees = new Map<string, Buffer>();
  const includedTrees = new Set<string>();
  async function flatten(tree: string, incremental = false) {
    const layer: Layer = new Map();
    const treeIds = new Set<string>();
    async function visit(id: string, prefix: Buffer) {
      signal.throwIfAborted();
      const location = id + ":" + prefix.toString("hex");
      if (incremental && includedTrees.has(location)) return;
      // Traversal stops altogether at the first overflow, so rejected subtrees cannot
      // influence the selection of any later revision.
      includedTrees.add(location);
      treeIds.add(id);
      let bytes = trees.get(id);
      if (!bytes) {
        bytes = (await reader.get(id, "tree")).data;
        if (hash(objectBytes("tree", bytes)) !== id) unavailable();
        trees.set(id, bytes);
      }
      for (let pos = 0; pos < bytes.length;) {
        const space = bytes.indexOf(32, pos),
          nul = bytes.indexOf(0, space + 1);
        const end = nul + 1 + id.length / 2;
        if (space < pos || nul <= space + 1 || end > bytes.length) unavailable();
        const name = bytes.subarray(space + 1, nul);
        if (name.includes(47)) unavailable();
        const path = Buffer.concat([prefix, name]);
        const key = validPath(path);
        const child = bytes.subarray(nul + 1, end).toString("hex");
        const mode = bytes.toString("ascii", pos, space);
        if (mode === "40000") await visit(child, Buffer.concat([path, Buffer.from("/")]));
        else {
          if (!/^(100644|100755|120000|160000)$/.test(mode) || layer.has(key)) unavailable();
          layer.set(key, { mode, id: child });
        }
        pos = end;
      }
    }
    await visit(tree, Buffer.alloc(0));
    return { layer, treeIds };
  }

  async function saveTree(layer: Layer) {
    type Node = { children: Map<string, Node>; files: Map<string, { mode: string; id: string }> };
    const node = (): Node => ({ children: new Map(), files: new Map() });
    const top = node();
    for (const [key, entry] of layer) {
      const parts = Buffer.from(key, "hex").toString("latin1").split("/");
      const leaf = parts.pop()!;
      let dir = top;
      for (const part of parts) {
        if (!dir.children.has(part)) dir.children.set(part, node());
        dir = dir.children.get(part)!;
      }
      dir.files.set(leaf, entry);
    }
    async function write(dir: Node): Promise<string> {
      for (const [name, child] of dir.children) {
        if (dir.files.has(name)) unavailable();
        dir.files.set(name, { mode: "40000", id: await write(child) });
      }
      const entries = [...dir.files]
        .map(([name, e]) => ({
          sort: e.mode === "40000" ? name + "/" : name,
          data: Buffer.concat([Buffer.from(`${e.mode} ${name}\0`, "latin1"), Buffer.from(e.id, "hex")]),
        }))
        .sort((a, b) => (a.sort < b.sort ? -1 : 1));
      return save("tree", Buffer.concat(entries.map((e) => e.data)));
    }
    return write(top);
  }

  const capturedPaths = new Set<string>();
  function collect(layer: Layer) {
    for (const [key, e] of layer) {
      capturedPaths.add(key);
      if (e.mode !== "160000") (allowed(key) ? needed : denied).add(e.id);
    }
  }

  async function include(id: string, treeIds: Set<string>, layer: Layer) {
    collect(layer);
    await save("commit", (await commit(id)).data, id);
    for (const tree of treeIds) if (!table.has(tree)) await save("tree", trees.get(tree)!, tree);
  }

  try {
    let headLayer: Layer = new Map();
    let baseLayer: Layer = new Map();
    for (const anchor of new Set([head, base])) {
      if (!anchor) continue;
      const { layer, treeIds } = await flatten((await commit(anchor)).record.tree);
      await include(anchor, treeIds, layer);
      if (anchor === head) headLayer = layer;
      if (anchor === base) baseLayer = layer;
    }
    const worktree = await scanWorking(git.path, state, signal);
    collect(index);
    collect(worktree);
    const retainedRevisions: RepositoryViewDescriptor["retainedRevisions"] = [];
    const queue = head ? [head] : [];
    const seen = new Set<string>();
    let retainedBlobBytes = 0;
    for (let pos = 0; pos < queue.length && retainedRevisions.length < policy.maxCommits; pos++) {
      const id = queue[pos]!;
      if (seen.has(id)) continue;
      seen.add(id);
      const { record } = await commit(id);
      const { layer, treeIds } = await flatten(record.tree, true);
      const extra = new Set(
        [...layer]
          .filter(([key, e]) => allowed(key) && e.mode !== "160000" && !needed.has(e.id))
          .map(([, e]) => e.id),
      );
      let bytes = 0;
      for (const blob of extra) {
        const size = sizes.get(blob) ?? (await reader.get(blob, "blob", true)).size;
        sizes.set(blob, size);
        bytes += size;
        if (retainedBlobBytes + bytes > policy.maxUniqueBlobBytes) break;
      }
      if (retainedBlobBytes + bytes > policy.maxUniqueBlobBytes) break;
      await include(id, treeIds, layer);
      retainedBlobBytes += bytes;
      retainedRevisions.push(record);
      queue.push(...record.parents);
    }
    // A shared nonempty blob would disclose denied bytes through the allowed path.
    // The canonical empty blob has no payload. Path policy still denies the sensitive name.
    for (const id of denied) if (id !== state.emptyBlob && needed.has(id)) unavailable();
    const finalWork = await scanWorking(git.path, state, signal, async (id, bytes) => {
      if (needed.has(id) && !table.has(id)) await save("blob", bytes, id);
    });
    if (JSON.stringify([...finalWork]) !== JSON.stringify([...worktree]))
      throw new RepositoryCaptureChanged();
    for (const id of needed) if (!table.has(id)) await save("blob", (await reader.get(id, "blob")).data, id);
    const after = await sample(git.path, input.checkout, signal);
    if (metadataBoundary(state) !== metadataBoundary(after)) throw new RepositoryCaptureChanged();

    const indexTree = await saveTree(index),
      worktreeTree = await saveTree(worktree);
    type Classifications = RepositoryViewDescriptor["worktree"][number]["classifications"];
    // Include the path policy for every packaged revision, including historical-only names.
    const keys = [...capturedPaths].sort();
    const indexView: RepositoryViewDescriptor["index"] = [],
      workView: typeof indexView = [];
    const intent = new Set(state.intent);
    const paths = keys.map((key) => {
      const committed = headLayer.get(key),
        staged = index.get(key),
        working = worktree.get(key);
      const classes: Classifications = [];
      const equal = (a: typeof working, b: typeof working) => a?.id === b?.id && a?.mode === b?.mode;
      if (committed || baseLayer.has(key) || (!staged && !working)) classes.push("committed");
      if (!equal(staged, committed)) classes.push("staged");
      if (staged && !equal(staged, working)) classes.push("unstaged");
      if (working && !staged) classes.push(intent.has(key) ? "unstaged" : "untracked");
      if (!working && (staged || committed || baseLayer.has(key))) classes.push("deleted");
      if (!allowed(key)) classes.push("sensitive_denied");
      const path = decodedPath(key);
      if (path && RepositoryPathSchema.safeParse(path).success) {
        for (const [e, view] of [
          [staged, indexView],
          [working, workView],
        ] as const) {
          if (!e) continue;
          view.push({
            path,
            classifications: classes,
            binary: binary.has(e.id),
            blob: e.id,
            kind: e.mode === "160000" ? "submodule" : e.mode === "120000" ? "symlink" : "file",
          });
        }
      }
      return { bytes: key, allowed: allowed(key), classifications: classes };
    });
    // Tombstones let git_status report deletions. A directory/file replacement cannot add
    // a leaf above/below a live entry in the descriptor. The raw path manifest retains both.
    const live = new Set(workView.map((e) => e.path));
    const dirs = new Set<string>();
    for (const path of live) {
      const parts = path.split("/");
      for (let n = 1; n < parts.length; n++) dirs.add(parts.slice(0, n).join("/"));
    }
    for (const p of paths.filter((p) => p.classifications.includes("deleted"))) {
      const path = decodedPath(p.bytes);
      if (
        !path ||
        !RepositoryPathSchema.safeParse(path).success ||
        dirs.has(path) ||
        path.split("/").some((_, i, parts) => live.has(parts.slice(0, i).join("/")))
      )
        continue;
      workView.push({ path, classifications: p.classifications, kind: "file", binary: false, blob: null });
      live.add(path);
    }
    const ids = new Set(retainedRevisions.map((r) => r.id));
    const frontier = retainedRevisions
      .map((r) => ({ revision: r.id, omittedParents: r.parents.filter((p) => !ids.has(p)) }))
      .filter((r) => r.omittedParents.length);
    const manifest: Manifest = {
      version: 1,
      repository: sha256(common),
      view: {
        version: 1,
        policyVersion: 1,
        base,
        head,
        indexTree,
        worktreeTree,
        historyPolicy: policy,
        retainedRevisions,
        retainedCommitCount: ids.size,
        retainedBlobBytes,
        frontier,
        worktree: workView,
        index: indexView,
      },
      paths,
      objects: [...table.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
    const json = JSON.stringify(manifestSchema.parse(manifest));
    const digest = sha256(json);
    descriptor(manifest, digest, "candidate");
    await writeFile(join(output, "manifest.json"), json, { flag: "wx", signal, mode: 0o400 });
    return { digest, boundary: checkoutBoundary(state, worktree) };
  } finally {
    reader.close();
  }
}
