import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "@shared/attachments.ts";
import { uploadImage } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Dropping images onto a compose box, the way the agent CLIs take them.
 *
 * An image can't ride the wire to an agent - the last hop is keystrokes into a
 * pty - so a drop uploads the file to the daemon and keeps the PATH it wrote,
 * which the send then pastes into the prompt. That's the same bargain a terminal
 * strikes when you drag a file onto it, so an agent needs no new trick to read it.
 *
 * The upload starts on drop, not on send: by the time someone finishes typing,
 * the path is already in hand, so the send stays a single round-trip and a
 * rejected image (wrong type, too big) says so on its own chip while there's still
 * a prompt to fix rather than failing the send.
 */

/** One dropped image, from local preview through to the path a prompt can cite. */
export interface PendingAttachment {
  /** Client-side identity; the stored basename isn't known until the upload lands. */
  id: string;
  /** The client's filename, which is what the human recognises on the chip. */
  name: string;
  /** Object URL for the thumbnail. Owned by whoever holds this list - see `revokeAttachments`. */
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  /** The daemon's absolute path. Present only once `status` is "ready". */
  upload?: Attachment;
  /** Opaque daemon-issued locator. Workflow evidence sends this and never sends `upload.path`. */
  uploadId?: string;
  /** Exact decoded size returned by the daemon after it sniffed and stored the image. */
  bytes?: number;
  /** Browser-reported MIME, used only for intake copy; the daemon sniffs the actual bytes. */
  mimeType?: string;
  error?: string;
}

/** The uploads that can actually be cited in a prompt - the rest aren't ready to send. */
export function readyAttachments(list: readonly PendingAttachment[]): Attachment[] {
  return list.flatMap((a) => (a.upload ? [a.upload] : []));
}

/**
 * Release the thumbnails' object URLs. The owner of the list calls this when the
 * list goes away, because only the owner knows whether it's going away: the
 * dispatch draft deliberately outlives its modal, so revoking on unmount there
 * would blank the thumbnails of a task that's still being written.
 */
export function revokeAttachments(list: readonly PendingAttachment[]): void {
  for (const a of list) URL.revokeObjectURL(a.previewUrl);
}

let seq = 0;

/**
 * A wired compose surface. Named because it's passed down: a compose box is often a
 * child of the component that owns the attachment list (the work queue's add box is
 * rendered from two branches of its panel), and the whole bundle travels together.
 */
export interface ImageDrop {
  /** True while a drag carrying files is over the surface - raise the veil. */
  dropping: boolean;
  /** True while any attachment is still uploading; sending now would drop it. */
  uploading: boolean;
  addFiles: (files: readonly File[]) => void;
  remove: (id: string) => void;
  dropProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  onPaste: (e: React.ClipboardEvent) => void;
}

/**
 * Wire a compose surface for image drops and pastes.
 *
 * Controlled, not stateful: the caller owns the list because the callers keep it for
 * different spans - the transcript reply and the queue's add box die with the card,
 * the dispatch draft survives close/reopen.
 */
