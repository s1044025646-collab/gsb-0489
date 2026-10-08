import crypto from 'node:crypto';
import { DatabaseSync } from '../db/database.js';
import { parseFastq } from '../core/parser.js';
import { validatePairs } from '../core/pairs.js';
import { defaultLimits } from '../core/limits.js';
import { FastqRecord, Side } from '../core/types.js';

export interface ImportResult {
  batchId: number;
  recordCount: number;
  sha256R1: string;
  sha256R2: string;
}

/**
 * 原子导入：解析、配对核验与入库在一个事务内完成，
 * 任何错误整体回滚，不会留下半成品批次。
 * 相同内容重复导入幂等（按内容哈希返回既有批次）。
 */
export function importBatch(
  db: DatabaseSync,
  contentR1: string,
  contentR2: string,
  limits = defaultLimits()
): ImportResult {
  // 先在事务外完成全部解析/核验（纯计算），失败不会触碰数据库。
  const r1 = parseFastq(contentR1, 1, limits).records;
  const r2 = parseFastq(contentR2, 2, limits).records;
  validatePairs(r1, r2);

  const sha256R1 = sha256(contentR1);
  const sha256R2 = sha256(contentR2);

  const existing = db
    .prepare(
      'SELECT id, record_count FROM batches WHERE raw_r1_sha256 = ? AND raw_r2_sha256 = ?'
    )
    .get(sha256R1, sha256R2) as
    | { id: number; record_count: number }
    | undefined;
  if (existing) {
    return {
      batchId: existing.id,
      recordCount: existing.record_count,
      sha256R1,
      sha256R2
    };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db
      .prepare(
        `INSERT INTO batches
          (created_at, record_count, raw_r1_path, raw_r2_path, raw_r1_sha256, raw_r2_sha256, content_r1, content_r2)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        r1.length,
        'inline://r1.fastq',
        'inline://r2.fastq',
        sha256R1,
        sha256R2,
        contentR1,
        contentR2
      );
    const batchId = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      `INSERT INTO records
        (batch_id, ordinal, pair_key, side, name, description, header, sequence, plus_line, quality, had_side_suffix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertSide(stmt, batchId, r1, 1);
    insertSide(stmt, batchId, r2, 2);
    db.exec('COMMIT');
    return { batchId, recordCount: r1.length, sha256R1, sha256R2 };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function insertSide(
  stmt: ReturnType<DatabaseSync['prepare']>,
  batchId: number,
  records: FastqRecord[],
  side: Side
): void {
  for (const r of records) {
    stmt.run(
      batchId,
      r.index,
      r.key,
      side,
      r.name,
      r.description,
      r.header,
      r.sequence,
      r.plusLine,
      r.quality,
      r.hadSideSuffix ? 1 : 0
    );
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
