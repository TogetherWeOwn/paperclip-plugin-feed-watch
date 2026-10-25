import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KVNamespace } from '@cloudflare/workers-types';
import { handleRequest, type Env } from '../cloudflare/worker.ts';
import { signedHeaders, sign } from '../src/crypto.ts';
import { atom, channel, video } from './fixtures.ts';
const now = Date.parse('2026-10-25T12:00:00Z');
const secret = 'a-test-only-internal-key-of-at-least-32-characters';
function fixture() {
  const values = new Map<string, string>();
  const env: Env = { ENABLED: 'true', CHANNEL_ID: channel, COMPANY_ID: '11111111-1111-4111-8111-111111111111',
    CALLBACK_URL: 'https://worker.example/websub', SHARED_SECRET: secret, HUB_SECRET: 'hub-test-only-key-with-at-least-32-characters',
    INBOX: { get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); },
      list: async (options: any) => ({ keys: [...values.keys()].filter(key => key.startsWith(options.prefix)).map(name => ({ name })), list_complete: true, cursor: '' }),
    } as unknown as KVNamespace };
  const call = async (path: string, method = 'GET', value?: any, fetcher: typeof fetch = async () => { throw new Error('unexpected-network'); }) => {
    const body = value === undefined ? '' : JSON.stringify(value);
    const headers = await signedHeaders(secret, method, path, body, now);
    return handleRequest(new Request(`https://worker.example${path}`, { method, headers, body: body || undefined }), env, fetcher, () => now);
  };
  return { values, env, call };
}
test('Worker is disabled by default, never subscribes/fetches without explicit enablement', async () => {
  const f = fixture(); delete f.env.ENABLED;
  assert.equal((await f.call('/status')).status, 503); assert.equal(f.values.size, 0);
});
test('verification requires outstanding topic/mode; records granted lease and reflects only exact challenge', async () => {
  const f = fixture(); const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel}`;
  let callback = `/websub?${new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.topic': topic, 'hub.challenge': 'challenge-123', 'hub.lease_seconds': '3600' })}`;
  const request = () => new Request(`https://worker.example${callback}`);
  assert.equal((await handleRequest(request(), f.env, fetch, () => now)).status, 404);
  const sub = await f.call('/subscription', 'POST', {}, async (url, init) => {
    assert.equal(String(url), 'https://pubsubhubbub.appspot.com/subscribe');
    assert.equal(new URLSearchParams(String(init?.body)).get('hub.secret'), f.env.HUB_SECRET);
    const subscribed = new URL(new URLSearchParams(String(init?.body)).get('hub.callback')!);
    callback += `&verify=${subscribed.searchParams.get('verify')}`;
    return new Response('', { status: 202 });
  });
  assert.equal(sub.status, 202);
  const verified = await handleRequest(request(), f.env, fetch, () => now);
  assert.equal(verified.status, 200); assert.equal(await verified.text(), 'challenge-123');
  const status = await (await f.call('/status')).json() as any;
  assert.equal(status.lease.leaseSeconds, 3600); assert.equal(status.lease.renewAt, now + 3600 * 800);
  assert.equal((await handleRequest(request(), f.env, fetch, () => now)).status, 404);
});
test('signed notification is durable before success, inbox duplicates are idempotent, ack removes only accepted event', async () => {
  const f = fixture(); const body = atom();
  const request = async () => new Request('https://worker.example/websub', { method: 'POST', body, headers: { 'x-hub-signature': await sign(f.env.HUB_SECRET!, body, 'SHA-1') } });
  assert.equal((await handleRequest(await request(), f.env, fetch, () => now)).status, 202);
  assert.equal((await handleRequest(await request(), f.env, fetch, () => now)).status, 202);
  const inbox = await (await f.call('/inbox')).json() as any;
  assert.equal(inbox.events.length, 1); assert.equal(inbox.events[0].entries[0].videoId, video);
  assert.equal((await f.call('/ack', 'POST', { id: inbox.events[0].id })).status, 200);
  assert.equal(((await (await f.call('/inbox')).json()) as any).events.length, 0);
});
test('tampered notification, wrong channel and unauthenticated internal calls never enter inbox', async () => {
  const f = fixture();
  for (const body of [atom() + ' ', atom([video], 'UCaaaaaaaaaaaaaaaaaaaaaa')]) {
    const original = atom();
    const request = new Request('https://worker.example/websub', { method: 'POST', body, headers: { 'x-hub-signature': await sign(f.env.HUB_SECRET!, original) } });
    assert.notEqual((await handleRequest(request, f.env, fetch, () => now)).status, 202);
  }
  assert.equal((await handleRequest(new Request('https://worker.example/inbox'), f.env, fetch, () => now)).status, 401);
  assert.equal(f.values.size, 0);
});
test('Worker transcript path authenticates, verifies channel, preserves full raw source and prefers manual English', async () => {
  const f = fixture(); let calls = 0;
  const raw = '<timedtext><body><p t="1234"><s>all content</s></p></body></timedtext>';
  const response = await f.call('/transcript', 'POST', { videoId: video, channelId: channel }, async (url, init) => {
    calls++;
    if (calls === 1) { assert.ok(String(url).includes('/youtubei/v1/player')); return Response.json({ videoDetails: { channelId: channel }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?kind=asr' },
      { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?kind=manual' },
    ] } } }); }
    assert.ok(String(url).includes('kind=manual')); assert.equal(init?.redirect, 'manual');
    return new Response(raw);
  });
  assert.equal(response.status, 200);
  const transcript = await response.json() as any;
  assert.equal(transcript.raw, raw); assert.equal(transcript.segments[0].startMs, 1234);
  assert.equal(transcript.language, 'en'); assert.ok(!JSON.stringify(transcript).includes('baseUrl'));
});
test('poisoned signed caption URL cannot SSRF; bot walls and missing captions remain retryable', async () => {
  for (const baseUrl of ['http://127.0.0.1/secret', 'https://evil.example/api/timedtext', 'https://www.youtube.com.evil.example/api/timedtext']) {
    const f = fixture(); let calls = 0;
    const response = await f.call('/transcript', 'POST', { videoId: video, channelId: channel }, async () => { calls++; return Response.json({ videoDetails: { channelId: channel }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl }] } } }); });
    assert.equal(response.status, 503); assert.equal(calls, 1);
  }
  const f = fixture(); const response = await f.call('/transcript', 'POST', { videoId: video, channelId: channel }, async () => Response.json({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }));
  assert.equal(response.status, 503);
});
test('failed push leaves notification durable and uses a separate purpose-bound internal signature', async () => {
  const f = fixture(); f.env.PLUGIN_WEBHOOK_URL = 'https://paperclip.example/api/plugins/test/webhooks/youtube';
  const request = new Request('https://worker.example/websub', { method: 'POST', body: atom(), headers: { 'x-hub-signature': await sign(f.env.HUB_SECRET!, atom()) } });
  let pushed = false;
  const response = await handleRequest(request, f.env, async (_url, init) => {
    pushed = true; assert.ok(String((init?.headers as any)['x-feed-signature']).startsWith('sha256='));
    assert.ok(!JSON.stringify(init?.headers).includes(f.env.HUB_SECRET!));
    return new Response('', { status: 502 });
  }, () => now);
  assert.equal(response.status, 202); assert.equal(pushed, true);
  assert.equal(((await (await f.call('/inbox')).json()) as any).events.length, 1);
});
test('wrong-channel XML with a VALID hub signature is rejected (signature is not authorization)', async () => {
  const f = fixture(); const body = atom([video], 'UCaaaaaaaaaaaaaaaaaaaaaa');
  const response = await handleRequest(new Request('https://worker.example/websub', { method: 'POST', body, headers: { 'x-hub-signature': await sign(f.env.HUB_SECRET!, body) } }), f.env, fetch, () => now);
  assert.equal(response.status, 503); assert.equal(f.values.size, 0);
});
test('rate-limit response persists a six-hour caption cooldown across Worker invocations', async () => {
  const f = fixture(); let calls = 0;
  const failed = await f.call('/transcript', 'POST', { videoId: video, channelId: channel }, async () => { calls++; return new Response('', { status: 429 }); });
  assert.equal(failed.status, 503);
  const second = await f.call('/transcript', 'POST', { videoId: video, channelId: channel }, async () => { calls++; return new Response(''); });
  assert.equal(second.status, 503); assert.equal(calls, 1);
});
test('hub and internal forwarding keys must be distinct', async () => {
  const f = fixture(); f.env.HUB_SECRET = secret;
  assert.equal((await f.call('/status')).status, 503);
});
test('offline Worker → actual SDK hook: acknowledge only after signed durable native intake', async () => {
  const { createTestHarness } = await import('@paperclipai/plugin-sdk/testing');
  const { createPlugin } = await import('../src/worker.ts');
  const { default: manifest } = await import('../src/manifest.ts');
  const f = fixture(); const companyId = f.env.COMPANY_ID;
  f.env.PLUGIN_WEBHOOK_URL = 'https://paperclip.example/api/plugins/test/webhooks/youtube';
  const h = createTestHarness({ manifest, config: { enabled: true, webhookEnabled: true, channelId: channel,
    projectId: companyId, researchAgentId: companyId, publishedAfter: '2026-10-24T00:00:00Z',
    workerUrl: 'https://worker.example', workerSecretRef: { type: 'secret_ref', secretId: companyId }, catalogUrl: 'https://catalog.example' } });
  h.ctx.secrets.resolve = async () => secret;
  const plugin = createPlugin().definition; await plugin.setup(h.ctx);
  const body = atom();
  const response = await handleRequest(new Request('https://worker.example/websub', { method: 'POST', body,
    headers: { 'x-hub-signature': await sign(f.env.HUB_SECRET!, body, 'SHA-1') } }), f.env, async (_url, init) => {
      await plugin.onWebhook!({ endpointKey: 'youtube', requestId: 'integration', rawBody: String(init?.body), headers: init?.headers as Record<string, string> });
      return Response.json({ status: 'success' });
    });
  assert.equal(response.status, 202);
  assert.ok((h.getState({ scopeKind: 'company', scopeId: companyId, namespace: manifest.id, stateKey: `${channel}:channel` }) as any).videos[video]);
  assert.equal(((await (await f.call('/inbox')).json()) as any).events.length, 0);
  assert.equal((await h.ctx.issues.list({ companyId })).length, 0); // Receipt alone never wakes a research agent.
});

