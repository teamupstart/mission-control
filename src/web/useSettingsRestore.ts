import { useCallback, useEffect, useReducer } from "react";
import {
  SETTINGS_RESTORE_CONFIRMATION,
  type SettingsBackupPublicReady,
  type SettingsBackupsListResponse,
  type SettingsRestorePreviewResult,
  type SettingsRestoreResult,
} from "@shared/settings-backups.ts";
import {
  fetchSettingsBackups,
  previewSettingsRestore,
  submitSettingsRestore,
} from "./lib/api.ts";
import { hydrateUiConfig } from "./lib/uiConfig.ts";
import {
  abandonSettingsRestore,
  beginSettingsRestore,
  finishSettingsRestore,
  reloadAfterSettingsRestore,
} from "./lib/settings-restore-coordinator.ts";

export interface SettingsRestoreState {
  list: SettingsBackupsListResponse | null;
  loading: boolean;
  listError: string | null;
  selectedId: string | null;
  preview: SettingsRestorePreviewResult | null;
  previewing: boolean;
  previewRequestId: string | null;
  dialogOpen: boolean;
  confirmation: string;
  restoring: boolean;
  result: Extract<SettingsRestoreResult, { status: "restored" }> | null;
  error: string | null;
}

export const initialSettingsRestoreState: SettingsRestoreState = {
  list: null,
  loading: true,
  listError: null,
  selectedId: null,
  preview: null,
  previewing: false,
  previewRequestId: null,
  dialogOpen: false,
  confirmation: "",
  restoring: false,
  result: null,
  error: null,
};

type Action =
  | { type: "load_start" }
  | { type: "load_success"; value: SettingsBackupsListResponse }
  | { type: "load_error"; error: string }
  | { type: "select"; id: string }
  | { type: "preview_start"; snapshotId: string; requestId: string }
  | { type: "preview_done"; snapshotId: string; requestId: string; value: SettingsRestorePreviewResult }
  | { type: "preview_error"; snapshotId: string; requestId: string; error: string }
  | {
      type: "restore_preflight_blocked";
      snapshotId: string;
      value: Extract<SettingsRestoreResult, { status: "preflight_blocked" }>;
    }
  | { type: "error"; error: string }
  | { type: "open_dialog" }
  | { type: "close_dialog" }
  | { type: "confirmation"; value: string }
  | { type: "restore_start" }
  | { type: "restore_done"; value: Extract<SettingsRestoreResult, { status: "restored" }> };

function selectedReady(
  list: SettingsBackupsListResponse | null,
  id: string | null,
): SettingsBackupPublicReady | null {
  if (!id) return null;
  const item = list?.snapshots.find((snapshot) => snapshot.id === id);
  return item?.status === "ready" ? item : null;
}

export function settingsRestoreReducer(
  state: SettingsRestoreState,
  action: Action,
): SettingsRestoreState {
  switch (action.type) {
    case "load_start": return { ...state, loading: true, listError: null };
    case "load_success": {
      const before = selectedReady(state.list, state.selectedId);
      const after = selectedReady(action.value, state.selectedId);
      const invalidated = Boolean(state.selectedId && (!before || !after || before.digest !== after.digest));
      return {
        ...state,
        list: action.value,
        loading: false,
        listError: null,
        ...(invalidated ? {
          selectedId: null,
          preview: null,
          previewing: false,
          previewRequestId: null,
          dialogOpen: false,
          confirmation: "",
        } : {}),
      };
    }
    case "load_error": return { ...state, loading: false, listError: action.error };
    case "select": return {
      ...state,
      selectedId: action.id,
      preview: null,
      previewing: false,
      previewRequestId: null,
      result: null,
      error: null,
      confirmation: "",
      dialogOpen: false,
    };
    case "preview_start": return state.selectedId === action.snapshotId
      ? {
          ...state,
          previewing: true,
          previewRequestId: action.requestId,
          error: null,
          result: null,
        }
      : state;
    case "preview_done": return state.selectedId === action.snapshotId
        && state.previewRequestId === action.requestId
      ? {
          ...state,
          previewing: false,
          previewRequestId: null,
          preview: action.value,
          error: null,
        }
      : state;
    case "preview_error": return state.selectedId === action.snapshotId
        && state.previewRequestId === action.requestId
      ? {
          ...state,
          previewing: false,
          previewRequestId: null,
          error: action.error,
        }
      : state;
    case "restore_preflight_blocked": return state.selectedId === action.snapshotId
      ? { ...state, preview: action.value }
      : state;
    case "error": return {
      ...state,
      previewing: false,
      previewRequestId: null,
      restoring: false,
      error: action.error,
    };
    case "open_dialog": return { ...state, dialogOpen: true, confirmation: "", error: null };
    case "close_dialog": return state.restoring
      ? state
      : { ...state, dialogOpen: false, confirmation: "" };
    case "confirmation": return { ...state, confirmation: action.value };
    case "restore_start": return { ...state, restoring: true, error: null };
    case "restore_done": return {
      ...state,
      restoring: false,
      dialogOpen: false,
      confirmation: "",
      result: action.value,
      error: null,
    };
  }
}

