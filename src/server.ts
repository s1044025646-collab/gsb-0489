import { createServer } from 'node:http';
import { AppDatabase } from './db.js';
import { createRequestHandler } from './api.js';

const portText = process.env.PORT ?? '0';
const port = Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT 必须是 0 到 65535 的整数；0 表示自动选择空闲端口');
}

const dbPath = process.env.DATABASE_PATH ?? 'data/app.sqlite';
const appDb = new AppDatabase(dbPath);
const handler = createRequestHandler(appDb);
const server = createServer((incoming, outgoing) => {
  const chunks: Buffer[] = [];
  incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
  incoming.on('end', () => {
    const body = Buffer.concat(chunks);
    const init: RequestInit = {
      method: incoming.method ?? 'GET',
      headers: incoming.headers as Record<string, string>
    };
    if (body.length > 0) init.body = body;
    const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? '/'}`, init);
    handler(request).then(async (response) => {
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    }).catch((error: Error) => {
      outgoing.statusCode = 500;
      outgoing.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: error.message } }));
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取监听地址');
  console.log(`FASTQ 服务已启动: http://127.0.0.1:${address.port}`);
  console.log(`SQLite: ${dbPath}`);
});

const shutdown = () => {
  server.close(() => {
    appDb.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
