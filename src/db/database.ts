import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let dbInstance: DatabaseSync | null = null;

export function openDatabase(dataDir: string): DatabaseSync {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.join(dataDir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'exports'), { recursive: true });
  const dbPath = path.join(dataDir, 'fastq.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  dbInstance = db;
  return db;
}

/** 仅供测试：切换数据库文件。 */
export function resetDatabaseInstance(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    raw_r1_path TEXT NOT NULL,
    raw_r2_path TEXT NOT NULL,
    raw_r1_sha256 TEXT NOT NULL,
    raw_r2_sha256 TEXT NOT NULL,
    content_r1 TEXT NOT NULL,
    content_r2 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    batch_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    pair_key TEXT NOT NULL,
    side INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    header TEXT NOT NULL,
    sequence TEXT NOT NULL,
    plus_line TEXT NOT NULL,
    quality TEXT NOT NULL,
    had_side_suffix INTEGER NOT NULL,
    PRIMARY KEY (batch_id, ordinal, side),
    FOREIGN KEY (batch_id) REFERENCES batches(id)
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    window_size INTEGER NOT NULL,
    quality_threshold INTEGER NOT NULL,
    min_length INTEGER NOT NULL,
    max_n_ratio REAL NOT NULL,
    orphan_strategy TEXT NOT NULL,
    paired_count INTEGER NOT NULL,
    singleton_r1_count INTEGER NOT NULL,
    singleton_r2_count INTEGER NOT NULL,
    dropped_count INTEGER NOT NULL,
    UNIQUE (batch_id, window_size, quality_threshold, min_length, max_n_ratio, orphan_strategy),
    FOREIGN KEY (batch_id) REFERENCES batches(id)
  );
  CREATE TABLE IF NOT EXISTS run_items (
    run_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    pair_key TEXT NOT NULL,
    fate TEXT NOT NULL,
    pass1 INTEGER NOT NULL,
    pass2 INTEGER NOT NULL,
    cut1 INTEGER NOT NULL,
    cut2 INTEGER NOT NULL,
    fail_start1 INTEGER,
    fail_start2 INTEGER,
    fail_sum1 INTEGER,
    fail_sum2 INTEGER,
    reason1 TEXT,
    reason2 TEXT,
    PRIMARY KEY (run_id, ordinal),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );
  CREATE TABLE IF NOT EXISTS exports (
    run_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    exported_at TEXT NOT NULL,
    PRIMARY KEY (run_id, kind),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );
  `);
}

export type { DatabaseSync };
