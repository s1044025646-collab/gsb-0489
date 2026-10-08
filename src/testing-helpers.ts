import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseInstance, DatabaseSync } from './db/database.js';
import { FastqRecord, TrimParams } from './core/types.js';

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fastq-test-'));
}

export function freshDb(dir: string): { db: DatabaseSync; dataDir: string } {
  resetDatabaseInstance();
  const db = openDatabase(dir);
  return { db, dataDir: dir };
}

export function qual(scores: number[]): string {
  return scores.map((s) => String.fromCharCode(s + 33)).join('');
}

export interface FastqSpec {
  name: string;
  seq: string;
  scores: number[];
  desc?: string;
}

/** 生成固定四行 FASTQ，可选择 CRLF、省略末尾换行、自定义 plus 行。 */
export function renderFastq(
  recs: Array<FastqSpec & { plus?: string }>,
  opts: { eol?: '\n' | '\r\n'; trailingNewline?: boolean } = {}
): string {
  const eol = opts.eol ?? '\n';
  const trailing = opts.trailingNewline ?? true;
  const body = recs
    .map((r) => {
      const header = r.name + (r.desc ? ` ${r.desc}` : '');
      const plus = r.plus ?? `+${header}`;
      return `@${header}${eol}${r.seq}${eol}${plus}${eol}${qual(r.scores)}`;
    })
    .join(eol);
  return body + (trailing ? eol : '');
}

/** 完全独立的简单逐窗求和基准，返回第一失败窗口起点或 null。 */
export function bruteForceCut(scores: number[], W: number, T: number): number {
  if (scores.length < W) return scores.length;
  for (let start = 0; start + W <= scores.length; start++) {
    let sum = 0;
    for (let i = start; i < start + W; i++) sum += scores[i];
    if (sum < W * T) return start;
  }
  return scores.length;
}

export const DEFAULT_PARAMS: TrimParams = {
  windowSize: 3,
  qualityThreshold: 20,
  minLength: 3,
  maxNRatio: 0.5
};

export function expectFail(fn: () => unknown, code?: string): Error {
  try {
    fn();
  } catch (err) {
    if (code && (err as { code?: string }).code !== code) {
      throw new Error(
        `错误码不匹配：期望 ${code}，实际 ${(err as { code?: string }).code}；消息: ${(err as Error).message}`
      );
    }
    return err as Error;
  }
  throw new Error(`预期抛出错误${code ? `（${code}）` : ''}，但未抛出`);
}

export type { FastqRecord };
