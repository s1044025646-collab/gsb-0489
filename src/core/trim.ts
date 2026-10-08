import { FastqRecord, TrimParams, TrimResult } from './types.js';

/** 校验裁剪参数，非法时抛出带错误码的异常。 */
export function validateParams(p: unknown): TrimParams {
  if (typeof p !== 'object' || p === null) {
    throw paramError('参数必须是对象');
  }
  const o = p as Record<string, unknown>;
  const windowSize = Number(o.windowSize);
  const qualityThreshold = Number(o.qualityThreshold);
  const minLength = Number(o.minLength);
  const maxNRatio = Number(o.maxNRatio);

  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw paramError('windowSize 必须为正整数');
  }
  if (
    !Number.isInteger(qualityThreshold) ||
    qualityThreshold < 0 ||
    qualityThreshold > 41
  ) {
    throw paramError('qualityThreshold 必须为 0..41 的整数');
  }
  if (!Number.isInteger(minLength) || minLength <= 0) {
    throw paramError('minLength 必须为正整数');
  }
  if (
    !Number.isFinite(maxNRatio) ||
    maxNRatio < 0 ||
    maxNRatio > 1
  ) {
    throw paramError('maxNRatio 必须为 [0,1] 之间的数');
  }
  return { windowSize, qualityThreshold, minLength, maxNRatio };
}

function paramError(message: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  err.code = 'INVALID_PARAMS';
  return err;
}

/** Phred+33 解码：ASCII 33..74 -> 0..41。 */
export function decodeQuality(quality: string): number[] {
  const scores = new Array<number>(quality.length);
  for (let i = 0; i < quality.length; i++) {
    scores[i] = quality.charCodeAt(i) - 33;
  }
  return scores;
}

/**
 * 滑窗裁剪（简单逐窗求和）：
 * 从左向右找第一个完整长度 W、质量和 < W*T 的窗口，
 * 在窗口起点之前截断（cut = 起点）；等于门槛通过；
 * 没有失败窗口或原长 < W 时 cut = 原长。截断后按 L 与 N 比例过滤。
 */
export function trimRecord(record: FastqRecord, params: TrimParams): TrimResult {
  const { quality, sequence } = record;
  const scores = decodeQuality(quality);
  const W = params.windowSize;
  const limit = W * params.qualityThreshold;

  let cut = scores.length;
  let failWindowStart: number | null = null;
  let failWindowSum: number | null = null;

  if (scores.length >= W) {
    let sum = 0;
    for (let i = 0; i < W; i++) sum += scores[i];
    for (let start = 0; start + W <= scores.length; start++) {
      if (sum < limit) {
        cut = start;
        failWindowStart = start;
        failWindowSum = sum;
        break;
      }
      if (start + W < scores.length) {
        sum -= scores[start];
        sum += scores[start + W];
      }
    }
  }

  let reason: TrimResult['reason'] = null;
  if (cut < params.minLength) {
    reason = 'too_short';
  } else {
    let nCount = 0;
    for (let i = 0; i < cut; i++) {
      if (sequence[i] === 'N') nCount++;
    }
    if (nCount / cut > params.maxNRatio) {
      reason = 'too_many_N';
    }
  }
  // 空段（cut=0）必然因 < minLength（正整数）失败。
  return {
    passed: reason === null,
    cut,
    failWindowStart,
    failWindowSum,
    reason
  };
}
