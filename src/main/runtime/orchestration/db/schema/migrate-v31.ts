import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV31(this: OrchestrationDb, current: number): void {
  if (current < 31) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_control_policies (
        run_id           TEXT PRIMARY KEY,
        max_concurrency  INTEGER NOT NULL CHECK(max_concurrency >= 1),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
  }
}
