import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.ts';
import { createPlugin } from '../src/worker.ts';
import { signedHeaders, PLUGIN_PUSH_PATH } from '../src/crypto.ts';
import { atom, channel, video } from './fixtures.ts';
const companyId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const h = createTestHarness({ manifest });
  h.seed({ companies: [{ id: companyId, name: 'test', status: 'active' } as any], agents: [{ id: companyId, companyId, status: 'idle', name: 'researcher' } as any] });
  h.ctx.secrets.resolve = async () => 'test-only-key';
  h.ctx.http.fetch = async () => { throw new Error('unconfigured-external-request'); };
  return h;
}
const config = { enabled: true, webhookEnabled: true, channelId: channel, researchAgentId: companyId, projectId: companyId,
  publishedAfter: '2026-10-24T00:00:00Z', catalogUrl: 'https://catalog.example', workerUrl: 'https://worker.example',
  workerSecretRef: { type: 'secret_ref', secretId: companyId } };
test('real SDK harness: disabled default job has no external work and valid manifest schema', async () => {
  const h = fixture(); const plugin = createPlugin().definition; await plugin.setup(h.ctx);
  await h.runJob('poll'); assert.equal((await plugin.onHealth!()).status, 'ok');
  assert.deepEqual(await h.ctx.issues.list({ companyId }), []);
  assert.equal((await plugin.onValidateConfig!({})).ok, true);
  assert.equal((await plugin.onValidateConfig!({ enabled: true })).ok, false);
  assert.equal(manifest.jobs[0].schedule, '*/15 * * * *');
  assert.ok(!manifest.capabilities.some(cap => String(cap).includes('invoke') || String(cap).includes('sessions')));
});
test('real SDK harness: feed → full transcript documents → native assignment, then replay is a no-op', async () => {
  const h = fixture(); h.setConfig(config);
  const paths: string[] = [];
  h.ctx.http.fetch = async value => {
    const url = new URL(value); paths.push(url.pathname);
    if (url.pathname === '/feeds/videos.xml') return new Response(atom());
    if (url.pathname === '/status') return Response.json({ lease: { expiresAt: Date.now() + 100_000, renewAt: Date.now() + 50_000 } });
    if (url.pathname === '/inbox') return Response.json({ events: [] });
    if (url.pathname === '/transcript') return Response.json({ videoId: video, raw: '<timedtext><p>all text</p></timedtext>', segments: [{ startMs: 0, text: 'all text' }], language: 'en', source: 'youtube-captions', retrievedAt: new Date().toISOString() });
    throw new Error('unexpected-network');
  };
  let plugin = createPlugin().definition; await plugin.setup(h.ctx); await h.runJob('poll');
  const [issue] = await h.ctx.issues.list({ companyId });
  assert.equal(issue.status, 'todo'); assert.equal(issue.assigneeAgentId, companyId);
  assert.ok((await h.ctx.issues.documents.get(issue.id, 'plan', companyId))?.body.includes('UNTRUSTED SOURCE DATA'));
  assert.ok((await h.ctx.issues.documents.list(issue.id, companyId)).length >= 4);
  plugin = createPlugin().definition; await plugin.setup(h.ctx); await h.runJob('poll');
  assert.equal((await h.ctx.issues.list({ companyId })).length, 1);
  assert.equal(paths.filter(path => path === '/transcript').length, 1);
  assert.equal((await plugin.onHealth!()).status, 'ok');
});
test('real SDK harness: public webhook authenticates separate forwarding signature and rejects cross-channel payloads', async () => {
  const h = fixture(); h.setConfig(config); const plugin = createPlugin().definition; await plugin.setup(h.ctx);
  const payload = { companyId, channelId: channel, eventId: 'a'.repeat(64), entries: [{ videoId: video, channelId: channel, title: 'new', published: '2026-10-25T10:00:00Z', updated: '2026-10-25T10:00:00Z', url: `https://www.youtube.com/watch?v=${video}` }] };
  const input = async (body: any) => { const rawBody = JSON.stringify(body); return { endpointKey: 'youtube', rawBody, parsedBody: body, requestId: 'test', headers: await signedHeaders('test-only-key', 'POST', PLUGIN_PUSH_PATH, rawBody) }; };
  const valid = await input(payload); await plugin.onWebhook!(valid); await plugin.onWebhook!(valid);
  await assert.rejects(plugin.onWebhook!({ ...valid, rawBody: valid.rawBody + ' ' }));
  await assert.rejects(plugin.onWebhook!(await input({ ...payload, channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' })));
  assert.equal((await h.ctx.issues.list({ companyId })).length, 0); // Only the native job issues cards.
  const health = await plugin.onHealth!(); assert.equal(health.status, 'degraded'); // Not polled yet, no false success.
});
test('paused researcher is never resumed or assigned; prepared sources stay durable for recovery', async () => {
  const h = fixture(); h.setConfig(config); h.seed({ agents: [{ id: companyId, companyId, name: 'paused', status: 'paused' } as any] });
  h.ctx.http.fetch = async value => {
    const path = new URL(value).pathname;
    if (path === '/feeds/videos.xml') return new Response(atom());
    if (path === '/status') return Response.json({ lease: { expiresAt: Date.now() + 100_000, renewAt: Date.now() + 50_000 } });
    if (path === '/inbox') return Response.json({ events: [] });
    return Response.json({ videoId: video, raw: '<timedtext><p>text</p></timedtext>', segments: [{ startMs: 0, text: 'text' }], language: 'en', source: 'youtube-captions', retrievedAt: new Date().toISOString() });
  };
  const plugin = createPlugin().definition; await plugin.setup(h.ctx); await h.runJob('poll');
  const [issue] = await h.ctx.issues.list({ companyId });
  assert.equal(issue.status, 'backlog'); assert.equal(issue.assigneeAgentId, null);
  assert.ok(await h.ctx.issues.documents.get(issue.id, 'plan', companyId));
  assert.equal((await plugin.onHealth!()).status, 'degraded');
});
