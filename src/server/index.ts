import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { URL } from 'node:url';
import { openDatabase } from '../db/database.js';
import { defaultLimits } from '../core/limits.js';
import { FastqError } from '../core/types.js';
import { importBatch } from '../services/import-service.js';
import {
  getRunSummary,
  listRuns,
  processBatch
} from '../services/process-service.js';
import { queryPair } from '../services/query-service.js';
import { exportRun, listExports } from '../services/export-service.js';

const DATA_DIR = path.resolve(process.env.FASTQ_DATA_DIR ?? path.join(process.cwd(), 'data'));
const MAX_BODY = Number(process.env.FASTQ_MAX_BODY ?? 100 * 1024 * 1024);

const db = openDatabase(DATA_DIR);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json)
  });
  res.end(json);
}

function errorBody(err: unknown): { status: number; body: unknown } {
  const e = err as { code?: string; message?: string };
  const status =
    e.code === 'NOT_FOUND' ||
    e.code === 'BATCH_NOT_FOUND' ||
    e.code === 'RUN_NOT_FOUND' ||
    e.code === 'PAIR_NOT_FOUND'
      ? 404
      : 400;
  return {
    status,
    body: {
      error: {
        code: e.code ?? 'INTERNAL_ERROR',
        message: e.message ?? '未知错误',
        record: (err as FastqError).record,
        line: (err as FastqError).line,
        column: (err as FastqError).column
      }
    }
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        const err = new Error(`请求体超过上限 ${MAX_BODY} 字节`) as Error & {
          code?: string;
        };
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('请求体不是合法 JSON') as Error & { code?: string };
    err.code = 'BAD_JSON';
    throw err;
  }
}

function resolveSideInput(side: 'r1' | 'r2', input: any): string {
  if (!input || typeof input !== 'object') {
    const err = new Error(`${side} 必须提供 content 或 path`) as Error & {
      code?: string;
    };
    err.code = 'INVALID_PARAMS';
    throw err;
  }
  if (typeof input.content === 'string') return input.content;
  if (typeof input.path === 'string') {
    const resolved = path.resolve(input.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      const err = new Error(`${side} 文件不存在: ${resolved}`) as Error & {
        code?: string;
      };
      err.code = 'FILE_NOT_FOUND';
      throw err;
    }
    return fs.readFileSync(resolved, 'utf8');
  }
  const err = new Error(`${side} 必须提供 content（文本）或 path（项目内文件）`) as Error & {
    code?: string;
  };
  err.code = 'INVALID_PARAMS';
  throw err;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health') {
      send(res, 200, { ok: true, dataDir: DATA_DIR });
      return;
    }

    if (route === 'POST /api/import/preview') {
      const body = await readJson(req);
      const c1 = resolveSideInput('r1', body.r1);
      const c2 = resolveSideInput('r2', body.r2);
      try {
        const result = importBatch(db, c1, c2, defaultLimits());
        send(res, 200, {
          ok: true,
          batchId: result.batchId,
          recordCount: result.recordCount,
          note: '结构校验通过；preview 与正式导入共用同一入口，相同内容重复提交幂等'
        });
      } catch (err) {
        const { status, body: eb } = errorBody(err);
        send(res, status, { ok: false, ...(eb as object) });
      }
      return;
    }

    if (route === 'POST /api/import') {
      const body = await readJson(req);
      const c1 = resolveSideInput('r1', body.r1);
      const c2 = resolveSideInput('r2', body.r2);
      const result = importBatch(db, c1, c2, defaultLimits());
      send(res, 200, { ok: true, ...result });
      return;
    }

    let m = /^\/api\/batches\/(\d+)\/process$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const body = await readJson(req);
      const summary = processBatch(
        db,
        Number(m[1]),
        body.params,
        body.orphanStrategy
      );
      send(res, 200, { ok: true, ...summary });
      return;
    }

    m = /^\/api\/batches\/(\d+)\/runs$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      send(res, 200, { ok: true, runs: listRuns(db, Number(m[1])) });
      return;
    }

    m = /^\/api\/runs\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      send(res, 200, { ok: true, ...getRunSummary(db, Number(m[1])) });
      return;
    }

    m = /^\/api\/runs\/(\d+)\/pair$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const ordinalRaw = url.searchParams.get('ordinal');
      const key = url.searchParams.get('key');
      const detail = queryPair(db, Number(m[1]), {
        pairKey: key ?? undefined,
        ordinal: ordinalRaw ? Number(ordinalRaw) : undefined
      });
      send(res, 200, { ok: true, pair: detail });
      return;
    }

    m = /^\/api\/runs\/(\d+)\/export$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const { files, stats } = exportRun(db, DATA_DIR, Number(m[1]));
      send(res, 200, { ok: true, files, stats });
      return;
    }

    m = /^\/api\/runs\/(\d+)\/exports$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      send(res, 200, { ok: true, files: listExports(db, Number(m[1])) });
      return;
    }

    send(res, 404, {
      error: { code: 'ROUTE_NOT_FOUND', message: `未知路由: ${route}` }
    });
  } catch (err) {
    const { status, body } = errorBody(err);
    send(res, status, body);
  }
});

/** 返回一个空闲端口（传 0 由操作系统分配）。 */
export async function pickFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', reject);
    tester.listen(preferred ?? 0, '127.0.0.1', () => {
      const addr = tester.address();
      tester.close(() =>
        resolve(typeof addr === 'object' && addr ? addr.port : (preferred ?? 0))
      );
    });
  });
}

function parseCliPort(): number | undefined {
  const i = process.argv.indexOf('--port');
  if (i !== -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return undefined;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (isMain) {
  const preferred = parseCliPort();
  pickFreePort(preferred)
    .then((port) => {
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        const actual = typeof addr === 'object' && addr ? addr.port : port;
        console.log(`FASTQ 双端裁剪服务已启动: http://127.0.0.1:${actual}`);
        console.log(`数据目录: ${DATA_DIR}`);
      });
    })
    .catch((err) => {
      console.error('启动失败:', err);
      process.exit(1);
    });
}

export { server, db, DATA_DIR };
