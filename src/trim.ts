import { AppError } from './errors.js';
import type {
  Category,
  PairRecord,
  PairResult,
  RunStats,
  Strategy,
  TrimDecision,
  TrimParams
} from './types.js';

export function validateParams(params: TrimParams): TrimParams {
  if (!Number.isInteger(params.windowSize) || params.windowSize <= 0) {
    throw new AppError('INVALID_WINDOW_SIZE', 'windowSize 必须是正整数');
  }
  if (!Number.isInteger(params.qualityThreshold) || params.qualityThreshold < 0 || params.qualityThreshold > 41) {
    throw new AppError('INVALID_QUALITY_THRESHOLD', 'qualityThreshold 必须是 0 到 41 的整数');
  }
  if (!Number.isInteger(params.minLength) || params.minLength <= 0) {
    throw new AppError('INVALID_MIN_LENGTH', 'minLength 必须是正整数');
  }
  if (typeof params.maxNRatio !== 'number' || Number.isNaN(params.maxNRatio) || params.maxNRatio < 0 || params.maxNRatio > 1) {
    throw new AppError('INVALID_MAX_N_RATIO', 'maxNRatio 必须是 0 到 1 的数字');
  }
  return params;
}

export function decodeQuality(quality: string): number[] {
  const scores: number[] = [];
  for (let index = 0; index < quality.length; index += 1) {
    scores.push(quality.charCodeAt(index) - 33);
  }
  return scores;
}

export function trimRecord(sequence: string, quality: string, params: TrimParams): TrimDecision {
  validateParams(params);
  const scores = decodeQuality(quality);
  const thresholdSum = params.windowSize * params.qualityThreshold;
  let firstFailedWindowStart: number | null = null;
  let windowQualitySum: number | null = null;

  if (scores.length >= params.windowSize) {
    for (let start = 0; start + params.windowSize <= scores.length; start += 1) {
      let sum = 0;
      for (let offset = 0; offset < params.windowSize; offset += 1) {
        sum += scores[start + offset]!;
      }
      if (sum < thresholdSum) {
        firstFailedWindowStart = start;
        windowQualitySum = sum;
        break;
      }
    }
  }

  const cutPosition = firstFailedWindowStart ?? sequence.length;
  const prefix = sequence.slice(0, cutPosition);
  let nCount = 0;
  for (const base of prefix) {
    if (base === 'N') nCount += 1;
  }
  const reasons: string[] = [];
  if (cutPosition < params.minLength) reasons.push('too_short');
  if (cutPosition === 0 || nCount / cutPosition > params.maxNRatio) reasons.push('too_many_N');

  return {
    cutPosition,
    passed: reasons.length === 0,
    reasons,
    evidence: {
      windowSize: params.windowSize,
      firstFailedWindowStart,
      windowQualitySum,
      thresholdSum
    }
  };
}

export function classifyPairs(pairs: PairRecord[], params: TrimParams, strategy: Strategy): PairResult[] {
  if (strategy !== 'discard_pair' && strategy !== 'keep_singletons') {
    throw new AppError('INVALID_STRATEGY', 'strategy 必须是 discard_pair 或 keep_singletons');
  }
  return pairs.map((pair) => {
    const r1 = trimRecord(pair.R1.sequence, pair.R1.quality, params);
    const r2 = trimRecord(pair.R2.sequence, pair.R2.quality, params);
    let category: Category;
    if (r1.passed && r2.passed) category = 'paired';
    else if (!r1.passed && !r2.passed) category = 'dropped_pair';
    else if (r1.passed && strategy === 'keep_singletons') category = 'singleton_R1';
    else if (r2.passed && strategy === 'keep_singletons') category = 'singleton_R2';
    else category = 'dropped_pair';
    return { ...pair, category, r1, r2 };
  });
}

export function summarize(results: PairResult[]): RunStats {
  return {
    totalPairs: results.length,
    paired: results.filter((result) => result.category === 'paired').length,
    singletonR1: results.filter((result) => result.category === 'singleton_R1').length,
    singletonR2: results.filter((result) => result.category === 'singleton_R2').length,
    droppedPairs: results.filter((result) => result.category === 'dropped_pair').length
  };
}
