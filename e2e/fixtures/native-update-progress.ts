import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppProcesses } from '../../scripts/mac-app-lifecycle.mjs';
import { processIdentity } from '../../scripts/update-lock.mjs';

/** Observe an actual on-screen native dialog without granting Accessibility/Screen Recording.
 * Its exact displayed text comes from the production osascript invocation; CoreGraphics
 * independently proves that this helper's dialog reached the window server.
 */
export function nativeDialogWindows(directory: string) {
  const source = join(directory, 'progress-windows.swift');
  const executable = join(directory, 'progress-windows');
  writeFileSync(source, `import Foundation
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let windows = all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == Int(CGWindowLevelForKey(.modalPanelWindow)) }
print(String(data: try! JSONSerialization.data(withJSONObject: windows), encoding: .utf8)!)
`);
  execFileSync('/usr/bin/swiftc', [source, '-o', executable]);
  return (pid: number) => JSON.parse(execFileSync(executable, [String(pid)], {encoding: 'utf8'})) as Array<Record<string, unknown>>;
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
