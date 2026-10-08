/**
 * 全局处理上限，防止异常大文件耗尽资源。可通过环境变量覆盖。
 */
export interface Limits {
  /** 单文件允许的最大字节数。 */
  maxBytes: number;
  /** 单条记录（单行）允许的最大字符数。 */
  maxLineLength: number;
  /** 单个文件允许的最大记录数。 */
  maxRecords: number;
}

export function defaultLimits(): Limits {
  return {
    maxBytes: Number(process.env.FASTQ_MAX_BYTES ?? 50 * 1024 * 1024),
    maxLineLength: Number(process.env.FASTQ_MAX_LINE_LENGTH ?? 1_000_000),
    maxRecords: Number(process.env.FASTQ_MAX_RECORDS ?? 2_000_000)
  };
}
