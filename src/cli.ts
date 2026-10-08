#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppDatabase } from './db.js';
import { exportRun, previewPair, queryPair } from './service.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { Strategy, TrimParams } from './types.js';

function usage(): never {
  console.error(`用法:
  fastq-trim preview (--r1 FILE --r2 FILE | --r1-text TEXT --r2-text TEXT)
  fastq-trim import (--r1 FILE --r2 FILE | --r1-text TEXT --r2-text TEXT) [--db data/app.sqlite]
  fastq-trim run --batch ID --strategy keep_singletons|discard_pair --params '{"windowSize":3,"qualityThreshold":20,"minLength":3,"maxNRatio":0.1}'
  fastq-trim pair --run ID (--ordinal N | --key KEY)
  fastq-trim export --run ID [--out data/exports]
`);
  process.exit(2);
}

function argsToMap(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) usage();
    map.set(key.slice(2), value);
  }
  return map;
}

function readRequired(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (!value) usage();
  return readFileSync(resolve(value), 'utf8');
}

function readSide(map: Map<string, string>, side: 'r1' | 'r2'): string {
  const textKey = `${side}-text`;
  if (map.has(textKey)) return map.get(textKey)!;
  return readRequired(map, side);
}

const [command, ...rawArgs] = process.argv.slice(2);
const args = argsToMap(rawArgs);
const dbPath = args.get('db') ?? 'data/app.sqlite';

try {
  if (command === 'preview') {
    const result = previewPair(readSide(args, 'r1'), readSide(args, 'r2'), DEFAULT_LIMITS);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const appDb = new AppDatabase(dbPath);
  try {
    if (command === 'import') {
      console.log(JSON.stringify(appDb.importPair(readSide(args, 'r1'), readSide(args, 'r2'), DEFAULT_LIMITS), null, 2));
    } else if (command === 'run') {
      const batchId = args.get('batch');
      const strategy = args.get('strategy');
      const paramsText = args.get('params');
      if (!batchId || !strategy || !paramsText) usage();
      if (strategy !== 'keep_singletons' && strategy !== 'discard_pair') usage();
      const params = JSON.parse(paramsText) as TrimParams;
      console.log(JSON.stringify(appDb.submitRun(batchId, params, strategy), null, 2));
    } else if (command === 'pair') {
      const runId = Number(args.get('run'));
      if (!Number.isInteger(runId)) usage();
      const ordinalText = args.get('ordinal');
      const pairKey = args.get('key');
      if ((ordinalText === undefined) === (pairKey === undefined)) usage();
      const selector: { ordinal?: number; pairKey?: string } = {};
      if (ordinalText !== undefined) selector.ordinal = Number(ordinalText);
      if (pairKey !== undefined) selector.pairKey = pairKey;
      console.log(JSON.stringify(queryPair(appDb, runId, selector), null, 2));
    } else if (command === 'export') {
      const runId = Number(args.get('run'));
      if (!Number.isInteger(runId)) usage();
      console.log(JSON.stringify(exportRun(appDb, runId, args.get('out') ?? 'data/exports'), null, 2));
    } else {
      usage();
    }
  } finally {
    appDb.close();
  }
} catch (error) {
  if ((error as { code?: string }).code === 'FASTQ_VALIDATION_FAILED') {
    console.error(JSON.stringify({ error: { code: 'FASTQ_VALIDATION_FAILED', details: (error as { issues?: unknown }).issues } }, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}
