import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppProcesses } from '../../scripts/mac-app-lifecycle.mjs';
import { processIdentity } from '../../scripts/update-lock.mjs';

/** Observe an actual on-screen native dialog without granting Accessibility/Screen Recording.
 * Its exact displayed text comes from the production osascript invocation; CoreGraphics
 * independently proves that this helper's dialog reached the window server.
 *
 * `osascript` dialogs sit at the modal-panel window level. An app's OWN alert does not
 * reliably: current macOS presents Electron's startup error box as an ordinary level-0
 * window. A caller observing a process that has no other window (the app failed before it
 * opened one) passes `appAlert: true` to accept that level as well; every other caller keeps
 * the stricter modal-panel filter.
 */
export function nativeDialogWindows(directory: string, options: { appAlert?: boolean } = {}) {
  const source = join(directory, 'progress-windows.swift');
  const executable = join(directory, 'progress-windows');
  writeFileSync(source, `import Foundation
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let levels: Set<Int> = ${options.appAlert ? "[Int(CGWindowLevelForKey(.modalPanelWindow)), Int(CGWindowLevelForKey(.normalWindow))]" : "[Int(CGWindowLevelForKey(.modalPanelWindow))]"}
let windows = all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && levels.contains(($0[kCGWindowLayer as String] as? Int) ?? -1) }
print(String(data: try! JSONSerialization.data(withJSONObject: windows), encoding: .utf8)!)
`);
  execFileSync('/usr/bin/swiftc', [source, '-o', executable]);
  return (pid: number) => JSON.parse(execFileSync(executable, [String(pid)], {encoding: 'utf8'})) as Array<Record<string, unknown>>;
}

/**
 * Whether this Mac's console session is behind the lock screen right now.
 *
 * While it is, the window server keeps an app's own alert off screen: Electron's startup error
 * box is created and its text recorded, but CoreGraphics never reports it on screen, so a spec
 * that proves visibility can only time out. That is a fact about the machine, not about the
 * product - an unattended run overnight is exactly when it is true - so a caller asks this and
 * says what it could not observe instead of failing. `osascript` dialogs are not affected.
 */
export function consoleScreenLocked(directory: string): boolean {
  const source = join(directory, 'screen-locked.swift');
  const executable = join(directory, 'screen-locked');
  writeFileSync(source, `import Foundation
import CoreGraphics
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
print((session["CGSSessionScreenIsLocked"] as? Bool) == true ? "locked" : "unlocked")
`);
  execFileSync('/usr/bin/swiftc', [source, '-o', executable]);
  return execFileSync(executable, [], {encoding: 'utf8'}).trim() === 'locked';
}

export function nativeUpdateProgress(directory: string) {
  const dialogWindows = nativeDialogWindows(directory);
  return (helperPid: number) => {
    const processes = parseAppProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,comm='], {encoding: 'utf8'}));
    // A replaced dialog can remain listed until a paused helper reaps it. Do not
    // let that older child hide the current dialog from the observation.
    for (const child of processes.filter(row => row.ppid === helperPid && row.executable === '/usr/bin/osascript')) {
      const command = processIdentity(child.pid);
      if (!command?.includes('with title "Updating Mission Control"')) continue;
      const windows = dialogWindows(child.pid);
      if (windows.length) return {pid: child.pid, command, windows};
    }
    return null;
  };
}
