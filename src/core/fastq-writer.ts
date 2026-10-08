import { FastqRecord } from './types.js';

/** 以源记录格式写出四行 FASTQ（统一 LF）。描述原样保留。 */
export function formatRecord(
  record: Pick<FastqRecord, 'header'>,
  sequence: string,
  quality: string
): string {
  return `@${record.header}\n${sequence}\n+\n${quality}\n`;
}
