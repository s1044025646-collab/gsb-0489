import { DatabaseSync } from '../db/database.js';
import { trimRecord, validateParams } from '../core/trim.js';
import { decideFate, PairFate } from '../core/pairs.js';
import { FastqRecord, OrphanStrategy, TrimParams } from '../core/types.js';

interface RecordRow {
  ordinal: number;
  pair_key: string;
  side: number;
  name: string;
  description: string;
  header: string;
  sequence: string;
  plus_line: string;
  quality: string;
  had_side_suffix: number;
}

interface RunRow {
  id: number;
}

export interface RunSummary {
  runId: number;
  batchId: number;
  params: TrimParams;
  orphanStrategy: OrphanStrategy;
  counts: {
    paired: number;
    singletonR1: number;
    singletonR2: number;
    dropped: number;
    total: number;
  };
  reused: boolean;
}

function validateStrategy(s: unknown): OrphanStrategy {
  if (s !== 'discard_pair' && s !== 'keep_singletons') {
    const err = new Error(
      "orphanStrategy 必须为 'discard_pair' 或 'keep_singletons'"
    ) as Error & { code?: string };
    err.code = 'INVALID_PARAMS';
    throw err;
  }
  return s;
}

function assertBatchExists(db: DatabaseSync, batchId: number): void {
  const row = db.prepare('SELECT id FROM batches WHERE id = ?').get(batchId);
  if (!row) {
    const err = new Error(`批次 ${batchId} 不存在`) as Error & { code?: string };
    err.code = 'BATCH_NOT_FOUND';
    throw err;
  }
}

/**
 * 在冻结批次上按参数运行裁剪与去向判定。
 * 相同参数 + 策略重复提交幂等：返回既有 run。
 */
export function processBatch(
  db: DatabaseSync,
  batchId: number,
  rawParams: unknown,
  rawStrategy: unknown
): RunSummary {
  const params = validateParams(rawParams);
  const strategy = validateStrategy(rawStrategy);
  assertBatchExists(db, batchId);

  const existing = db
    .prepare(
      `SELECT id FROM runs
       WHERE batch_id = ? AND window_size = ? AND quality_threshold = ?
         AND min_length = ? AND max_n_ratio = ? AND orphan_strategy = ?`
    )
    .get(
      batchId,
      params.windowSize,
      params.qualityThreshold,
      params.minLength,
      params.maxNRatio,
      strategy
    ) as RunRow | undefined;
  if (existing) {
    return loadSummary(db, existing.id, true);
  }

  const rows = db
    .prepare(
      'SELECT * FROM records WHERE batch_id = ? ORDER BY ordinal, side'
    )
    .all(batchId) as unknown as RecordRow[];

  const byOrdinal = new Map<number, { r1?: RecordRow; r2?: RecordRow }>();
  for (const row of rows) {
    const slot = byOrdinal.get(row.ordinal) ?? {};
    if (row.side === 1) slot.r1 = row;
    else slot.r2 = row;
    byOrdinal.set(row.ordinal, slot);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db
      .prepare(
        `INSERT INTO runs
          (created_at, batch_id, window_size, quality_threshold, min_length, max_n_ratio,
           orphan_strategy, paired_count, singleton_r1_count, singleton_r2_count, dropped_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`
      )
    .run(
      new Date().toISOString(),
      batchId,
      params.windowSize,
      params.qualityThreshold,
      params.minLength,
      params.maxNRatio,
      strategy
    );
    const runId = Number(info.lastInsertRowid);
    const itemStmt = db.prepare(
      `INSERT INTO run_items
        (run_id, ordinal, pair_key, fate, pass1, pass2, cut1, cut2,
         fail_start1, fail_start2, fail_sum1, fail_sum2, reason1, reason2)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let paired = 0;
    let singletonR1 = 0;
    let singletonR2 = 0;
    let dropped = 0;

    const ordinals = [...byOrdinal.keys()].sort((a, b) => a - b);
    for (const ordinal of ordinals) {
      const slot = byOrdinal.get(ordinal)!;
      if (!slot.r1 || !slot.r2) {
        throw new Error(`内部错误：第 ${ordinal} 对缺少一侧记录`);
      }
      const rec1 = toRecord(slot.r1);
      const rec2 = toRecord(slot.r2);
      const t1 = trimRecord(rec1, params);
      const t2 = trimRecord(rec2, params);
      const fate: PairFate = decideFate(t1.passed, t2.passed, strategy);
      if (fate === 'paired') paired++;
      else if (fate === 'singleton_R1') singletonR1++;
      else if (fate === 'singleton_R2') singletonR2++;
      else dropped++;
      itemStmt.run(
        runId,
        ordinal,
        slot.r1.pair_key,
        fate,
        t1.passed ? 1 : 0,
        t2.passed ? 1 : 0,
        t1.cut,
        t2.cut,
        t1.failWindowStart,
        t2.failWindowStart,
        t1.failWindowSum,
        t2.failWindowSum,
        t1.reason,
        t2.reason
      );
    }

    db.prepare(
      `UPDATE runs SET paired_count = ?, singleton_r1_count = ?,
        singleton_r2_count = ?, dropped_count = ? WHERE id = ?`
    ).run(paired, singletonR1, singletonR2, dropped, runId);

    db.exec('COMMIT');
    return loadSummary(db, runId, false);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function toRecord(row: RecordRow): FastqRecord {
  return {
    index: row.ordinal,
    name: row.name,
    header: row.header,
    description: row.description,
    sequence: row.sequence,
    plusLine: row.plus_line,
    quality: row.quality,
    key: row.pair_key,
    hadSideSuffix: row.had_side_suffix === 1
  };
}

function loadSummary(db: DatabaseSync, runId: number, reused: boolean): RunSummary {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as {
    id: number;
    batch_id: number;
    window_size: number;
    quality_threshold: number;
    min_length: number;
    max_n_ratio: number;
    orphan_strategy: OrphanStrategy;
    paired_count: number;
    singleton_r1_count: number;
    singleton_r2_count: number;
    dropped_count: number;
  };
  return {
    runId: row.id,
    batchId: row.batch_id,
    params: {
      windowSize: row.window_size,
      qualityThreshold: row.quality_threshold,
      minLength: row.min_length,
      maxNRatio: row.max_n_ratio
    },
    orphanStrategy: row.orphan_strategy,
    counts: {
      paired: row.paired_count,
      singletonR1: row.singleton_r1_count,
      singletonR2: row.singleton_r2_count,
      dropped: row.dropped_count,
      total:
        row.paired_count +
        row.singleton_r1_count +
        row.singleton_r2_count +
        row.dropped_count
    },
    reused
  };
}

export function getRunSummary(db: DatabaseSync, runId: number): RunSummary {
  const row = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
  if (!row) {
    const err = new Error(`运行 ${runId} 不存在`) as Error & { code?: string };
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }
  return loadSummary(db, runId, false);
}

/** 查询某批次的运行列表。 */
export function listRuns(db: DatabaseSync, batchId: number): RunSummary[] {
  assertBatchExists(db, batchId);
  const rows = db
    .prepare('SELECT id FROM runs WHERE batch_id = ? ORDER BY id')
    .all(batchId) as unknown as RunRow[];
  return rows.map((r) => loadSummary(db, r.id, false));
}
