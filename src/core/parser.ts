import { FastqError, FastqRecord, Side } from './types.js';
import { Limits } from './limits.js';

const SEQ_RE = /^[ACGTN]+$/;

/**
 * 解析固定四行 FASTQ 文本。支持 LF/CRLF、末尾换行可省略；
 * 不支持折行、空记录、空白行。质量字符仅允许 ASCII 33..74（Phred+33，0..41）。
 */
export function parseFastq(
  content: string,
  side: Side,
  limits: Limits
): { records: FastqRecord[] } {
  if (content.length > limits.maxBytes) {
    throw new FastqError({
      code: 'FILE_TOO_LARGE',
      message: `R${side} 文件大小 ${content.length} 字节超过上限 ${limits.maxBytes}`
    });
  }

  const lines = splitLines(content);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    throw new FastqError({
      code: 'EMPTY_FILE',
      message: `R${side} 文件为空`
    });
  }
  if (lines.length % 4 !== 0) {
    throw new FastqError({
      code: 'TRUNCATED_RECORD',
      message: `R${side} 行数 ${lines.length} 不是 4 的倍数，末条记录不完整`,
      line: lines.length + 1
    });
  }

  const records: FastqRecord[] = [];
  const recordCount = lines.length / 4;
  if (recordCount > limits.maxRecords) {
    throw new FastqError({
      code: 'TOO_MANY_RECORDS',
      message: `R${side} 记录数 ${recordCount} 超过上限 ${limits.maxRecords}`
    });
  }

  for (let i = 0; i < lines.length; i += 4) {
    const recordNo = i / 4 + 1;
    const headerLine = lines[i];
    const seqLine = lines[i + 1];
    const plusLine = lines[i + 2];
    const qualLine = lines[i + 3];

    if (headerLine.length > limits.maxLineLength) {
      throw tooLong(side, recordNo, i + 1, headerLine.length, limits);
    }
    if (!headerLine.startsWith('@')) {
      throw new FastqError({
        code: 'BAD_HEADER',
        message: `R${side} 第 ${recordNo} 条记录第 ${i + 1} 行应以 '@' 开头`,
        record: recordNo,
        line: i + 1
      });
    }
    const header = headerLine.slice(1);
    const mToken = /^[^\S]*(?<token>\S+)(?:[^\S]+(?<rest>.*))?$/.exec(header);
    const name = mToken?.groups?.token ?? '';
    const description = mToken?.groups?.rest ?? '';
    if (!name) {
      throw new FastqError({
        code: 'EMPTY_NAME',
        message: `R${side} 第 ${recordNo} 条记录名称为空`,
        record: recordNo,
        line: i + 1
      });
    }

    if (seqLine.length === 0) {
      throw new FastqError({
        code: 'EMPTY_SEQUENCE',
        message: `R${side} 第 ${recordNo} 条序列为空（不允许空白记录）`,
        record: recordNo,
        line: i + 2
      });
    }
    if (seqLine.length > limits.maxLineLength) {
      throw tooLong(side, recordNo, i + 2, seqLine.length, limits);
    }
    if (!SEQ_RE.test(seqLine)) {
      const col = firstBadSeqColumn(seqLine);
      throw new FastqError({
        code: 'BAD_SEQUENCE',
        message: `R${side} 第 ${recordNo} 条序列含非法字符（仅允许大写 ACGTN），列 ${col}`,
        record: recordNo,
        line: i + 2,
        column: col
      });
    }

    if (plusLine !== '+' && plusLine !== '+' + header) {
      throw new FastqError({
        code: 'BAD_PLUS_LINE',
        message: `R${side} 第 ${recordNo} 条第三行必须是单独 '+' 或 '+${header}'，实际为 '${truncate(plusLine)}'`,
        record: recordNo,
        line: i + 3
      });
    }

    if (qualLine.length === 0) {
      throw new FastqError({
        code: 'EMPTY_QUALITY',
        message: `R${side} 第 ${recordNo} 条质量串为空`,
        record: recordNo,
        line: i + 4
      });
    }
    if (qualLine.length > limits.maxLineLength) {
      throw tooLong(side, recordNo, i + 4, qualLine.length, limits);
    }
    if (qualLine.length !== seqLine.length) {
      throw new FastqError({
        code: 'QUALITY_LENGTH_MISMATCH',
        message: `R${side} 第 ${recordNo} 条质量串长度 ${qualLine.length} 与序列长度 ${seqLine.length} 不一致`,
        record: recordNo,
        line: i + 4
      });
    }
    for (let c = 0; c < qualLine.length; c++) {
      const code = qualLine.charCodeAt(c);
      if (code < 33 || code > 74) {
        throw new FastqError({
          code: 'BAD_QUALITY_CHAR',
          message: `R${side} 第 ${recordNo} 条质量串第 ${c + 1} 列字符 '${qualLine[c]}' (ASCII ${code}) 超出 Phred+33 允许范围 33..74`,
          record: recordNo,
          line: i + 4,
          column: c + 1
        });
      }
    }

    const { key, hadSuffix } = pairingKey(name, side, recordNo);
    records.push({
      index: recordNo,
      name,
      header,
      description,
      sequence: seqLine,
      plusLine,
      quality: qualLine,
      key,
      hadSideSuffix: hadSuffix
    });
  }
  return { records };
}

function tooLong(
  side: Side,
  recordNo: number,
  line: number,
  length: number,
  limits: Limits
): FastqError {
  return new FastqError({
    code: 'LINE_TOO_LONG',
    message: `R${side} 第 ${recordNo} 条第 ${line} 行长度 ${length} 超过上限 ${limits.maxLineLength}`,
    record: recordNo,
    line
  });
}

function firstBadSeqColumn(seq: string): number {
  for (let i = 0; i < seq.length; i++) {
    if (!'ACGTN'.includes(seq[i])) return i + 1;
  }
  return seq.length + 1;
}

function truncate(s: string): string {
  return s.length > 40 ? s.slice(0, 40) + '...' : s;
}

/**
 * 计算配对键：名称以 /1 或 /2 结尾时必须与文件方向一致，去掉后缀作为键；
 * 否则原 token 作为键。
 */
export function pairingKey(
  name: string,
  side: Side,
  recordNo: number
): { key: string; hadSuffix: boolean } {
  const m = name.match(/^(.*)\/([12])$/);
  if (m) {
    const suffix = Number(m[2]) as Side;
    if (suffix !== side) {
      throw new FastqError({
        code: 'SIDE_SUFFIX_MISMATCH',
        message: `R${side} 第 ${recordNo} 条名称 '${name}' 的方向后缀 /${suffix} 与文件方向 R${side} 不符`,
        record: recordNo
      });
    }
    return { key: m[1], hadSuffix: true };
  }
  return { key: name, hadSuffix: false };
}

/**
 * 按行切分，去掉行尾 CR。不允许任何空白/空行（调用方按 4 行一组严格校验）。
 */
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const raw = content.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
