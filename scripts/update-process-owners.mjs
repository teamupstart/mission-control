import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { darwinCheckIdentity } from './darwin-process-identity.mjs';
import { parseAppProcesses, realMacAppOps } from './mac-app-lifecycle.mjs';

export const processFingerprint = (identity) => identity ? createHash('sha256').update(identity).digest('hex') : null;

/** The daemon remains the sole writer. These existing leases are the ownership authority. */
export function readCheckProcessOwners(stateDirectory, ops) {
  const path = join(stateDirectory, 'harness.db');
  if (!existsSync(path)) return [];
  let db;
  try {
    db = new DatabaseSync(path, {readOnly: true});
    db.exec('PRAGMA busy_timeout = 1000');
    const rows = db.prepare(`SELECT l.*, s.run_id, b.session_id
      FROM workflow_check_leases l
      LEFT JOIN workflow_submissions s ON s.id = l.submission_id
      LEFT JOIN workflow_runs r ON r.id = s.run_id
      LEFT JOIN workflow_bindings b ON b.id = r.binding_id
      WHERE l.supervisor_pid > 1 AND l.cleanup_state IN ('held', 'returning')`).all();
    return rows.flatMap((row) => {
      const identity = ops.identity(row.supervisor_pid);
      if (!identity || darwinCheckIdentity(identity) !== row.supervisor_start_ticks) return [];
      return [{pid: row.supervisor_pid, fingerprint: processFingerprint(identity), group: true,
        work: `workflow check ${row.node_id}, attempt ${row.attempt_id}, run ${row.run_id ?? row.submission_id}${row.session_id ? `, session ${row.session_id}` : ''}`}];
    });
  } catch { return []; } // Older installations may not have check leases. Never guess ownership.
  finally { db?.close(); }
}

/** SDK recovery already records the owned driver lifetime, independently of ancestry.
 * Read that same authority, including suspended sessions, without changing daemon state.
 */
function readSessionProcessOwners(stateDirectory, ops, livePids) {
  const path = join(stateDirectory, 'harness.db');
  if (!existsSync(path)) return [];
  let db;
  try {
    db = new DatabaseSync(path, {readOnly: true});
    db.exec('PRAGMA busy_timeout = 1000');
    return db.prepare('SELECT id, task_id, recovery_process_json FROM sdk_sessions WHERE recovery_process_json IS NOT NULL').all().flatMap(row => {
      let lifetime;
      try { lifetime = JSON.parse(row.recovery_process_json); } catch { return []; }
      if (!Number.isSafeInteger(lifetime?.pid) || lifetime.pid <= 1 || !Number.isFinite(lifetime.startMs) || lifetime.startMs <= 0) return [];
      if (!livePids.has(lifetime.pid)) return [];
      const identity = ops.identity(lifetime.pid);
      if (!identity || Date.parse(identity.split(' ').slice(0, 5).join(' ')) !== lifetime.startMs) return [];
      // PID + lstart has only second precision. Only a digest captured by the SDK
      // supervisor can authorize cleanup, never an identity minted from today's PID.
      if (!lifetime.darwinIdentity || darwinCheckIdentity(identity) !== lifetime.darwinIdentity) return [];
      return [{pid: lifetime.pid, fingerprint: processFingerprint(identity), group: false,
        work: `Mission Control session ${row.id}${row.task_id ? `, task ${row.task_id}` : ''}`}];
    });
  } catch { return []; } // A legacy/missing SDK table does not invalidate check ownership.
  finally { db?.close(); }
}

const canonical = path => { try { return realpathSync(path); } catch { return path; } };

/** Native Electron services are tied to their exact app profile even after their main
 * process dies. A bundle path alone, an arbitrary Node command, or another app profile
 * is insufficient. Never apply this rule to children of a live, unrelated desktop.
 */
