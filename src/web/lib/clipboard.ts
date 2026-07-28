export interface CopyTextEnvironment {
  clipboard?: Pick<Clipboard, "writeText"> | null;
  document?: Pick<Document, "activeElement" | "body" | "createElement" | "execCommand"> | null;
}

/**
 * Copy text in both secure browser contexts and the embedded Electron renderer.
 *
 * The async Clipboard API can be absent or permission-blocked even after a direct click.
 * The selected, read-only textarea is the established synchronous fallback for that case.
 */
export async function copyText(
  text: string,
  environment: CopyTextEnvironment = {
    clipboard: globalThis.navigator?.clipboard,
    document: globalThis.document,
  },
): Promise<"clipboard" | "fallback"> {
  let clipboardError: unknown = null;
  if (environment.clipboard) {
    try {
      await environment.clipboard.writeText(text);
      return "clipboard";
    } catch (error) {
      clipboardError = error;
    }
  }

  const document = environment.document;
  if (!document || typeof document.execCommand !== "function") {
    throw clipboardError instanceof Error
      ? clipboardError
      : new Error("Clipboard access is unavailable");
  }

  const target = document.createElement("textarea");
  const priorFocus = document.activeElement;
  target.value = text;
  target.setAttribute("readonly", "");
  target.style.position = "fixed";
  target.style.inset = "0 auto auto 0";
  target.style.width = "1px";
  target.style.height = "1px";
  target.style.opacity = "0";

  document.body.appendChild(target);
  try {
    target.focus();
    target.select();
    target.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) {
      throw new Error("The browser refused the clipboard copy");
    }
    return "fallback";
  } finally {
    target.remove();
    if (priorFocus && "focus" in priorFocus && typeof priorFocus.focus === "function") {
      priorFocus.focus();
    }
  }
}
