// Tiny shared flag so window/tray/index agree on whether the app is really
// quitting (Cmd-Q / tray Quit) versus just closing the window (which hides it,
// keeping the app resident in the menu bar so alerts still fire).

let quitting = false;

export const isQuitting = (): boolean => quitting;
export const setQuitting = (v: boolean): void => {
  quitting = v;
};