export function useImageDrop({
  attachments,
  onChange,
  disabled = false,
  windowTarget = false,
}: {
  attachments: PendingAttachment[];
  onChange: (next: PendingAttachment[]) => void;
  disabled?: boolean;
  /** Let a transient mode accept the same drop anywhere in the browser window. */
  windowTarget?: boolean;
}): ImageDrop {
  const [dropping, setDropping] = useState(false);
  // Dragging over a child fires dragleave on the parent, so a boolean would flicker
  // the overlay off as the cursor crosses the textarea. Count enters against leaves.
  const depth = useRef(0);

  // An upload resolves long after the render that started it, and `attachments` is
  // a prop - so patches read the list through a ref rather than the closure that
  // happened to be current at drop time. This is `setState(fn)` for lifted state.
  const listRef = useRef(attachments);
  listRef.current = attachments;
  const patch = useCallback(
    (id: string, fields: Partial<PendingAttachment>) => {
      onChange(listRef.current.map((a) => (a.id === id ? { ...a, ...fields } : a)));
    },
    [onChange],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      // Anything that isn't an image is someone dragging a stray file across the
      // window, not an attachment they meant - the daemon sniffs the bytes too, but
      // there's no reason to make the round-trip to learn that.
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (disabled || images.length === 0) return;
      const added = images.map<PendingAttachment>((file) => ({
        id: `att-${++seq}`,
        name: file.name || "pasted image",
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
        mimeType: file.type,
      }));
      onChange([...listRef.current, ...added]);
      added.forEach((att, i) => {
        void uploadImage(images[i]!).then((r) => {
          // Dropped again while it uploaded? The patch is keyed by id, so a removed
          // chip simply finds no row and the late reply lands nowhere.
          if (r.ok) {
            patch(att.id, {
              status: "ready",
              upload: r.upload,
              uploadId: r.uploadId,
              bytes: r.bytes,
            });
          }
          else patch(att.id, { status: "error", error: r.error });
        });
      });
    },
    [disabled, onChange, patch],
  );

  const remove = useCallback(
    (id: string) => {
      const gone = listRef.current.find((a) => a.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      onChange(listRef.current.filter((a) => a.id !== id));
    },
    [onChange],
  );

  /**
   * The common sliver of React's synthetic drag event and the browser's native one.
   * Native `dataTransfer` is nullable, so the shared handlers keep that honest even
   * though React guarantees it on the compose box callbacks.
   */
  type ImageDragEvent = {
    dataTransfer: DataTransfer | null;
    preventDefault: () => void;
  };

  /** True when the drag carries files at all - a dragged link or selection doesn't. */
  const carriesFiles = (e: ImageDragEvent): boolean =>
    e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes("Files");

  const onDragEnter = useCallback(
    (e: ImageDragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDropping(true);
    },
    [disabled],
  );
  const onDragOver = useCallback(
    (e: ImageDragEvent) => {
      if (disabled || !carriesFiles(e) || e.dataTransfer === null) return;
      // Without this the browser navigates to the dropped file and the page is gone.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );
  const onDragLeave = useCallback(
    (e: ImageDragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDropping(false);
    },
    [disabled],
  );
  const onDrop = useCallback(
    (e: ImageDragEvent) => {
      if (disabled || !carriesFiles(e) || e.dataTransfer === null) return;
      e.preventDefault();
      // A drop ends the drag outright; a leave for each enter never arrives.
      depth.current = 0;
      setDropping(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles, disabled],
  );

  /**
   * Guided dispatch temporarily makes the Task box inert so its mnemonic keys cannot type.
   * While that phase owns the dialog, route the exact same handlers from the window instead.
   * The opt-in listener disappears at handoff, leaving every ordinary compose surface scoped
   * to its own box as before.
   */
  useEffect(() => {
    if (!windowTarget) return;
    const enter = (e: DragEvent): void => onDragEnter(e);
    const over = (e: DragEvent): void => onDragOver(e);
    const leave = (e: DragEvent): void => onDragLeave(e);
    const dropped = (e: DragEvent): void => onDrop(e);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", dropped);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", dropped);
      depth.current = 0;
      setDropping(false);
    };
  }, [onDragEnter, onDragLeave, onDragOver, onDrop, windowTarget]);

  return {
    dropping,
    uploading: attachments.some((a) => a.status === "uploading"),
    addFiles,
    remove,
    dropProps: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
    },
    // A screenshot on the clipboard is the same gesture by another route (⌃⇧⌘4),
    // and arrives as a file on the paste event. Pasted TEXT must fall through
    // untouched, hence no unconditional preventDefault.
    onPaste: (e) => {
      const files = Array.from(e.clipboardData.files);
      if (disabled || files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
  };
}

/** The row of thumbnails under a compose box. Renders nothing when empty. */
export function AttachmentStrip({
  attachments,
  onRemove,
  removeContext = "this message",
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
  removeContext?: string;
}): React.JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <ul className="attach-strip">
      {attachments.map((a) => (
        <li key={a.id} className={`attach-chip is-${a.status}`}>
          {a.status === "error" ? (
            // No thumbnail on a rejected drop. The file that failed is usually one
            // the browser can't paint either, so an <img> here renders as a broken-
            // image icon - which reads as "the chip is broken" rather than "the file
            // was refused", right next to the sentence explaining the refusal.
            <span className="attach-warn" aria-hidden="true">
              !
            </span>
          ) : (
            <img className="attach-thumb" src={a.previewUrl} alt="" />
          )}
          {/* The tooltip goes on the truncated text, NOT on the chip: the chip contains
              the remove button, and a tooltip wrapping both would put two bubbles on
              screen the moment you reached for the ✕. */}
          <Tooltip label={a.status === "error" ? (a.error ?? a.name) : a.name}>
            <span className="attach-name">{a.status === "error" ? a.error : a.name}</span>
          </Tooltip>
          <Tooltip label={`Remove ${a.name} from ${removeContext}`}>
            <button
              type="button"
              className="attach-remove"
              aria-label={`Remove ${a.name}`}
              onClick={() => onRemove(a.id)}
            >
              ✕
            </button>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
