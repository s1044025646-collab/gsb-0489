import { AppError } from './errors.js';
import type { FastqRecord, Limits, PairRecord, Side, ValidationIssue } from './types.js';

const SEQ_RE = /^[ACGTN]+$/;

function issue(code: string, message: string, side?: Side, recordNumber?: number, column?: number): ValidationIssue {
  return {
    code,
    message,
    ...(side === undefined ? {} : { side }),
    ...(recordNumber === undefined ? {} : { recordNumber }),
    ...(column === undefined ? {} : { column })
  };
}

export function splitFastqLines(content: string): string[] {
  if (content.includes('\r') && !/\r\n/.test(content)) {
    throw new AppError('INVALID_LINE_ENDING', '仅支持 LF 或 CRLF 换行');
  }
  const normalized = content.endsWith('\r\n')
    ? content.slice(0, -2)
    : content.endsWith('\n')
      ? content.slice(0, -1)
      : content;
  return normalized.length === 0 ? [] : normalized.split(/\r\n|\n/);
}

function parseHeader(line: string, side: Side, recordNumber: number):
  | { ok: true; value: Omit<FastqRecord, 'sequence' | 'plusLine' | 'quality'> }
  | { ok: false; value: ValidationIssue } {
  if (!line.startsWith('@')) return { ok: false, value: issue('INVALID_HEADER', '第一行必须以 @ 开头', side, recordNumber, 1) };

  const afterAt = line.slice(1);
  const match = /\S+/.exec(afterAt);
  if (!match || match.index === undefined) return { ok: false, value: issue('EMPTY_RECORD_NAME', '@ 后必须包含非空名称', side, recordNumber, 2) };

  const name = match[0];
  const description = afterAt.slice(match.index + name.length);
  let suffix: '/1' | '/2' | null = name.endsWith('/1') ? '/1' : name.endsWith('/2') ? '/2' : null;
  if ((suffix === '/1' && side !== 'R1') || (suffix === '/2' && side !== 'R2')) {
    return { ok: false, value: issue('ORIENTATION_MISMATCH', `名称方向后缀 ${suffix} 与所在文件方向不符`, side, recordNumber, line.length - 1) };
  }
  const pairKey = suffix ? name.slice(0, -2) : name;
  if (pairKey.length === 0) return { ok: false, value: issue('EMPTY_PAIR_KEY', '去掉方向后缀后配对键为空', side, recordNumber) };
  return { ok: true, value: { recordNumber, name, description, headerLine: line, pairKey } };
}

function qualityValid(quality: string): boolean {
  for (let index = 0; index < quality.length; index += 1) {
    const ascii = quality.charCodeAt(index);
    if (ascii < 33 || ascii > 74) return false;
  }
  return true;
}

