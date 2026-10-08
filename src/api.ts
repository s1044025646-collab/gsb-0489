import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import { AppError } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';
import { AppDatabase } from './db.js';
import { exportRun, previewPair, queryPair } from './service.js';
import type { Strategy, TrimParams } from './types.js';

interface BodyPayload {
  r1Text?: string;
  r2Text?: string;
  r1Path?: string;
  r2Path?: string;
  params?: TrimParams;
  strategy?: Strategy;
  ordinal?: number;
  pairKey?: string;
  outputDir?: string;
}

function readProjectFile(pathText: string, side: 'R1' | 'R2'): string {
  if (typeof pathText !== 'string' || pathText.length === 0) {
    throw new AppError('INVALID_FILE_PATH', `${side} 路径无效`);
  }
  const root = process.cwd();
  const absolute = isAbsolute(pathText) ? pathText : resolve(root, pathText);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new AppError('PATH_OUTSIDE_PROJECT', 'API 仅允许读取项目目录内文件');
  }
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    throw new AppError('FILE_READ_FAILED', `无法读取 ${side} 文件：${pathText}`);
  }
}

function readInputs(body: BodyPayload): { r1: string; r2: string } {
  const r1 = typeof body.r1Text === 'string' ? body.r1Text : body.r1Path ? readProjectFile(body.r1Path, 'R1') : undefined;
  const r2 = typeof body.r2Text === 'string' ? body.r2Text : body.r2Path ? readProjectFile(body.r2Path, 'R2') : undefined;
  if (r1 === undefined || r2 === undefined) {
    throw new AppError('MISSING_FASTQ_INPUT', '必须同时提供 R1/R2 的 text 或 path');
  }
  return { r1: r1, r2: r2 };
}

export function createRequestHandler(appDb: AppDatabase) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true });
      }

      let body: BodyPatchOrBody = {};
      if (request.method !== 'GET') {
        body = await request.json() as BodyPayload;
      }

      if (request.method === 'POST' && url.pathname === '/preview') {
        const { r1, r2 } = readInputs(body);
        return Response.json(previewPair(r1, r2, DEFAULT_LIMITS));
      }
      if (request.method === 'POST' && url.pathname === '/batches') {
        const { r1, r2 } = readInputs(body);
        const preview = previewPair(r1, r2, DEFAULT_LIMITS);
        if (!preview.ok) {
          return Response.json({ error: { code: 'FASTQ_VALIDATION_FAILED', details: preview.issues } }, { status: 422 });
        }
        return Response.json(appDb.importPair(r1, r2, DEFAULT_LIMITS), { status: 201 });
      }

      const runMatch = /^\/batches\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === 'POST' && runMatch) {
        if (!body.params || !body.strategy) throw new AppError('MISSING_RUN_CONFIG', '必须提供 params 和 strategy');
        const result = appDb.submitRun(decodeURIComponent(runMatch[1]!), body.params, body.strategy);
        return Response.json(result, { status: 201 });
      }

      const queryMatch = /^\/runs\/(\d+)\/pairs(?:\/(.+))?$/.exec(url.pathname);
      if (request.method === 'GET' && queryMatch) {
        const runId = Number(queryMatch[1]);
        const key = queryMatch[2] ? decodeURIComponent(queryMatch[2]) : body.pairKey;
        const ordinal = url.searchParams.get('ordinal') ? Number(url.searchParams.get('ordinal')) : body.ordinal;
        const selector: { ordinal?: number; pairKey?: string } = {};
        if (ordinal !== undefined) selector.ordinal = ordinal;
        if (key !== undefined) selector.pairKey = key;
        return Response.json(queryPair(appDb, runId, selector));
      }

      const exportMatch = /^\/runs\/(\d+)\/export$/.exec(url.pathname);
      if (request.method === 'POST' && exportMatch) {
        return Response.json(exportRun(appDb, Number(exportMatch[1]), body.outputDir ?? 'data/exports'));
      }

      throw new AppError('NOT_FOUND', '接口不存在');
    } catch (error) {
      if (error instanceof AppError) {
        return Response.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: 400 });
      }
      const code = (error as { code?: string }).code;
      if (code === 'FASTQ_VALIDATION_FAILED') {
        return Response.json({ error: { code, details: (error as { issues?: unknown }).issues } }, { status: 422 });
      }
      if (code === 'BATCH_NOT_FOUND' || code === 'RUN_NOT_FOUND') {
        return Response.json({ error: { code, message: (error as Error).message } }, { status: 404 });
      }
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } }, { status: 500 });
    }
  };
}

type BodyPatchOrBody = BodyPayload;
