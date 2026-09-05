// What an update SAYS, for the three phases a person meets on two different surfaces.
//
// The dashboard banner and the native dialog are both reachable for the same state - the
// banner when the window is up, the dialog when someone updates from the menu bar with the
// window hidden - so they have to say the same thing. Written twice, they drift: the first
// draft of this split already had one surface saying "administrator password" while the other
// said "administrator permission" and named `/Applications`.
//
// Browser-safe by construction: no `node:` imports, so the renderer and the Electron main
// process read the same strings rather than two copies of them.

export interface UpdatePhaseCopy {
  /** The headline: the banner's `<strong>`, the dialog's `message`. */
  title(version: string): string;
  /** The sentence under it: the banner's paragraph, the dialog's `detail`. */
  detail: string;
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
      "Mission Control will close, install the new version in /Applications, and reopen. This takes a few seconds, and macOS may ask for administrator permission.",
  },
  applying: {
    title: (version) => `Installing Mission Control ${version}`,
    detail:
      "Mission Control will close and reopen on the new version in a few seconds. If macOS asks for administrator permission, it is Mission Control installing the update in /Applications.",
  },
};
