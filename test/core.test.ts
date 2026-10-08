import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { AppDatabase } from '../src/db.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { parseFastq, parsePair } from '../src/parser.js';
import { exportRun } from '../src/service.js';
import { decodeQuality, trimRecord } from '../src/trim.js';

function fq(header: string, seq: string, plus: string, qual: string, newline = '\n'): string {
  return [header, seq, plus, qual].join(newline) + newline;
}

const validR1 = fq('@a/1', 'ACGT', '+', 'IIII') + fq('@b/1', 'ACGTN', '+b/1', 'II!!!') + fq('@c/1', 'ACGT', '+c/1', '!III');
const validR2 = fq('@a/2', 'ACGT', '+', 'IIII') + fq('@b/2', 'ACGTN', '+b/2', 'IIIII') + fq('@c/2', 'ACGT', '+c/2', '!!I!');

test('接受 CRLF，质量行中的 @ 和 + 是普通质量字符', () => {
  const parsed = parseFastq(fq('@x/1', 'ACGTN', '+x/1', 'II+I@', '\r\n'), 'R1', DEFAULT_LIMITS);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.records[0]?.quality, 'II+I@');
});

test('错误加号描述、方向颠倒和末条截断都被拒绝', () => {
  assert.equal(parseFastq(fq('@x/1', 'ACGT', '+wrong', 'IIII'), 'R1', DEFAULT_LIMITS).ok, false);
  assert.equal(parseFastq(fq('@x/1', 'ACGT', '+', 'IIII'), 'R2', DEFAULT_LIMITS).ok, false);
  assert.equal(parseFastq(fq('@x/1', 'ACGT', '+', 'III').slice(0, -1), 'R1', DEFAULT_LIMITS).ok, false);
});

test('配对数量、顺序、重复键严格检查', () => {
  const oneR2 = fq('@a/2', 'ACGT', '+', 'IIII');
  const swappedR1 = fq('@b/1', 'ACGT', '+', 'IIII') + fq('@a/1', 'ACGT', '+', 'IIII');
  const swappedR2 = fq('@a/2', 'ACGT', '+', 'IIII') + fq('@b/2', 'ACGT', '+', 'IIII');
  const dupR1 = fq('@a/1', 'ACGT', '+', 'IIII') + fq('@a/1', 'ACGT', '+', 'IIII');
  const dupR2 = fq('@a/2', 'ACGT', '+', 'IIII') + fq('@a/2', 'ACGT', '+', 'IIII');
  assert.equal(parsePair(validR1, oneR2, DEFAULT_LIMITS).ok, false);
  assert.equal(parsePair(swappedR1, swappedR2, DEFAULT_LIMITS).ok, false);
  assert.equal(parsePair(dupR1, dupR2, DEFAULT_LIMITS).ok, false);
});

test('逐窗独立基准核对零位截断、无失败窗口和等门槛', () => {
  assert.deepEqual(decodeQuality('III!!!'), [40, 40, 40, 0, 0, 0]);
  const failed = trimRecord('ACGTNN', 'III!!!', { windowSize: 3, qualityThreshold: 20, minLength: 3, maxNRatio: 1 });
  assert.equal(failed.cutPosition, 2);
  assert.equal(failed.evidence.firstFailedWindowStart, 2);
  assert.deepEqual(failed.reasons, ['too_short']);

  const zero = trimRecord('ACG', '!!!', { windowSize: 3, qualityThreshold: 20, minLength: 1, maxNRatio: 1 });
  assert.equal(zero.cutPosition, 0);
  assert.equal(zero.passed, false);

  const equal = trimRecord('ACGT', 'TTTT', { windowSize: 3, qualityThreshold: 20, minLength: 1, maxNRatio: 1 });
  assert.equal(equal.cutPosition, 4);
  assert.equal(equal.evidence.firstFailedWindowStart, null);

  const short = trimRecord('AC', 'II', { windowSize: 3, qualityThreshold: 20, minLength: 3, maxNRatio: 1 });
  assert.equal(short.cutPosition, 2);
  assert.equal(short.passed, false);

  const nBoundary = trimRecord('ANAN', 'IIII', { windowSize: 3, qualityThreshold: 20, minLength: 1, maxNRatio: 0.5 });
  assert.equal(nBoundary.passed, true);
});

test('两种孤儿策略、类别守恒和输出前缀字节一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastq-test-'));
  const db = new AppDatabase(join(dir, 'app.sqlite'));
  try {
    const imported = db.importPair(validR1, validR2, DEFAULT_LIMITS);
    const params = { windowSize: 3, qualityThreshold: 20, minLength: 3, maxNRatio: 1 };
    const keep = db.submitRun(imported.batchId, params, 'keep_singletons');
    const discard = db.submitRun(imported.batchId, params, 'discard_pair');
    const stats = keep.stats;
    assert.equal(stats.totalPairs, stats.paired + stats.singletonR1 + stats.singletonR2 + stats.droppedPairs);
    assert.equal(stats.paired, 1);
    assert.equal(stats.singletonR2, 1);
    assert.equal(discard.stats.droppedPairs, 2);

    const first = exportRun(db, keep.runId, join(dir, 'out'));
    const second = exportRun(db, keep.runId, join(dir, 'out'));
    assert.deepEqual(first, second);
    for (const item of Object.values(first)) {
      const bytes = readFileSync(item.path);
      assert.equal(bytes.length, item.bytes);
    }
    const pairedR1 = readFileSync(first.paired_R1.path, 'utf8');
    const pairedR2 = readFileSync(first.paired_R2.path, 'utf8');
    assert.match(pairedR1, /^@a\/1\nACGT\n\+\nIIII\n$/);
    assert.match(pairedR2, /^@a\/2\nACGT\n\+\nIIII\n$/);
    const singletonR2 = readFileSync(first.singleton_R2.path, 'utf8');
    assert.match(singletonR2, /^@b\/2\nACGTN\n\+b\/2\nIIIII\n$/);
    assert.equal(readFileSync(first.paired_R1.path).equals(readFileSync(second.paired_R1.path)), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('失败导入整体回滚，重复运行请求幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastq-test-'));
  const db = new AppDatabase(join(dir, 'app.sqlite'));
  try {
    assert.throws(() => db.importPair(validR1, fq('@a/2', 'ACGT', '+', 'IIII'), DEFAULT_LIMITS));
    const count = db.db.prepare('SELECT COUNT(*) AS count FROM batches').get() as { count: number };
    assert.equal(count.count, 0);
    const imported = db.importPair(validR1, validR2, DEFAULT_LIMITS);
    const params = { windowSize: 3, qualityThreshold: 20, minLength: 3, maxNRatio: 1 };
    const a = db.submitRun(imported.batchId, params, 'discard_pair');
    const b = db.submitRun(imported.batchId, params, 'discard_pair');
    assert.equal(a.runId, b.runId);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {});
