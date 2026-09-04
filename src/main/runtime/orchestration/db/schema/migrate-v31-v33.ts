import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationsV31ToV33(this: OrchestrationDb, current: number): void {
  if (current >= 33) {
    return
  }
  if (!this.hasColumn('runs', 'controller_kind')) {
    this.db.exec(
      "ALTER TABLE runs ADD COLUMN controller_kind TEXT NOT NULL DEFAULT 'terminal' CHECK(controller_kind IN ('terminal', 'mission'))"
    )
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS mission_runs (
      run_id                  TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      lifecycle               TEXT NOT NULL DEFAULT 'queued'
        CHECK(lifecycle IN ('queued', 'running', 'awaiting_input', 'stopping', 'stopped', 'succeeded', 'failed')),
      worktree_id             TEXT,
      planner_selection_json  TEXT NOT NULL,
      worker_selection_json   TEXT NOT NULL,
      max_concurrency          INTEGER NOT NULL,
      owner_fingerprint        TEXT NOT NULL,
      stop_secret_hash         TEXT NOT NULL,
      supervisor_generation   INTEGER NOT NULL DEFAULT 0,
      terminal_outcome        TEXT
        CHECK(terminal_outcome IN ('stopped', 'succeeded', 'failed')),
      last_error               TEXT,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mission_runs_rehydratable
      ON mission_runs(created_at, run_id)
      WHERE terminal_outcome IS NULL;
  `)
}