test('an unauthenticated verification GET cannot consume outstanding subscription intent', async () => {
  const f = fixture();
  let callback = '';
  await f.call('/subscription', 'POST', {}, async (_url, init) => {
    callback = new URLSearchParams(String(init?.body)).get('hub.callback')!;
    return new Response('', { status: 202 });
  });
  const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel}`, 'hub.challenge': 'attacker', 'hub.lease_seconds': '86400' });
  const forged = await handleRequest(new Request(`https://worker.example/websub?${query}`), f.env, fetch, () => now);
  assert.equal(forged.status, 404);
  const status = await (await f.call('/status')).json() as any;
  assert.equal(status.lease, null); assert.ok(status.pending);
  const valid = new URL(callback);
  for (const [key, value] of query) valid.searchParams.set(key, value);
  assert.equal((await handleRequest(new Request(valid), f.env, fetch, () => now)).status, 200);
});

test('403 cooldown survives real KV one-write-per-key-per-second limits', async () => {
  const f = fixture(); let time = now; const writes = new Map<string, number>();
  f.env.INBOX.put = async (key: string, value: string) => {
    if (time - (writes.get(key) ?? 0) < 1000) throw new Error('KV 429: same-key write limit');
    writes.set(key, time); f.values.set(key, value);
  };
  let calls = 0;
  await f.call('/transcript', 'POST', { videoId: video, channelId: channel }, async () => { calls++; return new Response('', { status: 403 }); });
  time += 120_000;
  const body = JSON.stringify({ videoId: video, channelId: channel });
  const headers = await signedHeaders(secret, 'POST', '/transcript', body, time);
  const response = await handleRequest(new Request('https://worker.example/transcript', { method: 'POST', headers, body }), f.env, async () => { calls++; return new Response(''); }, () => time);
  assert.equal(response.status, 503); assert.equal(calls, 1, 'six-hour cooldown must survive after the initial spacing expires');
});

