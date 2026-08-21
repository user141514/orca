import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV32(this: OrchestrationDb, current: number): void {
  if (current < 32 && !this.hasColumn('tasks', 'execution_spec')) {
    this.db.exec('ALTER TABLE tasks ADD COLUMN execution_spec TEXT')
  }
}
