import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, resetDatabaseInstance } from '../db/database.js';
import { importBatch } from '../services/import-service.js';
import { processBatch } from '../services/process-service.js';
import { exportRun } from '../services/export-service.js';

function q(scores: number[]): string {
  return scores.map((s) => String.fromCharCode(s + 33)).join('');
}

interface Rec {
  name: string;
  seq: string;
  qual: number[];
}

const r1Recs: Rec[] = [
  // 1: III!!! -> [40,40,40,0,0,0]，W=3 第一失败窗口起点 2，cut=2 < L=3 失败
  { name: 'readA/1', seq: 'ACGTNA', qual: [40, 40, 40, 0, 0, 0] },
  // 2: 无失败窗口，整条保留（含 1 个 N，比例 1/6 <= 0.5）
  { name: 'readB/1', seq: 'ACGTNA', qual: [40, 40, 40, 40, 40, 40] },
  // 3: 长度 2 < W=3，不滑窗；按 L=3 判断 -> 过短失败
  { name: 'readC/1', seq: 'AC', qual: [40, 40] },
  // 4: 窗口质量和恰好等于 W*T=60 -> 等于门槛通过
  { name: 'readD/1', seq: 'ACGT', qual: [20, 20, 20, 40] },
  // 5: cut=2，保留 2 个碱基里 1 个 N，N 比例 0.5 恰好上限 -> 通过
  { name: 'readE/1', seq: 'ANCC', qual: [40, 40, 0, 0] }
];

const r2Recs: Rec[] = [
  // 1: III!!! 配对侧 IIIIII -> 保持 6 碱基通过；策略决定是否孤儿
  { name: 'readA/2', seq: 'ACGTAC', qual: [40, 40, 40, 40, 40, 40] },
  // 2: R2 也通过 -> paired
  { name: 'readB/2', seq: 'ACGTAC', qual: [40, 40, 40, 40, 40, 40] },
  // 3: R2 失败（过短），R1 也失败 -> 整对丢弃
  { name: 'readC/2', seq: 'GT', qual: [40, 40] },
  // 4: R2 通过 -> paired
  { name: 'readD/2', seq: 'TGC A'.replace(' ', ''), qual: [40, 40, 40, 40] },
  // 5: R2 通过 -> 与 R1 成对
  { name: 'readE/2', seq: 'TTGG', qual: [40, 40, 40, 40] }
];

function render(recs: Rec[], side: 1 | 2, crlf = false): string {
  const eol = crlf ? '\r\n' : '\n';
  return (
    recs
      .map((r) => `@${r.name}${eol}${r.seq}${eol}+${r.name.replace(/\/[12]$/, side === 1 ? '/1' : '/2')}${eol}${q(r.qual)}`)
      .join(eol) + eol
  );
}

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastq-demo-'));
  const demoDir = path.join(process.cwd(), 'demo');
  fs.mkdirSync(demoDir, { recursive: true });
  const r1Path = path.join(demoDir, 'R1.fastq');
  const r2Path = path.join(demoDir, 'R2.fastq');
  // R2 使用 CRLF 演示对两种换行的兼容。
  fs.writeFileSync(r1Path, render(r1Recs, 1), 'utf8');
  fs.writeFileSync(r2Path, render(r2Recs, 2, true), 'utf8');

  resetDatabaseInstance();
  const db = openDatabase(dir);

  const imported = importBatch(db, fs.readFileSync(r1Path, 'utf8'), fs.readFileSync(r2Path, 'utf8'));
  console.log('导入:', JSON.stringify(imported, null, 2));

  const params = {
    windowSize: 3,
    qualityThreshold: 20,
    minLength: 3,
    maxNRatio: 0.5
  };

  for (const strategy of ['discard_pair', 'keep_singletons'] as const) {
    const run = processBatch(db, imported.batchId, params, strategy);
    console.log(`\n运行 (${strategy}):`, JSON.stringify(run.counts, null, 2));
    const out = exportRun(db, dir, run.runId);
    console.log('导出文件:');
    for (const f of out.files) console.log(`  ${f.kind}: ${f.filePath} (${f.byteSize} B, sha256=${f.sha256.slice(0, 12)}...)`);
  }
  console.log(`\n演示完成。数据库目录: ${dir}`);
  console.log(`示例 FASTQ: ${r1Path} 与 ${r2Path}`);
}

main();
