/** 方向：1 = R1，2 = R2。 */
export type Side = 1 | 2;

/** 孤儿策略：discard_pair 丢弃整对；keep_singletons 保留通过的一侧。 */
export type OrphanStrategy = 'discard_pair' | 'keep_singletons';

/** 裁剪参数。 */
export interface TrimParams {
  /** 窗口长度 W，正整数。 */
  windowSize: number;
  /** 平均质量门槛 T，0..41。 */
  qualityThreshold: number;
  /** 最短保留长度 L，正整数。 */
  minLength: number;
  /** 允许的 N 碱基比例上限，[0,1]。 */
  maxNRatio: number;
}

/** 单条原始 FASTQ 记录。 */
export interface FastqRecord {
  /** 在原文件中的序号（从 1 开始）。 */
  index: number;
  /** '@' 后第一个非空 token。 */
  name: string;
  /** '@' 之后的完整标题行（含描述，不含 '@' 与结尾换行）。 */
  header: string;
  /** 描述部分（第一个 token 之后的原始内容，无描述则为空串）。 */
  description: string;
  /** 原始序列行。 */
  sequence: string;
  /** 第三行（'+' 或 '+标题'）。 */
  plusLine: string;
  /** 原始质量串。 */
  quality: string;
  /** 配对键。 */
  key: string;
  /** 名称是否带 /1 或 /2 后缀。 */
  hadSideSuffix: boolean;
}

/** 单条裁剪结果。 */
export interface TrimResult {
  /** 通过（保留）与否。 */
  passed: boolean;
  /** 裁剪半开区间终点 cut = 保留前缀长度；无失败窗口时等于原长。 */
  cut: number;
  /** 第一失败窗口零基起点；无失败窗口为 null。 */
  failWindowStart: number | null;
  /** 第一失败窗口内质量和。 */
  failWindowSum: number | null;
  /** 失败原因（passed 为 false 时给出）。 */
  reason: null | 'too_short' | 'too_many_N';
}

export interface ParseErrorDetail {
  code: string;
  message: string;
  record?: number;
  line?: number;
  column?: number;
}

export class FastqError extends Error {
  code: string;
  record?: number;
  line?: number;
  column?: number;
  constructor(detail: ParseErrorDetail) {
    super(detail.message);
    this.name = 'FastqError';
    this.code = detail.code;
    this.record = detail.record;
    this.line = detail.line;
    this.column = detail.column;
  }
}