export function canSubmitSettingsRestore(state: SettingsRestoreState): boolean {
  return state.dialogOpen
    && !state.restoring
    && state.confirmation === SETTINGS_RESTORE_CONFIRMATION
    && state.preview?.status === "ready"
    && state.preview.preview.snapshotId === state.selectedId
    && selectedReady(state.list, state.selectedId)?.digest === state.preview.preview.digest;
}

export interface SettingsRestoreActions {
  reload: () => void;
  select: (id: string) => void;
  preview: () => void;
  openDialog: () => void;
  closeDialog: () => void;
  setConfirmation: (value: string) => void;
  restore: () => void;
}

export function useSettingsRestore(): {
  state: SettingsRestoreState;
  actions: SettingsRestoreActions;
} {
  const [state, dispatch] = useReducer(settingsRestoreReducer, initialSettingsRestoreState);

  const reload = useCallback(() => {
    dispatch({ type: "load_start" });
    void fetchSettingsBackups().then((result) => {
      if (result.ok) dispatch({ type: "load_success", value: result.value });
      else dispatch({ type: "load_error", error: result.error });
    });
  }, []);
  useEffect(reload, [reload]);

  const preview = useCallback(() => {
    if (!state.selectedId || state.previewing || state.restoring) return;
    const snapshotId = state.selectedId;
    const requestId = crypto.randomUUID();
    dispatch({ type: "preview_start", snapshotId, requestId });
    void previewSettingsRestore(snapshotId).then((result) => {
      if (result.ok) dispatch({ type: "preview_done", snapshotId, requestId, value: result.value });
      else if (result.value) {
        dispatch({ type: "preview_done", snapshotId, requestId, value: result.value });
      } else {
        dispatch({ type: "preview_error", snapshotId, requestId, error: result.error });
      }
    });
  }, [state.selectedId, state.previewing, state.restoring]);

  const restore = useCallback(() => {
    if (!canSubmitSettingsRestore(state) || state.preview?.status !== "ready" || !state.selectedId) return;
    const requestId = crypto.randomUUID();
    const snapshotId = state.selectedId;
    dispatch({ type: "restore_start" });
    beginSettingsRestore(requestId, () => {
      void reloadAfterSettingsRestore(hydrateUiConfig, () => window.location.reload());
    });
    void submitSettingsRestore(snapshotId, {
      expectedDigest: state.preview.preview.digest,
      requestId,
      confirmation: SETTINGS_RESTORE_CONFIRMATION,
    }).then((response) => {
      if (response.ok) {
        if (response.value.status === "restored") {
          dispatch({ type: "restore_done", value: response.value });
          finishSettingsRestore(requestId, true);
        } else {
          abandonSettingsRestore(requestId);
          dispatch({ type: "error", error: "Restore returned an unexpected result" });
        }
        return;
      }
      if (response.status !== 0) abandonSettingsRestore(requestId);
      if (response.value?.status === "preflight_blocked") {
        dispatch({ type: "restore_preflight_blocked", snapshotId, value: response.value });
      }
      dispatch({ type: "error", error: response.error });
    });
  }, [state]);

  return {
    state,
    actions: {
      reload,
      select: (id) => dispatch({ type: "select", id }),
      preview,
      openDialog: () => dispatch({ type: "open_dialog" }),
      closeDialog: () => dispatch({ type: "close_dialog" }),
      setConfirmation: (value) => dispatch({ type: "confirmation", value }),
      restore,
    },
  };
}
