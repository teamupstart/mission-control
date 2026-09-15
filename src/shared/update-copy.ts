// What an update SAYS, for the three phases a person meets on two different surfaces.
//
// The dashboard banner and the native dialog are both reachable for the same state - the
// banner when the window is up, the dialog when someone updates from the menu bar with the
// window hidden - so they have to say the same thing. Written twice, they drift: the first
// draft of this split already had one surface saying "administrator password" while the other
// said "administrator permission" and named `/Applications`.
//
// Neither of them names a directory any more, and that is a correctness fix rather than a
// wording preference: an install now lives in the signed-in account's own `~/Applications` by
// default, in `/Applications` when somebody opted into it, or somewhere else entirely. Copy
// that asserts one of those to everybody is wrong for most of them, and it is wrong about the
// administrator prompt too - a personal install never raises one.
//
// Browser-safe by construction: no `node:` imports, so the renderer and the Electron main
// process read the same strings rather than two copies of them.

export interface UpdatePhaseCopy {
  /** The headline: the banner's `<strong>`, the dialog's `message`. */
  title(version: string): string;
  /** The sentence under it: the banner's paragraph, the dialog's `detail`. */
  detail: string;
}

export function migrationReadyDetail(source: string, target: string): string {
  return `This update moves Mission Control from ${source} to ${target}. The system copy is retained for other accounts and existing sessions. Your state stays where it is. Mission Control will close and reopen from your personal Applications folder.`;
}

export function migrationCompleteDetail(target: string): string {
  return `Mission Control is installed at ${target}. The system copy was retained. Replace the old Dock shortcut with the personal app, and start fresh agent sessions to use repaired integration paths.`;
}

export const UPDATE_COPY: {
  preparing: UpdatePhaseCopy;
  cancelling: UpdatePhaseCopy;
  ready: UpdatePhaseCopy;
  applying: UpdatePhaseCopy;
} = {
  preparing: {
    title: (version) => `Preparing Mission Control ${version}`,
    detail:
      "Mission Control keeps running while the new version is built, and will ask before it restarts.",
  },
  cancelling: {
    title: (version) => `Cancelling the Mission Control ${version} update`,
    // Not "cancelled": the build is being torn down, and the offer comes back when it is
    // actually gone. Starting another one before that would put a fresh checkout and install
    // into the directory the dying processes are still writing to.
    detail: "Waiting for the build to stop. The update will be offered again in a moment.",
  },
  ready: {
    title: (version) => `Mission Control ${version} is ready to install`,
    detail:
      "Mission Control will close, install the new version where Mission Control is already installed, and reopen. This takes a few seconds, and macOS may ask for administrator permission if that is a shared system folder.",
  },
  applying: {
    title: (version) => `Installing Mission Control ${version}`,
    detail:
      "Mission Control will close and reopen on the new version in a few seconds. If macOS asks for administrator permission, it is Mission Control installing the update into the shared system folder it was installed in.",
  },
};
