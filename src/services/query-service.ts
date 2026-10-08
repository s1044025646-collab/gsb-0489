import { DatabaseSync } from '../db/database.js';

export interface PairDetail {
  ordinal: number;
  pairKey: string;
  fate: string;
  r1: {
    original: { header: string; sequence: string; plusLine: string; quality: string };
    passed: boolean;
    cut: number;
    failWindowStart: number | null;
    failWindowSum: number | null;
    reason: string | null;
    kept: { sequence: string; quality: string } | null;
  };
  r2: {
    original: { header: string; sequence: string; plusLine: string; quality: string };
    passed: boolean;
    cut: number;
    failWindowStart: number | null;
    failWindowSum: number | null;
    reason: string | null;
    kept: { sequence: string; quality: string } | null;
  };
}

function notFound(code: string, message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

/** 按运行 id 与配对键（或序号）查询一对的原文、裁剪证据与去向。 */
export function queryPair(
  db: DatabaseSync,
  runId: number,
  opts: { pairKey?: string; ordinal?: number }
): PairDetail {
  const run = db.prepare('SELECT batch_id FROM runs WHERE id = ?').get(runId) as
    | { batch_id: number }
    | undefined;
  if (!run) throw notFound('RUN_NOT_FOUND', `运行 ${runId} 不存在`);

  let item: {
    ordinal: number;
    pair_key: string;
    fate: string;
    pass1: number;
    pass2: number;
    cut1: number;
    cut2: number;
    fail_start1: number | null;
    fail_start2: number | null;
    fail_sum1: number | null;
    fail_sum2: number | null;
    reason1: string | null;
    reason2: string | null;
  } | undefined;
  if (opts.pairKey !== undefined) {
    item = db
      .prepare('SELECT * FROM run_items WHERE run_id = ? AND pair_key = ?')
      .get(runId, opts.pairKey) as typeof item;
  } else if (opts.ordinal !== undefined) {
    item = db
      .prepare('SELECT * FROM run_items WHERE run_id = ? AND ordinal = ?')
      .get(runId, opts.ordinal) as typeof item;
  } else {
    throw notFound('QUERY_KEY_REQUIRED', '必须提供 pairKey 或 ordinal');
  }
  if (!item) throw notFound('PAIR_NOT_FOUND', '未找到该配对');

  const rows = db
    .prepare(
      'SELECT side, header, sequence, plus_line, quality FROM records WHERE batch_id = ? AND ordinal = ? ORDER BY side'
    )
    .all(run.batch_id, item.ordinal) as {
    side: number;
    header: string;
    sequence: string;
    plus_line: string;
    quality: string;
  }[];
  const r1row = rows.find((r) => r.side === 1)!;
  const r2row = rows.find((r) => r.side === 2)!;

  const build = (
    row: typeof r1row,
    pass: number,
    cut: number,
    fs: number | null,
    fsum: number | null,
    reason: string | null
  ) => ({
    original: {
      header: row.header,
      sequence: row.sequence,
      plusLine: row.plus_line,
      quality: row.quality
    },
    passed: pass === 1,
    cut,
    failWindowStart: fs,
    failWindowSum: fsum,
    reason,
    kept:
      pass === 1
        ? { sequence: row.sequence.slice(0, cut), quality: row.quality.slice(0, cut) }
        : null
  });

  return {
    ordinal: item.ordinal,
    pairKey: item.pair_key,
    fate: item.fate,
    r1: build(r1row, item.pass1, item.cut1, item.fail_start1, item.fail_sum1, item.reason1),
    r2: build(r2row, item.pass2, item.cut2, item.fail_start2, item.fail_sum2, item.reason2)
  };
}
