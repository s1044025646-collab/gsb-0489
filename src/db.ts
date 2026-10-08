import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS } from './limits.js';
import { parsePair } from './parser.js';
import { classifyPairs, summarize, validateParams } from './trim.js';
import type { Limits, PairRecord, PairResult, Strategy, TrimParams } from './types.js';

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ImportedBatch {
  batchId: string;
  recordCount: number;
}

export interface RunSummary {
  runId: number;
  batchId: string;
  strategy: Strategy;
  stats: ReturnType<typeof summarize>;
}

export class AppDatabase {
  readonly db: DatabaseSync;

  constructor(path = 'data/app.sqlite') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private runInTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        input_sha256 TEXT NOT NULL UNIQUE,
        record_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        r1_content TEXT NOT NULL,
        r2_content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        pair_key TEXT NOT NULL,
        r1_header TEXT NOT NULL,
        r1_sequence TEXT NOT NULL,
        r1_plus TEXT NOT NULL,
        r1_quality TEXT NOT NULL,
        r2_header TEXT NOT NULL,
        r2_sequence TEXT NOT NULL,
        r2_plus TEXT NOT NULL,
        r2_quality TEXT NOT NULL,
        PRIMARY KEY (batch_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        strategy TEXT NOT NULL CHECK (strategy IN ('discard_pair','keep_singletons')),
        params_json TEXT NOT NULL,
        config_sha256 TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(batch_id, config_sha256)
      );
      CREATE TABLE IF NOT EXISTS run_records (
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        pair_key TEXT NOT NULL,
        category TEXT NOT NULL,
        r1_cut INTEGER NOT NULL,
        r2_cut INTEGER NOT NULL,
        r1_passed INTEGER NOT NULL,
        r2_passed INTEGER NOT NULL,
        r1_reasons_json TEXT NOT NULL,
        r2_reasons_json TEXT NOT NULL,
        r1_evidence_json TEXT NOT NULL,
        r2_evidence_json TEXT NOT NULL,
        PRIMARY KEY (run_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS exports (
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('paired_R1','paired_R2','singleton_R1','singleton_R2','stats')),
        file_path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, kind)
      );
    `);
  }

  importPair(r1Content: string, r2Content: string, limits: Limits = DEFAULT_LIMITS): ImportedBatch {
    const parsed = parsePair(r1Content, r2Content, limits);
    if (!parsed.ok) {
      throw Object.assign(new Error('FASTQ 校验失败'), { code: 'FASTQ_VALIDATION_FAILED', issues: parsed.issues });
    }
    const pairs = parsed.pairs;

    const inputHash = sha256Text(JSON.stringify({ r1: r1Content, r2: r2Content }));
    const existing = this.db.prepare('SELECT id, record_count FROM batches WHERE input_sha256 = ?').get(inputHash) as
      | { id: string; record_count: number }
      | undefined;
    if (existing) return { batchId: existing.id, recordCount: existing.record_count };

    const batchId = inputHash.slice(0, 16);
    const insertBatch = this.db.prepare('INSERT INTO batches(id,input_sha256,record_count,created_at,r1_content,r2_content) VALUES(?,?,?,?,?,?)');
    const insertRecord = this.db.prepare(`
      INSERT INTO records(batch_id,ordinal,pair_key,r1_header,r1_sequence,r1_plus,r1_quality,r2_header,r2_sequence,r2_plus,r2_quality)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.runInTransaction(() => {
      insertBatch.run(batchId, inputHash, pairs.length, new Date().toISOString(), r1Content, r2Content);
      for (const pair of pairs) {
        insertRecord.run(
          batchId,
          pair.ordinal,
          pair.pairKey,
          pair.R1.headerLine,
          pair.R1.sequence,
          pair.R1.plusLine,
          pair.R1.quality,
          pair.R2.headerLine,
          pair.R2.sequence,
          pair.R2.plusLine,
          pair.R2.quality
        );
      }
    });
    return { batchId, recordCount: pairs.length };
  }

  getPairs(batchId: string): PairRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM records WHERE batch_id = ? ORDER BY ordinal
    `).all(batchId) as Array<{
      ordinal: number; pair_key: string;
      r1_header: string; r1_sequence: string; r1_plus: string; r1_quality: string;
      r2_header: string; r2_sequence: string; r2_plus: string; r2_quality: string;
    }>;
    if (rows.length === 0 && !this.batchExists(batchId)) {
      throw Object.assign(new Error('批次不存在'), { code: 'BATCH_NOT_FOUND' });
    }
    return rows.map((row) => ({
      ordinal: row.ordinal,
      pairKey: row.pair_key,
      R1: {
        recordNumber: row.ordinal,
        name: '',
        description: '',
        headerLine: row.r1_header,
        sequence: row.r1_sequence,
        plusLine: row.r1_plus,
        quality: row.r1_quality,
        pairKey: row.pair_key
      },
      R2: {
        recordNumber: row.ordinal,
        name: '',
        description: '',
        headerLine: row.r2_header,
        sequence: row.r2_sequence,
        plusLine: row.r2_plus,
        quality: row.r2_quality,
        pairKey: row.pair_key
      }
    }));
  }

  batchExists(batchId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM batches WHERE id = ?').get(batchId));
  }

  submitRun(batchId: string, rawParams: TrimParams, strategy: Strategy): RunSummary {
    const params = validateParams(rawParams);
    const pairs = this.getPairs(batchId);
    const configHash = sha256Text(stableJson({ strategy, params }));
    const existing = this.db.prepare('SELECT id, stats_json FROM runs WHERE batch_id = ? AND config_sha256 = ?')
      .get(batchId, configHash) as { id: number; stats_json: string } | undefined;
    if (existing) {
      return { runId: existing.id, batchId, strategy, stats: JSON.parse(existing.stats_json) as RunSummary['stats'] };
    }

    const results = classifyPairs(pairs, params, strategy);
    const stats = summarize(results);
    const runId = this.createRun(batchId, strategy, params, configHash, results, stats);
    return { runId, batchId, strategy, stats };
  }

  private createRun(
    batchId: string,
    strategy: Strategy,
    params: TrimParams,
    configHash: string,
    results: PairResult[],
    stats: ReturnType<typeof summarize>
  ): number {
    const insertRun = this.db.prepare('INSERT INTO runs(batch_id,strategy,params_json,config_sha256,stats_json,created_at) VALUES(?,?,?,?,?,?)');
    const insertResult = this.db.prepare(`
      INSERT INTO run_records(run_id,ordinal,pair_key,category,r1_cut,r2_cut,r1_passed,r2_passed,r1_reasons_json,r2_reasons_json,r1_evidence_json,r2_evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    return this.runInTransaction(() => {
      const info = insertRun.run(batchId, strategy, stableJson(params), configHash, stableJson(stats), new Date().toISOString());
      const runId = Number(info.lastInsertRowid);
      for (const result of results) {
        insertResult.run(
          runId,
          result.ordinal,
          result.pairKey,
          result.category,
          result.r1.cutPosition,
          result.r2.cutPosition,
          result.r1.passed ? 1 : 0,
          result.r2.passed ? 1 : 0,
          stableJson(result.r1.reasons),
          stableJson(result.r2.reasons),
          stableJson(result.r1.evidence),
          stableJson(result.r2.evidence)
        );
      }
      return runId;
    });
  }
}
