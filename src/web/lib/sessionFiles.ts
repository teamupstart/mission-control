import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionFileDocument, SessionFileEntry } from "@shared/types.ts";
import { api } from "./api.ts";
import { pathDefaultsToPreview } from "./workspaceLinks.ts";

export type FileSaveState =
  | "saved"
  | "modified"
  | "saving"
  | "offline"
  | "failed"
  | "conflict"
  | "readonly";

export interface FileConflictState {
  revision?: string;
  text: string | null;
  deleted: boolean;
}

export interface FileBuffer {
  document: SessionFileDocument;
  text: string;
  savedText: string;
  saveState: FileSaveState;
  error: string | null;
  conflict: FileConflictState | null;
}

export interface SessionFilesState {
  files: SessionFileEntry[];
  listState: "idle" | "loading" | "ready" | "failed";
  listError: string | null;
  openError: string | null;
  selectedPath: string | null;
  mode: "preview" | "editor";
  buffers: Record<string, FileBuffer>;
}

export interface SessionFilesController {
  sessions: Record<string, SessionFilesState>;
  /**
   * The checkout listing by session, for readers that must answer "is this a real file?"
   * about many paths at once and synchronously - the transcript's path links. Absent until
   * something asked; `warmPaths` is that ask, and it shares one request with `probe` (see
   * `listPaths`), so those two can never hold different answers.
   *
   * The Files tab is NOT on that shared request. `ensure` and `refresh` list the checkout
   * themselves and publish the result here, which converges the ANSWER without sharing the
   * REQUEST - opening a transcript and then its Files tab costs two listings. That is the
   * accurate promise, and it is the one worth keeping: what matters is that no two readers
   * disagree about which files exist, not that the daemon is asked exactly once.
   */
  pathIndex: Record<string, ReadonlySet<string>>;
  ensure: (sessionId: string) => void;
  refresh: (sessionId: string) => void;
  /** Load `pathIndex` for a session. Idempotent, and a no-op once the listing is in. */
  warmPaths: (sessionId: string) => void;
  probe: (sessionId: string, path: string) => Promise<boolean>;
  select: (sessionId: string, path: string) => void;
  setMode: (sessionId: string, mode: "preview" | "editor") => void;
  edit: (sessionId: string, path: string, text: string) => void;
  flush: (sessionId: string, path?: string) => void;
  retry: (sessionId: string, path: string) => void;
  reloadDisk: (sessionId: string, path: string) => void;
  overwriteDisk: (sessionId: string, path: string) => void;
  drop: (sessionId: string) => void;
}

const EMPTY_SESSION: SessionFilesState = {
  files: [], listState: "idle", listError: null, selectedPath: null,
  openError: null, mode: "preview", buffers: {},
};

export class LatestFileRequests {
  private sequence = 0;
  private readonly latest = new Map<string, number>();

  begin(key: string): number {
    const request = ++this.sequence;
    this.latest.set(key, request);
    return request;
  }

  isCurrent(key: string, request: number): boolean {
    return this.latest.get(key) === request;
  }

  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.latest.keys()) {
      if (key.startsWith(prefix)) this.latest.delete(key);
    }
  }
}

export function updateExistingSession(
  all: Record<string, SessionFilesState>,
  id: string,
  fn: (session: SessionFilesState) => SessionFilesState,
): Record<string, SessionFilesState> {
  const current = all[id];
  if (!current) return all;
  const updated = fn(current);
  return updated === current ? all : { ...all, [id]: updated };
}

function hasLocalFileChanges(buffer: FileBuffer): boolean {
  return buffer.saveState !== "saved" && buffer.saveState !== "readonly";
}

/**
 * The two ways the bytes on disk can be older than what the human is looking at - which
 * matters to any reader that goes to the FILE rather than to this buffer (every "Open in"
 * target does).
 *
 * They are split because the ANSWER differs, not the question: a pending write will land,
 * so a caller waits for it; an unwritten one will not, so a caller that waits waits
 * forever and one that proceeds shows the version before the edit. Together they are
 * `hasLocalFileChanges` above, which is why neither may be spelled out at a call site -
 * a third state added to `FileSaveState` has to land in exactly one of these.
 */
