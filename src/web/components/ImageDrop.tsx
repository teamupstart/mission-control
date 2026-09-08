import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "@shared/attachments.ts";
import { uploadImage } from "../lib/api.ts";
import { captureFocusBookmark, restoreFocusBookmark } from "../tour/focus-containment.ts";
import type { FocusBookmark } from "../tour/focus-containment.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
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
  maxAttachments = Number.POSITIVE_INFINITY,
  windowTarget = false,
}: {
  attachments: PendingAttachment[];
  onChange: (next: PendingAttachment[]) => void;
  disabled?: boolean;
  /** Optional surface-specific cap. Extra files are not uploaded. */
  maxAttachments?: number;
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
      const room = Math.max(0, maxAttachments - listRef.current.length);
      const images = files.filter((f) => f.type.startsWith("image/")).slice(0, room);
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
    [disabled, maxAttachments, onChange, patch],
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
  /**
   * Which chip is being previewed, held BY ID rather than as the attachment itself.
   *
   * The list is the owner's, and it changes underneath this component: an upload settles,
   * a chip is removed, a whole draft is discarded. Holding the object would keep a preview
   * open over an attachment that no longer exists - and worse, over a `previewUrl` the
   * owner has already handed to `revokeAttachments`, which paints as a broken image inside
   * a dialog claiming to show the file. Resolving the id against the CURRENT list every
   * render means the preview simply stops existing when its attachment does, with no
   * effect to keep the two in step.
   *
   * Defensive rather than a path a pointer can walk: while the dialog is up its backdrop
   * covers the ✕ that would remove the chip. What it guards is the owner mutating the list
   * from anywhere else - a draft discarded, a queue item submitted, an upload settling -
   * none of which asks this component's permission.
   */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const returnFocus = useRef<FocusBookmark | null>(null);
  const preview = attachments.find((a) => a.id === previewId) ?? null;

  const open = useCallback((id: string): void => {
    // Whatever had focus when the preview was asked for, so closing puts it back - in
    // practice the chip itself, which both routes in focus before they fire: a pointer
    // press focuses the button, and the keyboard route requires it already. Without this
    // the dialog takes focus for its close button and hands it to nothing on the way out,
    // dropping a keyboard user back at the top of the document with a half-written
    // dispatch several dozen tab stops away.
    returnFocus.current = captureFocusBookmark(document.activeElement);
    setPreviewId(id);
  }, []);
  const close = useCallback((): void => {
    setPreviewId(null);
    const bookmark = returnFocus.current;
    returnFocus.current = null;
    if (bookmark) restoreFocusBookmark(bookmark);
  }, []);

  if (attachments.length === 0) return null;
  return (
    <ul className="attach-strip">
      {attachments.map((a) => (
        <li key={a.id} className={`attach-chip is-${a.status}`}>
          {a.status === "error" ? (
            <>
              {/* No thumbnail on a rejected drop. The file that failed is usually one
                  the browser can't paint either, so an <img> here renders as a broken-
                  image icon - which reads as "the chip is broken" rather than "the file
                  was refused", right next to the sentence explaining the refusal.

                  No preview control either, for the same reason: there is nothing to
                  show, and a dialog that opened on a broken image would be the same lie
                  in a larger frame. */}
              <span className="attach-warn" aria-hidden="true">
                !
              </span>
              {/* The tooltip goes on the truncated text, NOT on the chip: the chip contains
                  the remove button, and a tooltip wrapping both would put two bubbles on
                  screen the moment you reached for the ✕. */}
              <Tooltip label={a.error ?? a.name}>
                <span className="attach-name">{a.error}</span>
              </Tooltip>
            </>
          ) : (
            /* The thumbnail and the filename together are the preview control, so the
               gesture works anywhere on the chip except the ✕ - which removes on its
               first click, and so can never be double-clicked into a preview of a file
               that is already gone.

               A real <button>, not a div with a handler: this is the whole keyboard and
               assistive-technology route to a feature whose stated gesture is
               mouse-only, and its accessible name is what an e2e spec selects by.

               Its tooltip still leads with the full filename, which is why the name span
               carried one - the chip truncates at 220px - and adds the gesture, which is
               otherwise undiscoverable. */
            <Tooltip label={`${a.name} - double-click to preview`}>
              <button
                type="button"
                className="attach-open"
                aria-label={`Preview ${a.name}`}
                // Double-click for the pointer, exactly as asked, and NOT a plain click.
                // A single-click handler here would break the requested gesture outright:
                // click one opens the dialog, and click two then lands on the backdrop that
                // has just appeared under the cursor, which closes it again.
                onDoubleClick={() => open(a.id)}
                // `detail === 0` is a click no pointer produced - Enter or Space on the
                // focused button, or a screen reader's synthesised activation. Those have
                // no second click to strand, so they open on the first.
                onClick={(e) => {
                  if (e.detail === 0) open(a.id);
                }}
              >
                <img className="attach-thumb" src={a.previewUrl} alt="" />
                <span className="attach-name">{a.name}</span>
              </button>
            </Tooltip>
          )}
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
      {preview && <AttachmentPreview attachment={preview} onClose={close} />}
    </ul>
  );
}

/**
 * One attached image at readable size.
 *
 * Rendered from the strip rather than hoisted to a screen, because the strip is the only
 * thing that knows the list is still alive: five surfaces render chips, and each would
 * otherwise need its own copy of this dialog and its own answer to "what happens when the
 * attachment is removed while it is open".
 *
 * The image is the local `previewUrl` - the same blob the chip paints - not a fetch of the
 * uploaded copy. It is already decoded and in memory, it is right even while the upload is
 * still in flight or has failed, and it means opening a preview costs no request.
 *
 * Escape and the ✕ both close, and so does the backdrop, which comes free with `Overlay`
 * and is the third thing a person tries. Escape closes THIS layer only: the strip is
 * usually inside another overlay - the dispatch modal, the product-issue modal - and the
 * registry hands the key to the topmost, so a preview opened over a half-written dispatch
 * closes without taking the dispatch with it.
 */
function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: PendingAttachment;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Overlay
      id={OVERLAY_IDS.attachmentPreview}
      onClose={onClose}
      className="modal attach-preview"
      role="dialog"
      ariaModal
      ariaLabel={`Preview of ${attachment.name}`}
    >
      <header className="modal-head">
        <strong className="attach-preview-name">{attachment.name}</strong>
        <Tooltip label="Close the preview (Escape)">
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            autoFocus
            onClick={onClose}
          >
            ✕
          </button>
        </Tooltip>
      </header>
      {/* `.modal-body` rather than a bare div: it carries the shell's own inset, so the
          image clears the panel border without this component knowing what the inset is. */}
      <div className="modal-body attach-preview-body">
        {/* Named, not `alt=""`. The chip's thumbnail is decoration beside a filename that
            is already read out; this IS the content of the dialog. */}
        <img className="attach-preview-image" src={attachment.previewUrl} alt={attachment.name} />
      </div>
    </Overlay>
  );
}
