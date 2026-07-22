import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionFileDocument, SessionFileEntry } from "@shared/types.ts";
import { api } from "./api.ts";

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
  selectedPath: string | null;
  mode: "preview" | "editor";
  buffers: Record<string, FileBuffer>;
}

export interface SessionFilesController {
  sessions: Record<string, SessionFilesState>;
  ensure: (sessionId: string) => void;
  refresh: (sessionId: string) => void;
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
  mode: "preview", buffers: {},
};

export function useSessionFilesStore(connected: boolean): SessionFilesController {
  const [sessions, setSessions] = useState<Record<string, SessionFilesState>>({});
  const sessionsRef = useRef(sessions);
  const connectedRef = useRef(connected);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  sessionsRef.current = sessions;
  connectedRef.current = connected;

  const update = useCallback((id: string, fn: (s: SessionFilesState) => SessionFilesState) => {
    setSessions((all) => {
      const next = { ...all, [id]: fn(all[id] ?? EMPTY_SESSION) };
      sessionsRef.current = next;
      return next;
    });
  }, []);

  const loadFile = useCallback(async (sessionId: string, filePath: string, force = false) => {
    const existing = sessionsRef.current[sessionId]?.buffers[filePath];
    if (existing && !force) return;
    const result = await api.readFile(sessionId, filePath);
    if (!result.ok) {
      update(sessionId, (s) => ({ ...s, listError: result.error }));
      return;
    }
    const doc = result.file;
    update(sessionId, (s) => ({
      ...(force && s.buffers[filePath]?.saveState !== "saved"
        ? s
        : {
            ...s,
            mode: doc.kind === "html" ? s.mode : "editor",
            buffers: {
              ...s.buffers,
              [filePath]: {
                document: doc,
                text: doc.text ?? "",
                savedText: doc.text ?? "",
                saveState: doc.editable ? "saved" as const : "readonly" as const,
                error: doc.error,
                conflict: null,
              },
            },
          }),
    }));
  }, [update]);

  const ensure = useCallback((sessionId: string) => {
    const current = sessionsRef.current[sessionId];
    if (current && current.listState !== "idle" && current.listState !== "failed") return;
    update(sessionId, (s) => ({ ...s, listState: "loading", listError: null }));
    void api.listFiles(sessionId).then((result) => {
      if (!result.ok) {
        update(sessionId, (s) => ({ ...s, listState: "failed", listError: result.error }));
        return;
      }
      update(sessionId, (s) => ({
        ...s,
        files: result.files,
        listState: "ready",
        listError: null,
        selectedPath: s.selectedPath ?? result.files[0]?.path ?? null,
      }));
      const selected = sessionsRef.current[sessionId]?.selectedPath ?? result.files[0]?.path;
      if (selected) void loadFile(sessionId, selected);
    });
  }, [loadFile, update]);

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
    if (result.ok && result.revision) {
      let needsAnother = false;
      update(sessionId, (s) => {
        const latest = s.buffers[filePath]!;
        needsAnother = latest.text !== sentText;
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
      if (needsAnother) setTimeout(() => void save(sessionId, filePath), 0);
      return;
    }
    if (result.status === 409) {
      update(sessionId, (s) => ({
        ...s,
        buffers: {
          ...s.buffers,
          [filePath]: {
            ...s.buffers[filePath]!,
            saveState: "conflict",
            error: result.error ?? "File changed on disk",
            conflict: {
              revision: result.currentRevision,
              text: result.currentText ?? null,
              deleted: result.deleted ?? false,
            },
          },
        },
      }));
      return;
    }
    update(sessionId, (s) => ({
      ...s,
      buffers: {
        ...s.buffers,
        [filePath]: {
          ...s.buffers[filePath]!,
          saveState: connectedRef.current ? "failed" : "offline",
          error: result.error ?? "Save failed",
        },
      },
    }));
  }, [update]);

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
    update(sessionId, (s) => ({ ...s, selectedPath: filePath }));
    void loadFile(sessionId, filePath);
  }, [loadFile, save, update]);

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
    update(sessionId, (s) => ({ ...s, listState: "loading", listError: null }));
    void api.listFiles(sessionId).then((result) => {
      if (!result.ok) return update(sessionId, (s) => ({ ...s, listState: "failed", listError: result.error }));
      update(sessionId, (s) => ({ ...s, files: result.files, listState: "ready", listError: null }));
      const selected = sessionsRef.current[sessionId]?.selectedPath;
      const buffer = selected ? sessionsRef.current[sessionId]?.buffers[selected] : null;
      if (selected && buffer?.saveState === "saved") void loadFile(sessionId, selected, true);
    });
  }, [loadFile, update]);

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
    sessions, ensure, refresh, select, setMode, edit, flush, retry, reloadDisk, overwriteDisk, drop,
  }), [sessions, ensure, refresh, select, setMode, edit, flush, retry, reloadDisk, overwriteDisk, drop]);
}
