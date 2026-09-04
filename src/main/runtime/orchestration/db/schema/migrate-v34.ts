import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV34(this: OrchestrationDb, current: number): void {
  if (current >= 34) {
    return
  }
  this.db.exec(`
    ALTER TABLE mission_runs RENAME TO mission_runs_v33;
    CREATE TABLE mission_runs (
      run_id                  TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      lifecycle               TEXT NOT NULL DEFAULT 'queued'
        CHECK(lifecycle IN ('queued', 'running', 'awaiting_input', 'stopping', 'stopped', 'succeeded', 'failed')),
      worktree_id             TEXT,
      planner_selection_json  TEXT NOT NULL,
      worker_selection_json   TEXT NOT NULL,
      max_concurrency         INTEGER NOT NULL,
      owner_fingerprint       TEXT NOT NULL,
      stop_secret_hash        TEXT NOT NULL,
      supervisor_generation   INTEGER NOT NULL DEFAULT 0,
      terminal_outcome        TEXT CHECK(terminal_outcome IN ('stopped', 'succeeded', 'failed')),
      last_error              TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO mission_runs SELECT * FROM mission_runs_v33;
    DROP TABLE mission_runs_v33;
    CREATE INDEX idx_mission_runs_rehydratable
      ON mission_runs(created_at, run_id) WHERE terminal_outcome IS NULL;
  `)
}
