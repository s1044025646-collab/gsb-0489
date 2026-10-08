import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase } from '../src/db.js';
import { exportRun } from '../src/service.js';
import { classifyPairs } from '../src/trim.js';
import { parsePair } from '../src/parser.js';
import { DEFAULT_LIMITS } from '../src/limits.js';

const dataDir = 'data/demo';
mkdirSync(dataDir, { recursive: true });
const r1 = [
  '@demo/1\r\nACGTNN\r\n+\r\nIII!!!\r\n',
  '@equal/1\nACGT\n+\n5555\n',
  '@short/1\nAC\n+\nII\n',
  '@nratio/1\nANAN\n+\nIIII\n'
].join('');
const r2 = [
  '@demo/2\r\nACGTAC\r\n+\r\nIIIIII\r\n',
  '@equal/2\nACGT\n+\n5555\n',
  '@short/2\nACGT\n+\nIIII\n',
  '@nratio/2\nANAN\n+\nIIII\n'
].join('');
writeFileSync(join(dataDir, 'R1.fastq'), r1, 'utf8');
writeFileSync(join(dataDir, 'R2.fastq'), r2, 'utf8');

const parsed = parsePair(readFileSync(join(dataDir, 'R1.fastq'), 'utf8'), readFileSync(join(dataDir, 'R2.fastq'), 'utf8'), DEFAULT_LIMITS);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));

const params = { windowSize: 3, qualityThreshold: 20, minLength: 3, maxNRatio: 0.5 };
const decisions = classifyPairs(parsed.pairs, params, 'keep_singletons').map((result) => ({
  pairKey: result.pairKey,
  category: result.category,
  r1Cut: result.r1.cutPosition,
  r2Cut: result.r2.cutPosition,
  r1Reasons: result.r1.reasons,
  r2Reasons: result.r2.reasons
}));

const appDb = new AppDatabase('data/demo/app.sqlite');
const batch = appDb.importPair(r1, r2, DEFAULT_LIMITS);
const keep = appDb.submitRun(batch.batchId, params, 'keep_singletons');
const discard = appDb.submitRun(batch.batchId, params, 'discard_pair');
const files = exportRun(appDb, keep.runId, 'data/demo/exports');
appDb.close();

console.log(JSON.stringify({ batch, decisions, keep, discard, files }, null, 2));