export function parseFastq(content: string, side: Side, limits: Limits):
  | { ok: true; records: FastqRecord[] }
  | { ok: false; issues: ValidationIssue[] } {
  if (Buffer.byteLength(content, 'utf8') > limits.maxBytes) {
    return { ok: false, issues: [issue('INPUT_TOO_LARGE', `输入超过 ${limits.maxBytes} 字节上限`, side)] };
  }
  let lines: string[];
  try {
    lines = splitFastqLines(content);
  } catch (error) {
    return { ok: false, issues: [issue('INVALID_LINE_ENDING', error instanceof Error ? error.message : '非法换行', side)] };
  }
  if (lines.length === 0) return { ok: true, records: [] };
  if (lines.length % 4 !== 0) {
    return { ok: false, issues: [issue('TRUNCATED_RECORD', '文件末尾存在不完整的四行记录', side, Math.floor(lines.length / 4) + 1)] };
  }

  const recordCount = lines.length / 4;
  if (recordCount > limits.maxRecords) return { ok: false, issues: [issue('TOO_MANY_RECORDS', `记录数超过 ${limits.maxRecords} 上限`, side)] };

  const records: FastqRecord[] = [];
  const issues: ValidationIssue[] = [];
  for (let recordNumber = 1; recordNumber <= recordCount; recordNumber += 1) {
    const base = (recordNumber - 1) * 4;
    const headerLine = lines[base] ?? '';
    const sequence = lines[base + 1] ?? '';
    const plusLine = lines[base + 2] ?? '';
    const quality = lines[base + 3] ?? '';
    if (headerLine.length === 0 || sequence.length === 0 || plusLine.length === 0 || quality.length === 0) {
      issues.push(issue('BLANK_RECORD_LINE', '不支持空白记录、折行序列或空白行', side, recordNumber));
      continue;
    }
    if ([headerLine, sequence, plusLine, quality].some((line) => line.length > limits.maxRecordLength)) {
      issues.push(issue('RECORD_TOO_LONG', `记录长度超过 ${limits.maxRecordLength} 上限`, side, recordNumber));
      continue;
    }

    const parsedHeader = parseHeader(headerLine, side, recordNumber);
    if (!parsedHeader.ok) issues.push(parsedHeader.value);
    if (!SEQ_RE.test(sequence)) {
      const bad = /[^ACGTN]/.exec(sequence);
      issues.push(issue('INVALID_SEQUENCE', '序列只允许非空大写 ACGTN', side, recordNumber, bad ? bad.index + 1 : undefined));
    }
    if (plusLine !== '+' && plusLine !== `+${headerLine.slice(1)}`) {
      issues.push(issue('INVALID_PLUS_LINE', '第三行必须是单独 +，或与第一行去掉 @ 后完全一致', side, recordNumber));
    }
    for (let column = 0; column < quality.length; column += 1) {
      const ascii = quality.charCodeAt(column);
      if (ascii < 33 || ascii > 74) {
        issues.push(issue('INVALID_QUALITY_CHARACTER', `质量字符必须位于 ASCII 33 到 74，收到 ASCII ${ascii}`, side, recordNumber, column + 1));
        break;
      }
    }
    if (sequence.length !== quality.length) issues.push(issue('QUALITY_LENGTH_MISMATCH', '质量串长度必须与序列长度相等', side, recordNumber));

    if (
      parsedHeader.ok &&
      SEQ_RE.test(sequence) &&
      (plusLine === '+' || plusLine === `+${headerLine.slice(1)}`) &&
      sequence.length === quality.length &&
      qualityValid(quality)
    ) {
      records.push({ ...parsedHeader.value, sequence, plusLine, quality });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, records };
}

export function parsePair(r1Content: string, r2Content: string, limits: Limits):
  | { ok: true; pairs: PairRecord[] }
  | { ok: false; issues: ValidationIssue[] } {
  const r1 = parseFastq(r1Content, 'R1', limits);
  const r2 = parseFastq(r2Content, 'R2', limits);
  if (!r1.ok || !r2.ok) return { ok: false, issues: [...(r1.ok ? [] : r1.issues), ...(r2.ok ? [] : r2.issues)] };

  if (r1.records.length !== r2.records.length) {
    return { ok: false, issues: [issue('PAIR_COUNT_MISMATCH', `R1 有 ${r1.records.length} 条，R2 有 ${r2.records.length} 条，数量必须相等`)] };
  }

  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < r1.records.length; index += 1) {
    const left = r1.records[index]!;
    const right = r2.records[index]!;
    if (left.pairKey !== right.pairKey) {
      issues.push(issue('PAIR_ORDER_MISMATCH', `第 ${index + 1} 对配对键不一致：R1=${left.pairKey}，R2=${right.pairKey}`, undefined, index + 1));
    }
    if (seen.has(left.pairKey)) issues.push(issue('DUPLICATE_PAIR_KEY', `批内配对键重复：${left.pairKey}`, undefined, index + 1));
    seen.add(left.pairKey);
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    pairs: r1.records.map((record, index) => ({
      ordinal: index + 1,
      pairKey: record.pairKey,
      R1: record,
      R2: r2.records[index]!
    }))
  };
}
