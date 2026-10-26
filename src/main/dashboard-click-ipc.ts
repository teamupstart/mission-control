// Synchronous IPC through which the dashboard preload arms one exact trusted click.
//
// Electron's `event.returnValue` is not a field: its setter sends the synchronous reply, and
// only the first assignment reaches the renderer. A handler that writes a refusal first and
// the real answer later always replies with the refusal, even though the arm it computed
// afterwards succeeded. Both desktop authorizations shipped that way, and only the real shell
// showed it, because the fixtures assigned once. So the answer is computed in full here and
// assigned exactly once, for every channel that arms a dashboard click.

import type { IpcMain, IpcMainEvent, WebContents } from "electron";

type ClickIpc = Pick<IpcMain, "on">;

export function serveDashboardClick(
  ipc: ClickIpc,
  channel: string,
  dashboard: () => WebContents | undefined,
  arm: (input: unknown) => boolean,
): void {
  ipc.on(channel, (event: IpcMainEvent, input: unknown) => {
    let granted = false;
    // A throw would leave the renderer blocked in sendSync with no reply at all.
    try {
      const contents = dashboard();
      granted = !!contents && event.sender === contents && arm(input) === true;
    } catch { granted = false; }
    event.returnValue = granted;
  });
}
