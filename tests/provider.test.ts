import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { createProvider } from '../provider/provider.ts';
import { signedHeaders } from '../src/crypto.ts';
import { channel, video } from './fixtures.ts';
const secret = 'test-only-provider-secret-at-least-32-characters';
const raw = '<transcript><text start="1.5">Hello &amp; welcome</text></transcript>';
const player = (channelId = channel) => Response.json({ videoDetails: { channelId }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=test&tlang=fr', languageCode: 'en' }] } } });
async function fixture(t: { after: (fn: () => Promise<void>) => void }, upstream?: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'feed-watch-provider-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  let now = Date.parse('2026-10-25T12:00:00Z');
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (upstream) return upstream(input, init);
    return String(input).includes('/player?') ? player() : new Response(raw);
  };
  const options = { secret, channelId: channel, proxyUrl: 'http://proxy.example:8888', stateFile: file, fetcher, clock: () => now };
  const provider = await createProvider(options);
  t.after(() => provider.close());
  const call = async (value = { videoId: video, channelId: channel }, path = '/transcript', offset = 0) => {
    const body = JSON.stringify(value);
    return provider.handle(new Request(`https://provider.example${path}`, { method: 'POST', body, headers: await signedHeaders(secret, 'POST', path, body, now + offset) }));
  };
  return { provider, call, calls, file, options, advance: (ms: number) => { now += ms; } };
}
test('provider rejects unsigned, expired, tampered and route-mismatched signatures without egress', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.handle(new Request('https://provider.example/transcript', { method: 'POST', body: '{}' }))).status, 401);
  assert.equal((await f.call(undefined, undefined, -301_000)).status, 401);
  const body = JSON.stringify({ videoId: video, channelId: channel });
  for (const [path, payload] of [['/other', body], ['/transcript', '{}']]) {
    const headers = await signedHeaders(secret, 'POST', path, body, f.options.clock());
    assert.equal((await f.provider.handle(new Request('https://provider.example/transcript', { method: 'POST', headers, body: payload }))).status, 401);
  }
  assert.equal(f.calls.length, 0);
});
test('provider permits only health and signed transcript for the configured channel', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.provider.handle(new Request('https://provider.example/healthz'))).json(), { ok: true });
  assert.equal((await f.call({ videoId: video, channelId: 'UC' + 'x'.repeat(22) })).status, 400);
  assert.equal((await f.call({ videoId: '../escape!', channelId: channel })).status, 400);
  assert.equal((await f.call(undefined, '/transcript?extra=1')).status, 404);
  assert.equal(f.calls.length, 0);
});
test('provider returns the plugin transcript contract and proxies both requests without translation', async t => {
  const f = await fixture(t);
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { videoId: video, language: 'en', source: 'youtube-captions', retrievedAt: '2026-10-25T12:00:00.000Z', raw, segments: [{ startMs: 1500, text: 'Hello & welcome' }] });
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) assert.ok((call.init as RequestInit & { dispatcher: unknown }).dispatcher instanceof ProxyAgent);
  assert.equal(new URL(f.calls[1].url).searchParams.has('tlang'), false);
  assert.equal(f.calls[0].init?.redirect, 'error');
  assert.equal(f.calls[1].init?.redirect, 'error');
});
test('provider enforces the full 60-second spacing boundary across restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.call()).status, 200);
  f.advance(59_999);
  assert.equal((await f.call()).status, 429);
  const other = await createProvider(f.options); t.after(() => other.close());
  const body = JSON.stringify({ videoId: video, channelId: channel });
  const call = async () => other.handle(new Request('https://provider.example/transcript', { method: 'POST', body, headers: await signedHeaders(secret, 'POST', '/transcript', body, f.options.clock()) }));
  assert.equal((await call()).status, 429);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).count, 1);
  f.advance(1);
  assert.equal((await call()).status, 200);
  assert.equal(f.calls.length, 4);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).last, f.options.clock());
});
test('provider rejects concurrent acquisition even after the spacing interval expires', async t => {
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let firstFetch = true;
  const f = await fixture(t, async input => {
    if (firstFetch) { firstFetch = false; enter(); return pending; }
    return String(input).includes('/player?') ? player() : new Response(raw);
  });
  const first = f.call();
  let response: Response;
  try {
    await entered;
    f.advance(60_000);
    assert.equal((await f.call()).status, 429);
    assert.equal(f.calls.length, 1);
  } finally { release(player()); response = await first; }
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).count, 1);
});
test('provider persists six-hour cooldown on upstream 403 and 429', async t => {
  for (const status of [403, 429]) {
    const f = await fixture(t, async () => new Response('', { status }));
    assert.equal((await f.call()).status, 502);
    f.advance(60_000); assert.equal((await f.call()).status, 429);
    assert.equal(f.calls.length, 1);
    const state = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(state.blockedUntil, Date.parse('2026-10-25T18:00:00Z'));
  }
});
test('provider persists six-hour cooldown despite errored 403 and 429 bodies, including restart', async t => {
  for (const status of [403, 429]) for (const phase of ['player', 'captions']) {
    await t.test(`${status} at ${phase}`, async t => {
      let blocked = true;
      const f = await fixture(t, async input => {
        const isPlayer = String(input).includes('/player?');
        if (blocked && isPlayer === (phase === 'player')) {
          return new Response(new ReadableStream({ start(controller) { controller.error(new Error('upstream-body-failed')); } }), { status });
        }
        return isPlayer ? player() : new Response(raw);
      });
      assert.equal((await f.call()).status, 502);
      const blockedUntil = Date.parse('2026-10-25T18:00:00Z');
      assert.equal(JSON.parse(await readFile(f.file, 'utf8')).blockedUntil, blockedUntil);
      const calls = f.calls.length;
      blocked = false;
      const other = await createProvider(f.options); t.after(() => other.close());
      const body = JSON.stringify({ videoId: video, channelId: channel });
      const call = async () => other.handle(new Request('https://provider.example/transcript', { method: 'POST', body, headers: await signedHeaders(secret, 'POST', '/transcript', body, f.options.clock()) }));
      f.advance(60_000);
      assert.equal((await call()).status, 429);
      f.advance(21_540_000 - 1);
      assert.equal((await call()).status, 429);
      assert.equal(f.calls.length, calls);
      f.advance(1);
      assert.equal((await call()).status, 200);
      assert.equal(f.calls.length, calls + 2);
    });
  }
});
test('provider saves cooldown before best-effort cancellation without masking storage failure', async t => {
  for (const storageFails of [false, true]) {
    let blockedAtCancel = 0;
    const f = await fixture(t, async () => {
      if (storageFails) await rm(dirname(f.file), { recursive: true });
      return new Response(new ReadableStream({
        async cancel() {
          if (!storageFails) blockedAtCancel = JSON.parse(await readFile(f.file, 'utf8')).blockedUntil;
          throw new Error('cancel-failed');
        },
      }), { status: 403 });
    });
    const response = await f.call();
    assert.equal(response.status, storageFails ? 503 : 502);
    assert.deepEqual(await response.json(), { error: storageFails ? 'state-unavailable' : 'upstream-unavailable' });
    if (!storageFails) assert.equal(blockedAtCancel, Date.parse('2026-10-25T18:00:00Z'));
  }
});
test('provider fails closed before egress when request-time storage fails, even after repair', async t => {
  const f = await fixture(t);
  await rm(dirname(f.file), { recursive: true });
  const response = await f.call();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'state-unavailable' });
  assert.equal(f.calls.length, 0);
  await mkdir(dirname(f.file));
  f.advance(60_000);
  assert.equal((await f.call()).status, 503);
  assert.equal(f.calls.length, 0);
  const restarted = await createProvider(f.options); t.after(() => restarted.close());
  const body = JSON.stringify({ videoId: video, channelId: channel });
  assert.equal((await restarted.handle(new Request('https://provider.example/transcript', { method: 'POST', body, headers: await signedHeaders(secret, 'POST', '/transcript', body, f.options.clock()) }))).status, 200);
});
test('provider enforces daily budget, rolls over UTC day, and fails closed on corrupt state', async t => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ day: '2026-10-25', count: 96, last: 0, blockedUntil: 0 }));
  const full = await createProvider(f.options); t.after(() => full.close());
  const body = JSON.stringify({ videoId: video, channelId: channel });
  const call = async () => full.handle(new Request('https://provider.example/transcript', { method: 'POST', body, headers: await signedHeaders(secret, 'POST', '/transcript', body, f.options.clock()) }));
  assert.equal((await call()).status, 429);
  f.advance(86_400_000); assert.equal((await call()).status, 200);
  await writeFile(f.file, '{broken');
  await assert.rejects(createProvider(f.options));
});
test('provider rejects caption URLs outside the fixed YouTube endpoint', async t => {
  for (const baseUrl of ['https://attacker.example/api/timedtext', 'http://www.youtube.com/api/timedtext', 'https://www.youtube.com:8443/api/timedtext', 'https://www.youtube.com/redirect', 'https://user:pass@www.youtube.com/api/timedtext']) {
    const f = await fixture(t, async () => Response.json({ videoDetails: { channelId: channel }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl, languageCode: 'en' }] } } }));
    assert.equal((await f.call()).status, 502);
    assert.equal(f.calls.length, 1);
  }
});
test('provider rejects wrong-channel players even with otherwise valid captions', async t => {
  for (const playerChannel of ['UC' + 'x'.repeat(22), channel]) {
    const f = await fixture(t, async input => String(input).includes('/player?') ? player(playerChannel) : new Response(raw));
    const response = await f.call();
    assert.equal(response.status, playerChannel === channel ? 200 : 502);
    assert.equal(f.calls.length, playerChannel === channel ? 2 : 1);
    if (playerChannel === channel) assert.equal((await response.json()).raw, raw);
  }
});
test('provider refuses invalid captions, oversized bodies, and unknown request fields', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.handle(new Request('https://provider.example/transcript', { method: 'POST', body: 'x'.repeat(32769) }))).status, 413);
  const body = JSON.stringify({ videoId: video, channelId: channel, arbitraryUrl: 'https://attacker.example' });
  assert.equal((await f.provider.handle(new Request('https://provider.example/transcript', { method: 'POST', body, headers: await signedHeaders(secret, 'POST', '/transcript', body, f.options.clock()) }))).status, 400);
  assert.equal(f.calls.length, 0);
  const invalid = await fixture(t, async input => String(input).includes('/player?') ? Response.json({ videoDetails: { channelId: channel }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext', languageCode: 'en' }] } } }) : new Response('{"events":[]}'));
  assert.equal((await invalid.call()).status, 502);
});
test('provider timeout aborts stalled upstream headers and bodies and releases the busy slot', async t => {
  for (const phase of ['player', 'captions']) for (const stall of ['headers', 'body']) {
    await t.test(`${phase} ${stall}`, async t => {
      const { createServer } = await import('node:http');
      const timeout = AbortSignal.timeout;
      t.mock.method(AbortSignal, 'timeout', (ms: number) => {
        assert.equal(ms, 20_000);
        return timeout(100);
      });
      let hanging = true;
      let stalled = false;
      const upstream = createServer((req, res) => {
        req.resume();
        const isPlayer = req.url === '/player';
        if (hanging && isPlayer === (phase === 'player')) {
          stalled = true;
          if (stall === 'body') { res.writeHead(200); res.write(isPlayer ? '{' : '<transcript>'); }
          return;
        }
        res.end(isPlayer ? JSON.stringify({ videoDetails: { channelId: channel }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext', languageCode: 'en' }] } } }) : raw);
      });
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
      const address = upstream.address() as import('node:net').AddressInfo;
      const f = await fixture(t, async (input, init) => {
        const path = String(input).includes('/player?') ? '/player' : '/captions';
        return undiciFetch(`http://127.0.0.1:${address.port}${path}`, { ...init, dispatcher: undefined } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
      });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          f.call(),
          new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('upstream timeout did not abort the request')), 2000); }),
        ]);
        assert.equal(response.status, 502);
        assert.equal(stalled, true);
        assert.equal(f.calls.length, phase === 'player' ? 1 : 2);
        assert.equal(f.calls.at(-1)?.init?.signal?.aborted, true);
      } finally { clearTimeout(watchdog); }
      hanging = false;
      f.advance(60_000);
      assert.equal((await f.call()).status, 200);
    });
  }
});
test('real HTTP transport sends player CONNECT through configured proxy and never falls back', async t => {
  const { createServer } = await import('node:http');
  const proxy = createServer();
  let target = '';
  proxy.on('connect', (req, socket) => { target = req.url ?? ''; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const f = await fixture(t);
  const address = proxy.address() as import('node:net').AddressInfo;
  const actual = await createProvider({ ...f.options, proxyUrl: `http://127.0.0.1:${address.port}`, fetcher: undefined });
  t.after(() => actual.close());
  const body = JSON.stringify({ videoId: video, channelId: channel });
  const result = await actual.handle(new Request('https://provider.example/transcript', { method: 'POST', body, headers: await signedHeaders(secret, 'POST', '/transcript', body, f.options.clock()) }));
  assert.equal(result.status, 502);
  assert.equal(target, 'www.youtube.com:443');
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).count, 1);
});
