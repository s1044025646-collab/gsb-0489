import { FastqError, FastqRecord, Side } from './types.js';

/**
 * 配对核验：两文件第 i 条配对键必须相同且批内唯一、数量必须相等。
 * 顺序错位、重复键、一侧截断都会使整次导入失败；不搜索同名读段补配。
 */
export function validatePairs(
  r1: FastqRecord[],
  r2: FastqRecord[]
): void {
  if (r1.length !== r2.length) {
    throw new FastqError({
      code: 'RECORD_COUNT_MISMATCH',
      message: `R1 记录数 ${r1.length} 与 R2 记录数 ${r2.length} 不相等（一侧可能末尾截断）`
    });
  }
  if (r1.length === 0) {
    throw new FastqError({
      code: 'EMPTY_BATCH',
      message: '两份文件均不含任何记录'
    });
  }
  const seen = new Set<string>();
  for (let i = 0; i < r1.length; i++) {
    const k1 = r1[i].key;
    const k2 = r2[i].key;
    if (seen.has(k1)) {
      throw new FastqError({
        code: 'DUPLICATE_KEY',
        message: `配对键 '${k1}' 在批内重复（第 ${i + 1} 条）`,
        record: i + 1
      });
    }
    seen.add(k1);
    if (k1 !== k2) {
      throw new FastqError({
        code: 'PAIR_KEY_MISMATCH',
        message: `第 ${i + 1} 条配对键不一致：R1='${k1}'，R2='${k2}'（顺序错位，不自动补配）`,
        record: i + 1
      });
    }
  }
}

export type PairFate = 'paired' | 'singleton_R1' | 'singleton_R2' | 'dropped';

/** 依据两侧通过情况与孤儿策略决定整对去向。 */
export function decideFate(
  pass1: boolean,
  pass2: boolean,
  strategy: 'discard_pair' | 'keep_singletons'
): PairFate {
  if (pass1 && pass2) return 'paired';
  if (!pass1 && !pass2) return 'dropped';
  if (strategy === 'discard_pair') return 'dropped';
  return pass1 ? 'singleton_R1' : 'singleton_R2';
}

export function sideLabel(side: Side): string {
  return side === 1 ? 'R1' : 'R2';
}