test('verification capability remains secret and stable so renewal addresses the same subscription', async () => {
  const f = fixture(); const callbacks: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.call('/subscription', 'POST', {}, async (_url, init) => {
      callbacks.push(new URLSearchParams(String(init?.body)).get('hub.callback')!);
      return new Response('', { status: 202 });
    });
    const callback = new URL(callbacks.at(-1)!);
    assert.ok(callback.searchParams.get('verify'));
    const status = await (await f.call('/status')).text();
    assert.ok(!status.includes(callback.searchParams.get('verify')!), 'verification capability must not reach health logs');
    callback.searchParams.set('hub.mode', 'subscribe');
    callback.searchParams.set('hub.topic', `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel}`);
    callback.searchParams.set('hub.challenge', 'legitimate'); callback.searchParams.set('hub.lease_seconds', '3600');
    assert.equal((await handleRequest(new Request(callback), f.env, fetch, () => now)).status, 200);
  }
  assert.equal(callbacks[0], callbacks[1]);
});

test('subscription reaches an edge-compatible fetch only after durable pending intent', async () => {
  const f = fixture(); let requests = 0;
  const response = await f.call('/subscription', 'POST', {}, async (url, init) => {
    // workerd rejects redirect: error before sending a request; Node fetch does not.
    assert.equal(init?.redirect, 'manual');
    requests++;
    assert.equal(String(url), 'https://pubsubhubbub.appspot.com/subscribe');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(init?.body));
    const pending = JSON.parse(f.values.get(`state:${channel}:pending`)!);
    assert.equal(pending.topic, form.get('hub.topic'));
    assert.equal(pending.mode, 'subscribe');
    assert.equal(pending.expiresAt, now + 600_000);
    assert.equal(new URL(form.get('hub.callback')!).searchParams.get('verify'), pending.verificationToken);
    assert.equal(form.get('hub.secret'), f.env.HUB_SECRET);
    return new Response('', { status: 202 });
  });
  assert.equal(response.status, 202);
  assert.equal(requests, 1);
  const duplicate = await f.call('/subscription', 'POST', {}, async () => { requests++; throw new Error('duplicate-request'); });
  assert.equal(duplicate.status, 202);
  assert.equal(requests, 1, 'an unexpired pending intent must suppress resubmission');
});

