#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, resetDatabaseInstance } from '../db/database.js';
import { defaultLimits } from '../core/limits.js';
import { importBatch } from '../services/import-service.js';
import { processBatch } from '../services/process-service.js';
import { queryPair } from '../services/query-service.js';
import { exportRun } from '../services/export-service.js';

interface Args {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const command = argv[0] ?? 'help';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        values.set(a.slice(2), next);
        i++;
      } else {
        flags.add(a.slice(2));
      }
    }
  }
  return { command, values, flags };
}

function required(args: Args, key: string): string {
  const v = args.values.get(key);
  if (v === undefined) {
    fail(`缺少必填参数 --${key}`);
  }
  return v!;
}

function fail(message: string, code = 'CLI_ERROR'): never {
  console.error(JSON.stringify({ ok: false, error: { code, message } }, null, 2));
  process.exit(1);
}

function dataDir(): string {
  return path.resolve(process.env.FASTQ_DATA_DIR ?? path.join(process.cwd(), 'data'));
}

const HELP = `FASTQ 双端滑窗质量裁剪与配对核验 CLI

用法:
  fastq-trim import --r1 <R1.fastq> --r2 <R2.fastq>
  fastq-trim process --batch <id> --W <窗口> --T <门槛> --L <最短长度> --n <N比例上限> --strategy <discard_pair|keep_singletons>
  fastq-trim pair --run <id> (--key <配对键> | --ordinal <序号>)
  fastq-trim export --run <id>
  fastq-trim help

选项:
  --data-dir <目录>   数据目录（默认 ./data，也可用 FASTQ_DATA_DIR）

示例:
  fastq-trim import --r1 demo/R1.fastq --r2 demo/R2.fastq
  fastq-trim process --batch 1 --W 3 --T 20 --L 3 --n 0.5 --strategy keep_singletons
  fastq-trim pair --run 1 --ordinal 1
  fastq-trim export --run 1
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.flags.has('help')) {
    process.stdout.write(HELP);
    return;
  }
  const customDir = args.values.get('data-dir');
  if (customDir) process.env.FASTQ_DATA_DIR = path.resolve(customDir);
  const dir = dataDir();
  resetDatabaseInstance();
  const db = openDatabase(dir);

  try {
    if (args.command === 'import') {
      const p1 = path.resolve(required(args, 'r1'));
      const p2 = path.resolve(required(args, 'r2'));
      if (!fs.existsSync(p1)) fail(`R1 文件不存在: ${p1}`, 'FILE_NOT_FOUND');
      if (!fs.existsSync(p2)) fail(`R2 文件不存在: ${p2}`, 'FILE_NOT_FOUND');
      const result = importBatch(
        db,
        fs.readFileSync(p1, 'utf8'),
        fs.readFileSync(p2, 'utf8'),
        defaultLimits()
      );
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }

    if (args.command === 'process') {
      const batchId = Number(required(args, 'batch'));
      const params = {
        windowSize: Number(required(args, 'W')),
        qualityThreshold: Number(required(args, 'T')),
        minLength: Number(required(args, 'L')),
        maxNRatio: Number(required(args, 'n'))
      };
      const strategy = required(args, 'strategy');
      const summary = processBatch(db, batchId, params, strategy);
      console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
      return;
    }

    if (args.command === 'pair') {
      const runId = Number(required(args, 'run'));
      const key = args.values.get('key');
      const ordinal = args.values.get('ordinal');
      if (key === undefined && ordinal === undefined) {
        fail('必须提供 --key 或 --ordinal');
      }
      const detail = queryPair(db, runId, {
        pairKey: key,
        ordinal: ordinal ? Number(ordinal) : undefined
      });
      console.log(JSON.stringify({ ok: true, pair: detail }, null, 2));
      return;
    }

    if (args.command === 'export') {
      const runId = Number(required(args, 'run'));
      const result = exportRun(db, dir, runId);
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }

    fail(`未知命令: ${args.command}。运行 fastq-trim help 查看用法。`, 'UNKNOWN_COMMAND');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    fail(e.message ?? '未知错误', e.code ?? 'INTERNAL_ERROR');
  }
}

main();
