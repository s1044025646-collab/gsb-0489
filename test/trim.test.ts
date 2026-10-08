import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimRecord, validateParams } from '../dist/core/trim.js';
import { bruteForceCut } from './lib/helpers.js';
import type { FastqRecord } from '../dist/core/types.js';

function rec(seq: string, scores: number[], name = 'r/1'): FastqRecord {
  return {
    index: 1,
    name,
    header: name,
    description: '',
    sequence: seq,
    plusLine: `+${name}`,
    quality: scores.map((s) => String.fromCharCode(s + 33)).join(''),
    key: 'r',
    hadSideSuffix: true
  };
}

const params = { windowSize: 3, qualityThreshold: 20, minLength: 3, maxNRatio: 0.5 };

test('III!!!：第一失败窗口起点 2，cut=2，过短失败', () => {
  const scores = [40, 40, 40, 0, 0, 0];
  const r = trimRecord(rec('ACGTNA', scores), params);
  assert.equal(r.cut, 2);
  assert.equal(r.failWindowStart, 2);
  assert.equal(r.failWindowSum, 40);
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'too_short');
});

test('IIIIII 无失败窗口：保留整条并通过', () => {
  const r = trimRecord(rec('ACGTAC', [40, 40, 40, 40, 40, 40]), params);
  assert.equal(r.cut, 6);
  assert.equal(r.failWindowStart, null);
  assert.equal(r.passed, true);
});

test('窗口和恰好等于门槛（60）通过', () => {
  const r = trimRecord(rec('ACGT', [20, 20, 20, 40]), params);
  assert.equal(r.cut, 4);
  assert.equal(r.passed, true);
});

test('长度不足一个窗口时不截断，再按 L 判断', () => {
  const short = trimRecord(rec('AC', [40, 40]), params);
  assert.equal(short.cut, 2);
  assert.equal(short.failWindowStart, null);
  assert.equal(short.passed, false);
  assert.equal(short.reason, 'too_short');
});

test('零位截断（窗口 0 即失败）导致空段，必失败', () => {
  const r = trimRecord(rec('ACGT', [0, 0, 0, 40]), params);
  assert.equal(r.cut, 0);
  assert.equal(r.failWindowStart, 0);
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'too_short');
});

test('N 比例恰好上限通过，超过上限失败', () => {
  // scores [40,40,40,0,0]：窗口0=120、窗口1=80、窗口2=40<60，cut=2，保留 "AN" -> N 比例 0.5，恰好通过
  const pL2 = { ...params, minLength: 2 };
  const atLimit = trimRecord(rec('ANCCC', [40, 40, 40, 0, 0]), pL2);
  assert.equal(atLimit.cut, 2);
  assert.equal(atLimit.passed, true);
  // 同样 cut=2，保留 "NN" -> 比例 1 > 0.5
  const over = trimRecord(rec('NNCCC', [40, 40, 40, 0, 0]), { ...pL2, maxNRatio: 0.5 });
  assert.equal(over.passed, false);
  assert.equal(over.reason, 'too_many_N');
});

test('随机情形与独立逐窗基准一致', () => {
  const cases: Array<{ seq: string; scores: number[]; W: number; T: number }> = [
    { seq: 'ACGTACGT', scores: [40, 30, 20, 10, 0, 30, 40, 40], W: 4, T: 20 },
    { seq: 'ACGT', scores: [5, 5, 5, 5], W: 2, T: 10 },
    { seq: 'ACGTAC', scores: [41, 41, 41, 41, 0, 0], W: 3, T: 20 },
    { seq: 'AC', scores: [40, 40], W: 5, T: 20 },
    { seq: 'ACGTACGTAC', scores: [30, 30, 10, 30, 30, 10, 30, 30, 30, 30], W: 3, T: 20 }
  ];
  for (const c of cases) {
    const expected = bruteForceCut(c.scores, c.W, c.T);
    const r = trimRecord(rec(c.seq, c.scores), { ...params, windowSize: c.W, qualityThreshold: c.T, minLength: 1, maxNRatio: 1 });
    assert.equal(r.cut, expected, `scores=${c.scores} W=${c.W} T=${c.T}`);
  }
});

test('参数校验', () => {
  assert.throws(() => validateParams({ windowSize: 0, qualityThreshold: 20, minLength: 1, maxNRatio: 0 }), /正整数/);
  assert.throws(() => validateParams({ windowSize: 3, qualityThreshold: 42, minLength: 1, maxNRatio: 0 }), /0\.\.41/);
  assert.throws(() => validateParams({ windowSize: 3, qualityThreshold: 20, minLength: 1, maxNRatio: 1.5 }), /\[0,1\]/);
  assert.doesNotThrow(() =>
    validateParams({ windowSize: 1, qualityThreshold: 0, minLength: 1, maxNRatio: 0 })
  );
});
