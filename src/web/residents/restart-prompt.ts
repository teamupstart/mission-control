import { createContext } from "react";

/**
 * Called once Restart on new profile has succeeded, with the task of the run it replaced.
 *
 * Restart leaves the original task and session open on purpose, and the operator is offered the
 * chance to complete them right then, wherever Restart was clicked - a card menu, the Console
 * band, the dock or the Residents page. App provides it and opens the ordinary Complete dialog
 * for that task's session; dismissing the dialog keeps the task open, and the replaced
 * session's band keeps offering Complete afterwards. Null where no App is mounted, as in
 * static-markup tests.
 */
export const ResidentRestartPromptContext = createContext<((replacedTaskId: string) => void) | null>(null);
