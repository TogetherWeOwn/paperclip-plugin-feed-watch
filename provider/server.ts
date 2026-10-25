import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createProvider } from './provider.ts';

try {
  const provider = await createProvider({ secret: process.env.SHARED_SECRET ?? '', channelId: process.env.CHANNEL_ID ?? '',
    proxyUrl: process.env.YOUTUBE_PROXY_URL ?? '', stateFile: '/data/state.json' });
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, async (req, res) => {
    try {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const method = req.method ?? 'GET';
      const init: RequestInit & { duplex: 'half' } = { method, headers, duplex: 'half' };
      if (method !== 'GET' && method !== 'HEAD') init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      const response = await provider.handle(new Request(new URL(req.url ?? '/', 'http://provider'), init));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500, { 'cache-control': 'no-store' }); res.end(); }
  });
  server.maxConnections = 32;
  server.keepAliveTimeout = 5000;
  server.listen(8080, '0.0.0.0', () => console.log('provider-ready'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => { void provider.close().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 25_000).unref();
  });
} catch { console.error('provider-start-failed'); process.exitCode = 1; }
