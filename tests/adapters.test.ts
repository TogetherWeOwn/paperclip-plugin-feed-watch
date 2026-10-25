import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@paperclipai/plugin-sdk';
import { createTransport } from '../src/adapters.ts';
import { parseConfig } from '../src/config.ts';
import { channel, video, atom } from './fixtures.ts';
const company = '11111111-1111-4111-8111-111111111111';
function config() { return parseConfig({ enabled: true, channelId: channel, researchAgentId: company, projectId: company,
  publishedAfter: '2026-10-24T00:00:00Z', workerUrl: 'https://worker.example', workerSecretRef: { type: 'secret_ref', secretId: company }, catalogUrl: 'https://catalog.example', youtubeApiKeyRef: { type: 'secret_ref', secretId: company } }); }
test('RSS uses populated /feeds endpoint; gap recovery paginates until exact known ID', async () => {
  let page = 0;
  const requests: string[] = [];
  const ctx = { state: { get: async () => null, set: async () => {} }, secrets: { resolve: async (_ref: unknown, options: any) => { assert.equal(options.configPath, 'youtubeApiKeyRef'); return 'test-api-key'; } }, http: { fetch: async (value: string, init: any) => {
    requests.push(value); const url = new URL(value);
    if (url.pathname === '/feeds/videos.xml') return new Response(atom());
    assert.equal(init.headers['x-goog-api-key'], 'test-api-key'); assert.ok(!url.searchParams.has('key'));
    if (url.pathname.endsWith('/channels')) return Response.json({ items: [{ id: channel, contentDetails: { relatedPlaylists: { uploads: 'uploads-fixture' } } }] });
    page++;
    const id = page === 1 ? 'dZgA6btnb_s' : video;
    if (page === 2) assert.equal(url.searchParams.get('pageToken'), 'page2');
    return Response.json({ items: [{ snippet: { title: 'test', publishedAt: '2026-10-25T10:00:00Z', resourceId: { videoId: id } }, contentDetails: { videoPublishedAt: '2026-10-25T10:00:00Z' } }], nextPageToken: page === 1 ? 'page2' : undefined });
  } } } as unknown as PluginContext;
  const io = createTransport(ctx, company, config());
  assert.equal((await io.rss())[0].videoId, video);
  assert.deepEqual((await io.recoverGap(video)).map(e => e.videoId), ['dZgA6btnb_s']);
  assert.equal(page, 2); assert.ok(requests.every(value => !value.includes('test-api-key')));
});
test('missing API key fails visibly rather than pretending RSS can recover arbitrary gaps', async () => {
  const c = config(); delete c.youtubeApiKeyRef;
  const io = createTransport({} as PluginContext, company, c);
  await assert.rejects(io.recoverGap(video), /gap-recovery-unconfigured/);
});
test('renewal is due at actual granted-lease boundary; pending verification never claims a healthy subscription', async () => {
  let subscribed = 0; const now = Date.now();
  const ctx = { state: { set: async () => {} }, secrets: { resolve: async () => 'test-secret' }, http: { fetch: async (value: string) => {
    if (value.endsWith('/status')) return Response.json({ lease: { renewAt: now - 1, expiresAt: now + 100_000 } });
    subscribed++; return Response.json({ pending: true }, { status: 202 });
  } } } as unknown as PluginContext;
  await createTransport(ctx, company, config()).maintenance(); assert.equal(subscribed, 1);
  ctx.http.fetch = async () => Response.json({ pending: { expiresAt: now + 10000 } });
  await assert.rejects(createTransport(ctx, company, config()).maintenance(), /websub-verification-pending/);
});
test('inbox pagination retains a durable rotating scan cursor so new hash keys behind old cursors are revisited', async () => {
  const states = new Map<string, any>(); let page = 0;
  const ctx = { state: { get: async (key: any) => states.get(key.stateKey) ?? null, set: async (key: any, value: any) => { states.set(key.stateKey, value); } }, secrets: { resolve: async () => 'test-secret' }, http: { fetch: async (value: string) => {
    page++; return Response.json({ events: [{ id: String(page).padStart(64, 'a'), companyId: company, channelId: channel, entries: [] }], cursor: page === 1 ? 'next-page' : undefined });
  } } } as unknown as PluginContext;
  const io = createTransport(ctx, company, config());
  assert.equal((await io.inbox()).length, 1); // One bounded page per native job.
  assert.equal((await io.inbox()).length, 1);
  assert.ok([...states.values()].includes(''));
});