test('manual hub redirects and other non-2xx responses fail closed without following or granting a lease', async () => {
  for (const status of [301, 302, 303, 307, 308, 400, 503]) {
    const f = fixture(); let requests = 0;
    const response = await f.call('/subscription', 'POST', {}, async (_url, init) => {
      assert.equal(init?.redirect, 'manual'); requests++;
      return new Response('', { status, headers: { location: 'https://untrusted.example/collect' } });
    });
    assert.equal(response.status, 503);
    assert.equal(requests, 1);
    const state = await (await f.call('/status')).json() as any;
    assert.equal(state.lease, null);
    assert.equal(state.pending.mode, 'subscribe');
    assert.equal(state.pending.expiresAt, now + 600_000);
  }
});

test('caption redirects fail closed with the edge-supported manual mode', async () => {
  const f = fixture(); let requests = 0;
  const response = await f.call('/transcript', 'POST', { videoId: video, channelId: channel }, async (_url, init) => {
    assert.equal(init?.redirect, 'manual'); requests++;
    return new Response('', { status: 307, headers: { location: 'https://untrusted.example/collect' } });
  });
  assert.equal(response.status, 503);
  assert.equal(requests, 1);
});

test('manual forwarding redirects preserve the signed durable event for pull retry', async () => {
  const f = fixture(); let requests = 0;
  f.env.PLUGIN_WEBHOOK_URL = 'https://paperclip.example/api/plugins/test/webhooks/youtube';
  const body = atom();
  const response = await handleRequest(new Request('https://worker.example/websub', { method: 'POST', body,
    headers: { 'x-hub-signature': await sign(f.env.HUB_SECRET!, body) } }), f.env, async (_url, init) => {
    assert.equal(init?.redirect, 'manual'); requests++;
    return new Response('', { status: 302, headers: { location: 'https://untrusted.example/collect' } });
  }, () => now);
  assert.equal(response.status, 202);
  assert.equal(requests, 1);
  assert.equal(((await (await f.call('/inbox')).json()) as any).events.length, 1);
});
