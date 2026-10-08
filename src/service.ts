import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './errors.js';
import { sha256Text, type AppDatabase } from './db.js';
import { parsePair } from './parser.js';
import type { Category, Limits } from './types.js';

type ExportKind = 'paired_R1' | 'paired_R2' | 'singleton_R1' | 'singleton_R2' | 'stats';

interface StoredPair {
  ordinal: number;
  pair_key: string;
  category: Category;
  r1_cut: number;
  r2_cut: number;
  r1_passed: number;
  r2_passed: number;
  r1_reasons_json: string;
  r2_reasons_json: string;
  r1_evidence_json: string;
  r2_evidence_json: string;
  r1_header: string;
  r1_sequence: string;
  r1_plus: string;
  r1_quality: string;
  r2_header: string;
  r2_sequence: string;
  r2_plus: string;
  r2_quality: string;
}

const KIND_TO_SIDE: Record<Exclude<ExportKind, 'stats'>, 'r1' | 'r2'> = {
  paired_R1: 'r1',
  paired_R2: 'r2',
  singleton_R1: 'r1',
  singleton_R2: 'r2'
};

function loadRunRows(appDb: AppDatabase, runId: number): { run: unknown; rows: StoredPair[] } {
  const run = appDb.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new AppError('RUN_NOT_FOUND', `运行 ${runId} 不存在`);
  const rows = appDb.db.prepare(`
    SELECT rr.*, rec.r1_header, rec.r1_sequence, rec.r1_plus, rec.r1_quality,
           rec.r2_header, rec.r2_sequence, rec.r2_plus, rec.r2_quality
    FROM run_records rr
    JOIN records rec ON rec.batch_id = (SELECT batch_id FROM runs WHERE id = ?) AND rec.ordinal = rr.ordinal
    WHERE rr.run_id = ?
    ORDER BY rr.ordinal
  `).all(runId, runId) as unknown as StoredPair[];
  return { run, rows };
}

function fastqFor(rows: StoredPair[], kind: Exclude<ExportKind, 'stats'>): string {
  const wantedCategory: Category = kind.startsWith('paired') ? 'paired' : (kind.startsWith('singleton_R1') ? 'singleton_R1' : 'singleton_R2');
  const side = KIND_TO_SIDE[kind];
  return rows
    .filter((row) => row.category === wantedCategory)
    .map((row) => {
      const cut = side === 'r1' ? row.r1_cut : row.r2_cut;
      const header = side === 'r1' ? row.r1_header : row.r2_header;
      const sequence = (side === 'r1' ? row.r1_sequence : row.r2_sequence).slice(0, cut);
      const plus = side === 'r1' ? row.r1_plus : row.r2_plus;
      const quality = (side === 'r1' ? row.r1_quality : row.r2_quality).slice(0, cut);
      return `${header}\n${sequence}\n${plus}\n${quality}\n`;
    })
    .join('');
}

export function exportRun(appDb: AppDatabase, runId: number, outputDir = 'data/exports'): Record<ExportKind, { path: string; bytes: number; sha256: string }> {
  const { run, rows } = loadRunRows(appDb, runId);
  mkdirSync(outputDir, { recursive: true });

  const statsRow = run as { stats_json: string; params_json: string; strategy: string; batch_id: string };
  const stats = JSON.parse(statsRow.stats_json) as Record<string, number>;
  const statsPayload = JSON.stringify({
    runId,
    batchId: statsRow.batch_id,
    strategy: statsRow.strategy,
    params: JSON.parse(statsRow.params_json),
    stats
  }, null, 2) + '\n';

  const payloads = new Map<ExportKind, string>([
    ['paired_R1', fastqFor(rows, 'paired_R1')],
    ['paired_R2', fastqFor(rows, 'paired_R2')],
    ['singleton_R1', fastqFor(rows, 'singleton_R1')],
    ['singleton_R2', fastqFor(rows, 'singleton_R2')],
    ['stats', statsPayload]
  ]);

  const result = {} as Record<ExportKind, { path: string; bytes: number; sha256: string }>;
  for (const [kind, content] of payloads) {
    const ext = kind === 'stats' ? 'json' : 'fastq';
    const path = join(outputDir, `${runId}_${kind}.${ext}`);
    const bytes = Buffer.byteLength(content, 'utf8');
    const hash = sha256Text(content);
    const existing = appDb.db.prepare('SELECT file_path, byte_length, sha256 FROM exports WHERE run_id = ? AND kind = ?').get(runId, kind) as
      | { file_path: string; byte_length: number; sha256: string }
      | undefined;
    if (existing) {
      let current = '';
      try {
        current = readFileSync(existing.file_path, 'utf8');
      } catch {
        throw new AppError('EXPORT_MANIFEST_CONFLICT', `清单中的导出文件不可读：${existing.file_path}`);
      }
      if (sha256Text(current) !== existing.sha256) {
        throw new AppError('EXPORT_MANIFEST_CONFLICT', `已有成功导出被修改：${existing.file_path}`);
      }
      result[kind] = { path: existing.file_path, bytes: existing.byte_length, sha256: existing.sha256 };
      continue;
    }

    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, path);
    appDb.db.prepare('INSERT INTO exports(run_id,kind,file_path,byte_length,sha256,created_at) VALUES(?,?,?,?,?,?)')
      .run(runId, kind, path, bytes, hash, new Date().toISOString());
    result[kind] = { path, bytes, sha256: hash };
  }
  return result;
}

export function queryPair(appDb: AppDatabase, runId: number, selector: { ordinal?: number | undefined; pairKey?: string | undefined }) {
  const { rows } = loadRunRows(appDb, runId);
  const row = rows.find((item) =>
    selector.ordinal !== undefined ? item.ordinal === selector.ordinal :
    selector.pairKey !== undefined ? item.pair_key === selector.pairKey : false
  );
  if (!row) throw new AppError('PAIR_NOT_FOUND', '未找到指定配对记录');
  return {
    ordinal: row.ordinal,
    pairKey: row.pair_key,
    category: row.category,
    R1: {
      original: { header: row.r1_header, sequence: row.r1_sequence, plus: row.r1_plus, quality: row.r1_quality },
      cutPosition: row.r1_cut,
      passed: row.r1_passed === 1,
      reasons: JSON.parse(row.r1_reasons_json) as string[],
      evidence: JSON.parse(row.r1_evidence_json)
    },
    R2: {
      original: { header: row.r2_header, sequence: row.r2_sequence, plus: row.r2_plus, quality: row.r2_quality },
      cutPosition: row.r2_cut,
      passed: row.r2_passed === 1,
      reasons: JSON.parse(row.r2_reasons_json) as string[],
      evidence: JSON.parse(row.r2_evidence_json)
    }
  };
}

export function previewPair(r1Content: string, r2Content: string, limits: Limits) {
  const parsed = parsePair(r1Content, r2Content, limits);
  if (!parsed.ok) return { ok: false as const, issues: parsed.issues };
  return { ok: true as const, pairCount: parsed.pairs.length, firstPairKey: parsed.pairs[0]?.pairKey ?? null };
}

export function hashInputPair(r1Content: string, r2Content: string): string {
  return createHash('sha256').update(JSON.stringify({ r1: r1Content, r2: r2Content }), 'utf8').digest('hex');
}