export function isSavePending(buffer: FileBuffer): boolean {
  return buffer.saveState === "modified" || buffer.saveState === "saving";
}

/** Edits exist, are NOT on disk, and nothing is going to write them: the refusal case. */
export function hasUnwrittenEdits(buffer: FileBuffer): boolean {
  return hasLocalFileChanges(buffer) && !isSavePending(buffer);
}

export function applyFileLoadFailure(
  state: SessionFilesState,
  filePath: string,
  error: string,
): SessionFilesState {
  const buffer = state.buffers[filePath];
  let buffers = state.buffers;
  if (buffer && !hasLocalFileChanges(buffer)) {
    buffers = { ...state.buffers };
    delete buffers[filePath];
  }
  if (state.selectedPath !== filePath && buffers === state.buffers) return state;
  return {
    ...state,
    buffers,
    openError: state.selectedPath === filePath ? error : state.openError,
  };
}

export function applyFileLoadSuccess(
  state: SessionFilesState,
  filePath: string,
  doc: SessionFileDocument,
  force: boolean,
): SessionFilesState {
  const current = state.buffers[filePath];
  const selected = state.selectedPath === filePath;
  if (force && current && hasLocalFileChanges(current)) {
    return selected && state.openError ? { ...state, openError: null } : state;
  }
  return {
    ...state,
    mode: selected && doc.kind !== "html" && doc.kind !== "markdown" ? "editor" : state.mode,
    openError: selected ? null : state.openError,
    buffers: {
      ...state.buffers,
      [filePath]: {
        document: doc,
        text: doc.text ?? "",
        savedText: doc.text ?? "",
        saveState: doc.editable ? "saved" : "readonly",
        error: doc.error,
        conflict: null,
      },
    },
  };
}

