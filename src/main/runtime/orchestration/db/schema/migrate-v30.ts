import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV30(this: OrchestrationDb, current: number): void {
  if (current < 30 && !this.hasColumn('runs', 'coordination_consumer_id')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN coordination_consumer_id TEXT')
  }
}
