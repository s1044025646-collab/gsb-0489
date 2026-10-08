import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFastq } from '../dist/core/parser.js';
import { defaultLimits } from '../dist/core/limits.js';
import { expectFail, qual, renderFastq } from './lib/helpers.js';

const limits = defaultLimits();

test('解析标准记录并计算配对键与描述', () => {
  const text = renderFastq([
    { name: 'readA/1', desc: 'sample=42 run=x', seq: 'ACGT', scores: [40, 40, 40, 40] }
  ]);
  const { records } = parseFastq(text, 1, limits);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'readA/1');
  assert.equal(records[0].key, 'readA');
  assert.equal(records[0].description, 'sample=42 run=x');
  assert.equal(records[0].hadSideSuffix, true);
});

test('CRLF 与无末尾换行均可解析', () => {
  const a = renderFastq(
    [{ name: 'x/1', seq: 'ACGT', scores: [10, 20, 30, 40] }],
    { eol: '\r\n' }
  );
  const b = renderFastq(
    [{ name: 'y/1', seq: 'ACGT', scores: [10, 20, 30, 40] }],
    { trailingNewline: false }
  );
  assert.equal(parseFastq(a, 1, limits).records[0].quality, qual([10, 20, 30, 40]));
  assert.equal(parseFastq(b, 1, limits).records[0].sequence, 'ACGT');
});

test('质量行中的 @ 和 + 是普通字符，不作为新记录', () => {
  const text = `@r/1\nACGT\n+\n${qual([31, 10, 40, 41])}\n`;
  const parsed = parseFastq(text, 1, limits);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].quality[0], '@');
  assert.equal(parsed.records[0].quality[1], '+');
});

test('错误的加号描述被拒绝', () => {
  const text = renderFastq([
    { name: 'r/1', seq: 'ACGT', scores: [40, 40, 40, 40], plus: '+r/2' }
  ]);
  expectFail(() => parseFastq(text, 1, limits), 'BAD_PLUS_LINE');
});

test('单独 + 的第三行被接受', () => {
  const text = `@r/1\nACGT\n+\n${qual([40, 40, 40, 40])}\n`;
  assert.equal(parseFastq(text, 1, limits).records[0].plusLine, '+');
});

test('名字方向后缀颠倒被拒绝', () => {
  const text = renderFastq([{ name: 'r/2', seq: 'ACGT', scores: [40, 40, 40, 40] }]);
  expectFail(() => parseFastq(text, 1, limits), 'SIDE_SUFFIX_MISMATCH');
});

test('非法质量字符报告记录号与列', () => {
  const text = `@r/1\nACGT\n+\n${qual([40, 40, 40, 42])}\n`;
  const err = expectFail(() => parseFastq(text, 1, limits), 'BAD_QUALITY_CHAR') as Error & {
    record?: number;
    column?: number;
  };
  assert.equal(err.record, 1);
  assert.equal(err.column, 4);
});

test('质量串与序列不等长被拒绝', () => {
  const text = `@r/1\nACGT\n+\n${qual([40, 40, 40])}\n`;
  expectFail(() => parseFastq(text, 1, limits), 'QUALITY_LENGTH_MISMATCH');
});

test('行数不是 4 的倍数（末条截断）被拒绝', () => {
  const text = `@r/1\nACGT\n+\n${qual([40, 40, 40])}\n@r2/1\nACGT\n`;
  expectFail(() => parseFastq(text, 1, limits), 'TRUNCATED_RECORD');
});

test('非法序列字符与空序列被拒绝', () => {
  expectFail(
    () => parseFastq(`@r/1\nacgt\n+\n${qual([40, 40, 40, 40])}\n`, 1, limits),
    'BAD_SEQUENCE'
  );
  expectFail(() => parseFastq('@r/1\n\n+\nAAAA\n', 1, limits), 'EMPTY_SEQUENCE');
});

test('空文件与空记录被拒绝', () => {
  expectFail(() => parseFastq('', 1, limits), 'EMPTY_FILE');
});