export function useSessionFilesStore(connected: boolean): SessionFilesController {
  const [sessions, setSessions] = useState<Record<string, SessionFilesState>>({});
  const [pathIndex, setPathIndex] = useState<Record<string, ReadonlySet<string>>>({});
  const sessionsRef = useRef(sessions);
  const pathIndexRef = useRef(pathIndex);
  const connectedRef = useRef(connected);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  const requests = useRef(new LatestFileRequests());
  const probeFiles = useRef(new Map<string, Promise<ReadonlySet<string>>>());
  sessionsRef.current = sessions;
  pathIndexRef.current = pathIndex;
  connectedRef.current = connected;

  /**
   * The one listing behind both the ambiguous-link probe and the transcript's path links,
   * memoized per session. Two callers meant two `git ls-files` runs over the same checkout
   * and, worse, two answers to "does this file exist" that could disagree while one was in
   * flight.
   *
   * Those two and no more: `ensure` and `refresh` deliberately do not come through here,
   * because they need the full `SessionFileEntry` rows and the request-ordering guard that
   * goes with rendering a list, not the set of paths. They publish into `pathIndex`
   * instead, which is what keeps the answers in step without pretending one request serves
   * every reader.
   */
  const listPaths = useCallback((sessionId: string): Promise<ReadonlySet<string>> => {
    let pending = probeFiles.current.get(sessionId);
    if (!pending) {
      pending = api.listFiles(sessionId).then((result) => (
        new Set(result.ok ? result.files.map((file) => file.path) : [])
      ));
      probeFiles.current.set(sessionId, pending);
    }
    return pending;
  }, []);

  /** A listing the Files tab just fetched answers the transcript's question too. */
  const publishPaths = useCallback((sessionId: string, files: SessionFileEntry[]) => {
    const paths: ReadonlySet<string> = new Set(files.map((file) => file.path));
    setPathIndex((all) => {
      const next = { ...all, [sessionId]: paths };
      pathIndexRef.current = next;
      return next;
    });
  }, []);

  const update = useCallback((id: string, fn: (s: SessionFilesState) => SessionFilesState) => {
    setSessions((all) => {
      const next = { ...all, [id]: fn(all[id] ?? EMPTY_SESSION) };
      sessionsRef.current = next;
      return next;
    });
  }, []);

  const updateExisting = useCallback((id: string, fn: (s: SessionFilesState) => SessionFilesState) => {
    setSessions((all) => {
      const next = updateExistingSession(all, id, fn);
      sessionsRef.current = next;
      return next;
    });
  }, []);

  const loadFile = useCallback(async (sessionId: string, filePath: string, force = false): Promise<boolean> => {
    const existing = sessionsRef.current[sessionId]?.buffers[filePath];
    if (existing && !force) return true;
    const key = `${sessionId}\0file\0${filePath}`;
    const request = requests.current.begin(key);
    const result = await api.readFile(sessionId, filePath);
    if (!requests.current.isCurrent(key, request)) return result.ok;
    if (!result.ok) {
      updateExisting(sessionId, (s) => applyFileLoadFailure(s, filePath, result.error));
      return false;
    }
    updateExisting(sessionId, (s) => applyFileLoadSuccess(s, filePath, result.file, force));
    return true;
  }, [updateExisting]);

  const ensure = useCallback((sessionId: string) => {
    const current = sessionsRef.current[sessionId];
    if (current && current.listState !== "idle" && current.listState !== "failed") return;
    const key = `${sessionId}\0list`;
    const request = requests.current.begin(key);
    update(sessionId, (s) => ({ ...s, listState: "loading", listError: null }));
    void api.listFiles(sessionId).then((result) => {
      if (!requests.current.isCurrent(key, request)) return;
      if (!result.ok) {
        updateExisting(sessionId, (s) => ({ ...s, listState: "failed", listError: result.error }));
        return;
      }
      const retained = sessionsRef.current[sessionId];
      if (!retained) return;
      publishPaths(sessionId, result.files);
      const selected = retained.selectedPath ?? result.files[0]?.path ?? null;
      updateExisting(sessionId, (s) => ({
        ...s,
        files: result.files,
        listState: "ready",
        listError: null,
        selectedPath: selected,
      }));
      if (selected) void loadFile(sessionId, selected);
    });
  }, [loadFile, update, updateExisting]);

  const save = useCallback(async (sessionId: string, filePath: string, forceRevision?: string) => {
    const key = `${sessionId}\0${filePath}`;
    if (inFlight.current.has(key)) return;
    const buffer = sessionsRef.current[sessionId]?.buffers[filePath];
    if (!buffer || !buffer.document.editable || buffer.saveState === "saved") return;
    if (buffer.saveState === "conflict" && !forceRevision) return;
    if (!connectedRef.current) {
      update(sessionId, (s) => ({
        ...s, buffers: { ...s.buffers, [filePath]: { ...s.buffers[filePath]!, saveState: "offline" } },
      }));
      return;
    }
    inFlight.current.add(key);
    const sentText = buffer.text;
    const expected = forceRevision ?? buffer.document.revision;
    update(sessionId, (s) => ({
      ...s, buffers: { ...s.buffers, [filePath]: { ...s.buffers[filePath]!, saveState: "saving", error: null } },
    }));
    const result = await api.saveFile(sessionId, filePath, sentText, expected);
    inFlight.current.delete(key);
    const retained = sessionsRef.current[sessionId]?.buffers[filePath];
    if (!retained) return;
    if (result.ok && result.revision) {
      updateExisting(sessionId, (s) => {
        const latest = s.buffers[filePath];
        if (!latest) return s;
        const needsAnother = latest.text !== sentText;
        return {
          ...s,
          buffers: {
            ...s.buffers,
            [filePath]: {
              ...latest,
              document: { ...latest.document, revision: result.revision!, mtime: result.mtime ?? latest.document.mtime },
              savedText: sentText,
              saveState: needsAnother ? "modified" : "saved",
              error: null,
              conflict: null,
            },
          },
        };
      });
      setTimeout(() => {
        if (sessionsRef.current[sessionId]?.buffers[filePath]?.saveState === "modified") {
          void save(sessionId, filePath);
        }
      }, 0);
      return;
    }
    if (result.status === 409) {
      updateExisting(sessionId, (s) => {
        const latest = s.buffers[filePath];
        if (!latest) return s;
        return {
          ...s,
          buffers: {
            ...s.buffers,
            [filePath]: {
              ...latest,
              saveState: "conflict",
              error: result.error ?? "File changed on disk",
              conflict: {
                revision: result.currentRevision,
                text: result.currentText ?? null,
                deleted: result.deleted ?? false,
              },
            },
          },
        };
      });
      return;
    }
    updateExisting(sessionId, (s) => {
      const latest = s.buffers[filePath];
      if (!latest) return s;
      return {
        ...s,
        buffers: {
          ...s.buffers,
          [filePath]: {
            ...latest,
            saveState: connectedRef.current ? "failed" : "offline",
            error: result.error ?? "Save failed",
          },
        },
      };
    });
  }, [update, updateExisting]);

  const schedule = useCallback((sessionId: string, filePath: string) => {
    const key = `${sessionId}\0${filePath}`;
    const old = timers.current.get(key);
    if (old) clearTimeout(old);
    timers.current.set(key, setTimeout(() => {
      timers.current.delete(key);
      void save(sessionId, filePath);
    }, 750));
  }, [save]);

  const select = useCallback((sessionId: string, filePath: string) => {
    const previous = sessionsRef.current[sessionId]?.selectedPath;
    if (previous && previous !== filePath) void save(sessionId, previous);
    update(sessionId, (s) => ({
      ...s,
      selectedPath: filePath,
      openError: null,
      mode: pathDefaultsToPreview(filePath) ? "preview" : "editor",
    }));
    void loadFile(sessionId, filePath, true);
  }, [loadFile, save, update]);

  const probe = useCallback(async (sessionId: string, filePath: string): Promise<boolean> => {
    const listed = sessionsRef.current[sessionId];
    if (listed?.listState === "ready") return listed.files.some((file) => file.path === filePath);
    return (await listPaths(sessionId)).has(filePath);
  }, [listPaths]);

  const warmPaths = useCallback((sessionId: string) => {
    if (pathIndexRef.current[sessionId]) return;
    // The same staleness guard every other fetch in this file uses, and it is load
    // bearing for the SAME reason `drop` already calls `forgetSession`: a warm that is
    // still in flight when the session goes away would otherwise land afterwards and
    // write an index back for a session nobody is showing. Nothing clears that - `drop`
    // has already run - so it leaks until the tab closes, and if the id is ever reused
    // the `pathIndexRef` check above turns it into a real defect: the new transcript
    // skips its own warm and links against the OLD checkout's files. Checking "is the
    // key still absent" cannot see this, because after `drop` it is absent by design.
    const key = `${sessionId}\0paths`;
    const request = requests.current.begin(key);
    void listPaths(sessionId).then((paths) => {
      if (!requests.current.isCurrent(key, request)) return;
      setPathIndex((all) => {
        // A listing that lost a race to `refresh` must not replace the newer one.
        if (all[sessionId]) return all;
        const next = { ...all, [sessionId]: paths };
        pathIndexRef.current = next;
        return next;
      });
    });
  }, [listPaths]);

  const edit = useCallback((sessionId: string, filePath: string, text: string) => {
    update(sessionId, (s) => {
      const buffer = s.buffers[filePath];
      if (!buffer || !buffer.document.editable || buffer.saveState === "conflict") return s;
      return {
        ...s,
        buffers: { ...s.buffers, [filePath]: { ...buffer, text, saveState: "modified", error: null } },
      };
    });
    schedule(sessionId, filePath);
  }, [schedule, update]);

  const flush = useCallback((sessionId: string, filePath?: string) => {
    const selected = filePath ?? sessionsRef.current[sessionId]?.selectedPath;
    if (selected) void save(sessionId, selected);
  }, [save]);

  const refresh = useCallback((sessionId: string) => {
    // The promise cache is dropped so the next asker re-lists, but `pathIndex` is left
    // standing until the new listing lands below: clearing it here would un-link every
    // path in the open transcript for the length of one `git ls-files`, and leave them
    // that way if the re-list fails.
    probeFiles.current.delete(sessionId);
    const key = `${sessionId}\0list`;
    const request = requests.current.begin(key);
    update(sessionId, (s) => ({ ...s, listState: "loading", listError: null }));
    void api.listFiles(sessionId).then((result) => {
      if (!requests.current.isCurrent(key, request)) return;
      if (!result.ok) return updateExisting(sessionId, (s) => ({ ...s, listState: "failed", listError: result.error }));
      publishPaths(sessionId, result.files);
      updateExisting(sessionId, (s) => ({ ...s, files: result.files, listState: "ready", listError: null }));
      const selected = sessionsRef.current[sessionId]?.selectedPath;
      const buffer = selected ? sessionsRef.current[sessionId]?.buffers[selected] : null;
      if (selected && buffer?.saveState === "saved") void loadFile(sessionId, selected, true);
    });
  }, [loadFile, update, updateExisting]);

  const setMode = useCallback((sessionId: string, mode: "preview" | "editor") => {
    update(sessionId, (s) => ({ ...s, mode }));
  }, [update]);

  const retry = useCallback((sessionId: string, filePath: string) => void save(sessionId, filePath), [save]);
  const reloadDisk = useCallback((sessionId: string, filePath: string) => {
    const conflict = sessionsRef.current[sessionId]?.buffers[filePath]?.conflict;
    if (!conflict || conflict.deleted || conflict.text == null || !conflict.revision) return;
    update(sessionId, (s) => {
      const buffer = s.buffers[filePath]!;
      return {
        ...s,
        buffers: {
          ...s.buffers,
          [filePath]: {
            ...buffer,
            document: { ...buffer.document, revision: conflict.revision! },
            text: conflict.text!, savedText: conflict.text!, saveState: "saved", error: null, conflict: null,
          },
        },
      };
    });
  }, [update]);
  const overwriteDisk = useCallback((sessionId: string, filePath: string) => {
    const revision = sessionsRef.current[sessionId]?.buffers[filePath]?.conflict?.revision;
    if (revision) void save(sessionId, filePath, revision);
  }, [save]);
  const drop = useCallback((sessionId: string) => {
    requests.current.forgetSession(sessionId);
    probeFiles.current.delete(sessionId);
    setPathIndex((all) => {
      if (!all[sessionId]) return all;
      const next = { ...all };
      delete next[sessionId];
      pathIndexRef.current = next;
      return next;
    });
    for (const [key, timer] of timers.current) {
      if (key.startsWith(`${sessionId}\0`)) {
        clearTimeout(timer);
        timers.current.delete(key);
      }
    }
    setSessions((all) => {
      const next = { ...all };
      delete next[sessionId];
      sessionsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!connected) return;
    for (const [sessionId, state] of Object.entries(sessionsRef.current)) {
      for (const [filePath, buffer] of Object.entries(state.buffers)) {
        if (buffer.saveState === "offline") void save(sessionId, filePath);
      }
    }
  }, [connected, save]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
  }, []);

  return useMemo(() => ({
    sessions, pathIndex, ensure, refresh, warmPaths, probe, select, setMode, edit, flush,
    retry, reloadDisk, overwriteDisk, drop,
  }), [
    sessions, pathIndex, ensure, refresh, warmPaths, probe, select, setMode, edit, flush,
    retry, reloadDisk, overwriteDisk, drop,
  ]);
}

/**
 * The checkout listing behind one session's transcript, asked for only when a transcript
 * is actually on screen.
 *
 * A hook rather than two props because the read and the ask are one decision: a caller
 * that reads the index without warming it renders dead paths for ever, and one that warms
 * without reading pays for a listing it never uses. `enabled` is where the cost is
 * declined - a session with no checkout has nothing to list. The optional controller is
 * for the render-only tests that stub it away; there is no session-files store in a
 * `renderToStaticMarkup` tree, and no effects run there either.
 */
export function useWorkspacePaths(
  files: SessionFilesController | undefined,
  sessionId: string,
  enabled: boolean,
): ReadonlySet<string> | null {
  const warm = files?.warmPaths;
  useEffect(() => {
    if (enabled) warm?.(sessionId);
  }, [enabled, sessionId, warm]);
  return (enabled ? files?.pathIndex?.[sessionId] : null) ?? null;
}
