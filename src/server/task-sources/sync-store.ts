import { SourceSyncRecordSchema, type SourceSyncRecord } from "@shared/task-source-sync.ts";
import { openDb } from "../db.ts";

export function getSourceSync(taskId: string): SourceSyncRecord | null {
  const row = openDb().prepare("SELECT payload_json FROM task_source_sync WHERE task_id = ?")
    .get(taskId) as { payload_json: string } | undefined;
  if (!row) return null;
  // Corrupt or future state must never be mistaken for permission to overwrite a task.
  return SourceSyncRecordSchema.parse(JSON.parse(row.payload_json));
}
export function saveSourceSync(taskId: string, sourceId: string, record: SourceSyncRecord): void {
  const parsed = SourceSyncRecordSchema.parse(record);
  openDb().prepare(`INSERT INTO task_source_sync (task_id, source_id, payload_json) VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET source_id=excluded.source_id, payload_json=excluded.payload_json`)
    .run(taskId, sourceId, JSON.stringify(parsed));
}
export function clearSourceSync(sourceId: string): void {
  openDb().prepare("DELETE FROM task_source_sync WHERE source_id = ?").run(sourceId);
}
