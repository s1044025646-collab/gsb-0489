import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PARAMS,
  expectFail,
  freshDb,
  makeTempDir,
  qual,
  renderFastq
} from './lib/helpers.js';
import type { FastqSpec } from './lib/helpers.js';
import { importBatch } from '../dist/services/import-service.js';
import { processBatch } from '../dist/services/process-service.js';
import { queryPair } from '../dist/services/query-service.js';
import { exportRun } from '../dist/services/export-service.js';

interface PairSpecs {
  r1: Array<FastqSpec & { plus?: string }>;
  r2: Array<FastqSpec & { plus?: string }>;
}

function matchingPair(
  bases: Array<[string, string, number[], number[]]>,
  suffix = true
): PairSpecs {
  const r1: FastqSpec[] = [];
  const r2: FastqSpec[] = [];
  bases.forEach(([n, seq, s1, s2], i) => {
    const base = suffix ? `${n}/` : n;
    r1.push({ name: `${base}${suffix ? '1' : ''}`, seq, scores: s1 });
    r2.push({ name: `${base}${suffix ? '2' : ''}`, seq, scores: s2 });
    void i;
  });
  return { r1, r2 };
}

test('配对键不一致（顺序错位）导入失败', () => {
  const dir = makeTempDir();
  const { db } = freshDb(dir);
  const r1 = renderFastq([
    { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] },
    { name: 'b/1', seq: 'ACGT', scores: [40, 40, 40, 40] }
  ]);
  const r2 = renderFastq([
    { name: 'b/2', seq: 'ACGT', scores: [40, 40, 40, 40] },
    { name: 'a/2', seq: 'ACGT', scores: [40, 40, 40, 40] }
  ]);
  expectFail(() => importBatch(db, r1, r2), 'PAIR_KEY_MISMATCH');
  const count = db.prepare('SELECT COUNT(*) AS c FROM batches').get() as { c: number };
  assert.equal(count.c, 0, '失败导入已整体回滚');
});

test('重复键导入失败', () => {
  const dir = makeTempDir();
  const { db } = freshDb(dir);
  const mk = () =>
    renderFastq([
      { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] },
      { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] }
    ]);
  const r1 = mk();
  const r2 = renderFastq([
    { name: 'a/2', seq: 'ACGT', scores: [40, 40, 40, 40] },
    { name: 'a/2', seq: 'ACGT', scores: [40, 40, 40, 40] }
  ]);
  void r1;
  expectFail(
    () =>
      importBatch(
        db,
        renderFastq([
          { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] },
          { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] }
        ]),
        r2
      ),
    'DUPLICATE_KEY'
  );
});

test('数量不等导入失败', () => {
  const dir = makeTempDir();
  const { db } = freshDb(dir);
  const r1 = renderFastq([
    { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] },
    { name: 'b/1', seq: 'ACGT', scores: [40, 40, 40, 40] }
  ]);
  const r2 = renderFastq([{ name: 'a/2', seq: 'ACGT', scores: [40, 40, 40, 40] }]);
  expectFail(() => importBatch(db, r1, r2), 'RECORD_COUNT_MISMATCH');
});

test('末条损坏：原子失败且不产生批次', () => {
  const dir = makeTempDir();
  const { db } = freshDb(dir);
  const good: FastqSpec[] = [
    { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] },
    { name: 'b/1', seq: 'ACGT', scores: [40, 40, 40, 40] }
  ];
  const r1 = renderFastq(good);
  const r2Broken =
    renderFastq([{ name: 'a/2', seq: 'ACGT', scores: [40, 40, 40, 40] }]) +
    '@b/2\nACGN\n+\nIIII\n@c/2\nAC';
  expectFail(() => importBatch(db, r1, r2Broken), 'TRUNCATED_RECORD');
  const count = db.prepare('SELECT COUNT(*) AS c FROM batches').get() as { c: number };
  assert.equal(count.c, 0);
});

