import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderFastq, makeTempDir } from './lib/helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('HTTP API 全流程（导入→处理→查询→导出）', async (t) => {
  const dataDir = makeTempDir();
  const child = spawn(
    process.execPath,
    [path.join(root, 'dist', 'server', 'index.js'), '--port', '0'],
    {
      cwd: root,
      env: { ...process.env, FASTQ_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let baseUrl = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 15000);
    child.stdout.on('data', (chunk: Buffer) => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (m) {
        clearTimeout(timer);
        baseUrl = `http://127.0.0.1:${m[1]}`;
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`服务提前退出 code=${code}`)));
  });

  t.after(() => {
    child.kill();
  });

  try {
    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const r1 = renderFastq([
      { name: 'a/1', seq: 'ACGTNA', scores: [40, 40, 40, 0, 0, 0] },
      { name: 'b/1', seq: 'ACGTAC', scores: [40, 40, 40, 40, 40, 40] }
    ]);
    const r2 = renderFastq([
      { name: 'a/2', seq: 'ACGTAC', scores: [40, 40, 40, 40, 40, 40] },
      { name: 'b/2', seq: 'ACGTAC', scores: [40, 40, 40, 40, 40, 40] }
    ]);

    const imp = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ r1: { content: r1 }, r2: { content: r2 } })
    }).then((r) => r.json());
    assert.equal(imp.ok, true);
    assert.equal(imp.recordCount, 2);

    const run = await fetch(`${baseUrl}/api/batches/${imp.batchId}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: { windowSize: 3, qualityThreshold: 20, minLength: 3, maxNRatio: 0.5 },
        orphanStrategy: 'keep_singletons'
      })
    }).then((r) => r.json());
    assert.equal(run.ok, true);
    assert.equal(run.counts.singletonR2, 1);
    assert.equal(run.counts.paired, 1);

    const pair = await fetch(`${baseUrl}/api/runs/${run.runId}/pair?ordinal=1`).then((r) =>
      r.json()
    );
    assert.equal(pair.pair.fate, 'singleton_R2');

    const exported = await fetch(`${baseUrl}/api/runs/${run.runId}/export`, {
      method: 'POST'
    }).then((r) => r.json());
    assert.equal(exported.files.length, 5);
    const statsFile = exported.files.find((f: { kind: string }) => f.kind === 'stats');
    const stats = JSON.parse(fs.readFileSync(statsFile.filePath, 'utf8'));
    assert.equal(stats.consistency.categorySumEqualsInput, true);

    // 结构错误预览返回错误码且不崩溃
    const bad = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        r1: {
          content:
            '@x/1\nACGT\n+\nIIII\n@y/1\nACGT\n+\nIIII\n'
        },
        r2: { content: '@x/2\nACGT\n+\nIIII\n' }
      })
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.error.code, 'RECORD_COUNT_MISMATCH');

    // 未知路由
    assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
  } finally {
    child.kill();
  }
  void os;
});
