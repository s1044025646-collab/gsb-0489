import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from '../db/database.js';
import { formatRecord } from '../core/fastq-writer.js';

export type ExportKind =
  | 'paired_R1'
  | 'paired_R2'
  | 'singleton_R1'
  | 'singleton_R2'
  | 'stats';

export interface ExportFile {
  kind: ExportKind;
  filePath: string;
  byteSize: number;
  sha256: string;
}

const FASTQ_KINDS: ExportKind[] = [
  'paired_R1',
  'paired_R2',
  'singleton_R1',
  'singleton_R2'
];

interface ItemRow {
  ordinal: number;
  fate: string;
  cut1: number;
  cut2: number;
}

interface RecRow {
  ordinal: number;
  side: number;
  header: string;
  sequence: string;
  quality: string;
}

/**
 * 导出全部 FASTQ 与统计 JSON。保持源记录顺序（按 ordinal）；
 * paired_R1 / paired_R2 逐项配对键一致。原子写临时文件后重命名；
 * 重复导出内容相同（字节一致）。
 */
export function exportRun(
  db: DatabaseSync,
  dataDir: string,
  runId: number
): { files: ExportFile[]; stats: unknown } {
  const run = db
    .prepare('SELECT * FROM runs WHERE id = ?')
    .get(runId) as
    | {
        id: number;
        batch_id: number;
        window_size: number;
        quality_threshold: number;
        min_length: number;
        max_n_ratio: number;
        orphan_strategy: string;
        paired_count: number;
        singleton_r1_count: number;
        singleton_r2_count: number;
        dropped_count: number;
      }
    | undefined;
  if (!run) {
    const err = new Error(`运行 ${runId} 不存在`) as Error & { code?: string };
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }

  const items = db
    .prepare('SELECT ordinal, fate, cut1, cut2 FROM run_items WHERE run_id = ? ORDER BY ordinal')
    .all(runId) as unknown as ItemRow[];
  const recs = db
    .prepare('SELECT ordinal, side, header, sequence, quality FROM records WHERE batch_id = ? ORDER BY ordinal, side')
    .all(run.batch_id) as unknown as RecRow[];
  const recMap = new Map<string, RecRow>();
  for (const r of recs) recMap.set(`${r.ordinal}:${r.side}`, r);

  const buckets: Record<Exclude<ExportKind, 'stats'>, string> = {
    paired_R1: '',
    paired_R2: '',
    singleton_R1: '',
    singleton_R2: ''
  };
  const pairedKeys: string[] = [];

  for (const item of items) {
    const r1 = recMap.get(`${item.ordinal}:1`)!;
    const r2 = recMap.get(`${item.ordinal}:2`)!;
    if (item.fate === 'paired') {
      buckets.paired_R1 += formatRecord(r1, r1.sequence.slice(0, item.cut1), r1.quality.slice(0, item.cut1));
      buckets.paired_R2 += formatRecord(r2, r2.sequence.slice(0, item.cut2), r2.quality.slice(0, item.cut2));
      pairedKeys.push(r1.header);
    } else if (item.fate === 'singleton_R1') {
      buckets.singleton_R1 += formatRecord(r1, r1.sequence.slice(0, item.cut1), r1.quality.slice(0, item.cut1));
    } else if (item.fate === 'singleton_R2') {
      buckets.singleton_R2 += formatRecord(r2, r2.sequence.slice(0, item.cut2), r2.quality.slice(0, item.cut2));
    }
  }

  const stats = {
    runId: run.id,
    batchId: run.batch_id,
    params: {
      windowSize: run.window_size,
      qualityThreshold: run.quality_threshold,
      minLength: run.min_length,
      maxNRatio: run.max_n_ratio
    },
    orphanStrategy: run.orphan_strategy,
    counts: {
      totalInputPairs: items.length,
      paired: run.paired_count,
      singletonR1: run.singleton_r1_count,
      singletonR2: run.singleton_r2_count,
      dropped: run.dropped_count
    },
    consistency: {
      categorySumEqualsInput:
        run.paired_count +
          run.singleton_r1_count +
          run.singleton_r2_count +
          run.dropped_count ===
        items.length,
      pairedFilesSameLength: true,
      pairedPairKeys: pairedKeys
    }
  };

  const outDir = path.join(dataDir, 'exports', `run-${runId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const files: ExportFile[] = [];

  for (const kind of FASTQ_KINDS) {
    const content =
      buckets[kind as 'paired_R1' | 'paired_R2' | 'singleton_R1' | 'singleton_R2'];
    files.push(writeAtomic(db, runId, kind, path.join(outDir, `${kind}.fastq`), content));
  }
  files.push(
    writeAtomic(db, runId, 'stats', path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 2) + '\n')
  );
  return { files, stats };
}

function writeAtomic(
  db: DatabaseSync,
  runId: number,
  kind: ExportKind,
  finalPath: string,
  content: string
): ExportFile {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${finalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const buf = Buffer.from(content, 'utf8');
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, finalPath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');

  db.prepare(
    `INSERT INTO exports (run_id, kind, file_path, byte_size, sha256, exported_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, kind) DO UPDATE SET
       file_path = excluded.file_path,
       byte_size = excluded.byte_size,
       sha256 = excluded.sha256,
       exported_at = excluded.exported_at`
  ).run(runId, kind, finalPath, buf.length, sha, new Date().toISOString());

  return { kind, filePath: finalPath, byteSize: buf.length, sha256: sha };
}

/** 列出某次运行已导出的文件。 */
export function listExports(
  db: DatabaseSync,
  runId: number
): ExportFile[] {
  const rows = db
    .prepare('SELECT kind, file_path, byte_size, sha256 FROM exports WHERE run_id = ? ORDER BY kind')
    .all(runId) as {
    kind: ExportKind;
    file_path: string;
    byte_size: number;
    sha256: string;
  }[];
  return rows.map((r) => ({
    kind: r.kind,
    filePath: r.file_path,
    byteSize: r.byte_size,
    sha256: r.sha256
  }));
}