test('完整批次：两种孤儿策略与类别守恒', () => {
  const dir = makeTempDir();
  const { db, dataDir } = freshDb(dir);
  // 对1: R1 III!!! 过短失败，R2 IIIIII 通过 -> 孤儿
  // 对2: 两侧通过 -> paired
  // 对3: 两侧过短 -> dropped
  // 对4: R1 通过，R2 cut=0 失败 -> 孤儿 R1
  const pairs = matchingPair([
    ['readA', 'ACGTNA', [40, 40, 40, 0, 0, 0], [40, 40, 40, 40, 40, 40]],
    ['readB', 'ACGTAC', [40, 40, 40, 40, 40, 40], [40, 40, 40, 40, 40, 40]],
    ['readC', 'AC', [40, 40], [40, 40]],
    ['readD', 'ACGT', [40, 40, 40, 40], [0, 0, 0, 40]]
  ]);
  const imp = importBatch(db, renderFastq(pairs.r1), renderFastq(pairs.r2, { eol: '\r\n' }));
  assert.equal(imp.recordCount, 4);

  const dropped = processBatch(db, imp.batchId, DEFAULT_PARAMS, 'discard_pair');
  assert.deepEqual(
    {
      paired: dropped.counts.paired,
      s1: dropped.counts.singletonR1,
      s2: dropped.counts.singletonR2,
      d: dropped.counts.dropped
    },
    { paired: 1, s1: 0, s2: 0, d: 3 }
  );
  assert.equal(
    dropped.counts.paired +
      dropped.counts.singletonR1 +
      dropped.counts.singletonR2 +
      dropped.counts.dropped,
    4
  );

  const keep = processBatch(db, imp.batchId, DEFAULT_PARAMS, 'keep_singletons');
  assert.deepEqual(
    {
      paired: keep.counts.paired,
      s1: keep.counts.singletonR1,
      s2: keep.counts.singletonR2,
      d: keep.counts.dropped
    },
    { paired: 1, s1: 1, s2: 1, d: 1 }
  );

  // 幂等：相同参数与策略返回同一个 run
  const keepAgain = processBatch(db, imp.batchId, DEFAULT_PARAMS, 'keep_singletons');
  assert.equal(keepAgain.runId, keep.runId);
  assert.equal(keepAgain.reused, true);

  // 查询一对原文与去向
  const pair1 = queryPair(db, keep.runId, { ordinal: 1 });
  assert.equal(pair1.fate, 'singleton_R2');
  assert.equal(pair1.r1.passed, false);
  assert.equal(pair1.r1.cut, 2);
  assert.equal(pair1.r1.original.sequence, 'ACGTNA');
  assert.equal(pair1.r2.kept?.sequence, 'ACGTNA');

  // 导出并核验
  const exp1 = exportRun(db, dataDir, keep.runId);
  const exp2 = exportRun(db, dataDir, keep.runId);
  for (let i = 0; i < exp1.files.length; i++) {
    assert.equal(exp1.files[i].sha256, exp2.files[i].sha256, '重复导出字节一致');
    const onDisk = fs.readFileSync(exp1.files[i].filePath);
    assert.equal(onDisk.length, exp1.files[i].byteSize);
  }

  const pR1 = fs.readFileSync(
    exp1.files.find((f) => f.kind === 'paired_R1')!.filePath,
    'utf8'
  );
  const pR2 = fs.readFileSync(
    exp1.files.find((f) => f.kind === 'paired_R2')!.filePath,
    'utf8'
  );
  const countRecs = (s: string) => (s.match(/^@/gm) ?? []).length;
  assert.equal(countRecs(pR1), 1);
  assert.equal(countRecs(pR2), 1);

  // 所有输出序列/质量等长且为原文前缀（抽查 singleton_R2：readA 全长）
  const sR2 = fs.readFileSync(
    exp1.files.find((f) => f.kind === 'singleton_R2')!.filePath,
    'utf8'
  );
  const lines = sR2.split('\n');
  assert.equal(lines[1].length, lines[3].length);
  assert.equal('ACGTNA'.startsWith(lines[1]), true);
  assert.equal(lines[1], 'ACGTNA');

  // 无后缀名称也作为配对键
  const pairsNoSuffix = matchingPair(
    [['x', 'ACGT', [40, 40, 40, 40], [40, 40, 40, 40]]],
    false
  );
  const imp2 = importBatch(db, renderFastq(pairsNoSuffix.r1), renderFastq(pairsNoSuffix.r2));
  assert.ok(imp2.batchId > 0);
});

test('超过记录数上限被拒绝', () => {
  const dir = makeTempDir();
  const { db } = freshDb(dir);
  process.env.FASTQ_MAX_RECORDS = '1';
  try {
    const text = renderFastq([
      { name: 'a/1', seq: 'ACGT', scores: [40, 40, 40, 40] },
      { name: 'b/1', seq: 'ACGT', scores: [40, 40, 40, 40] }
    ]);
    expectFail(() => importBatch(db, text, text), 'TOO_MANY_RECORDS');
  } finally {
    delete process.env.FASTQ_MAX_RECORDS;
  }
});

test('不存在的批次/运行返回 404 风格错误码', () => {
  const dir = makeTempDir();
  const { db } = freshDb(dir);
  expectFail(
    () => processBatch(db, 999, DEFAULT_PARAMS, 'keep_singletons'),
    'BATCH_NOT_FOUND'
  );
});

void path;
void qual;