function orphanService(row, identity, bundle, userDataDirectory) {
  if (row.ppid !== 1 || !bundle || !userDataDirectory) return null;
  const path = relative(canonical(bundle), canonical(row.executable));
  if (!/^Contents\/Frameworks\/([^/]+ Helper(?: \([^/()]+\))?)\.app\/Contents\/MacOS\/\1$/.test(path)) return null;
  const command = identity.split(' ').slice(5).join(' ');
  const prefix = `${row.executable.replace(/\s+/g, ' ')} --type=`;
  if (!command.startsWith(prefix)) return null;
  const profile = /(?:^| )--user-data-dir=(.+?)(?= --|$)/.exec(command)?.[1];
  if (!profile || canonical(profile) !== canonical(userDataDirectory)) return null;
  const type = command.slice(prefix.length).split(' ')[0];
  if (type === 'renderer') return 'Mission Control orphaned dashboard renderer';
  if (type === 'gpu-process') return 'Mission Control orphaned graphics service';
  if (type !== 'utility') return null;
  const subtype = /(?:^| )--utility-sub-type=([^ ]+)(?: |$)/.exec(command)?.[1];
  if (subtype === 'node.mojom.NodeService') return 'Mission Control orphaned Node utility';
  if (subtype === 'network.mojom.NetworkService') return 'Mission Control orphaned network service';
  return null;
}

/** Freeze descendants, durable work ownership and profile-verified orphan services.
 * Fingerprints retain identity without copying argv (which can contain credentials).
 */
export async function captureUpdateProcessOwners({stateDirectory, parent, bundle, userDataDirectory, processNames = {}}, ops = realMacAppOps()) {
  const checks = readCheckProcessOwners(stateDirectory, ops);
  const desktopMatched = parent?.identity && ops.identity(parent.pid) === parent.identity;
  const result = await ops.run('/bin/ps', ['-U', String(ops.uid), '-ww', '-o', 'pid=,ppid=,stat=,comm=']);
  if (result.code !== 0) return checks;
  const rows = parseAppProcesses(result.stdout);
  const independent = [...readSessionProcessOwners(stateDirectory, ops, new Set(rows.map(row => row.pid))), ...checks];
  const owned = new Map(independent.map((record) => [record.pid, record]));
  // ps awaits an external process. The desktop can disappear and its PID be reused
  // during that await, so its earlier identity cannot authorize this snapshot.
  if (desktopMatched && ops.identity(parent.pid) === parent.identity) {
    owned.set(parent.pid, {pid: parent.pid, fingerprint: processFingerprint(parent.identity), group: false, work: 'Mission Control desktop'});
  }
  for (const row of rows) {
    if (owned.has(row.pid) || row.ppid !== 1 || !bundle || !userDataDirectory ||
      !canonical(row.executable).startsWith(`${canonical(bundle)}/Contents/Frameworks/`)) continue;
    const identity = ops.identity(row.pid);
    const work = identity && orphanService(row, identity, bundle, userDataDirectory);
    if (work) owned.set(row.pid, {pid: row.pid, fingerprint: processFingerprint(identity), group: false, work});
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.pid) || !owned.has(row.ppid)) continue;
      const identity = ops.identity(row.pid);
      if (!identity) continue;
      if (processFingerprint(ops.identity(row.ppid)) !== owned.get(row.ppid).fingerprint) continue;
      const parentWork = owned.get(row.ppid).work;
      const work = parentWork.startsWith('workflow check') ? parentWork
        : processNames[row.pid] ? `Mission Control ${processNames[row.pid]}`
        : identity.includes('--type=renderer') ? 'Mission Control dashboard renderer'
        : identity.includes('--type=gpu-process') ? 'Mission Control graphics service'
        : identity.includes('--utility-sub-type=network') ? 'Mission Control network service'
        : `background work of ${parentWork}`;
      owned.set(row.pid, {pid: row.pid, fingerprint: processFingerprint(identity), group: false, work});
      changed = true;
    }
  }
  return [...owned.values()];
}
