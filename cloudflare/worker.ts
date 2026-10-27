import type { KVNamespace } from '@cloudflare/workers-types';
import { z } from 'zod';
import { authenticate, digest, signedHeaders, verify, PLUGIN_PUSH_PATH } from '../src/crypto.ts';
import { channelId, parseFeed, readLimited } from '../src/feed.ts';
export interface Env {
  ENABLED?: string; CHANNEL_ID: string; COMPANY_ID: string; CALLBACK_URL: string;
  PLUGIN_WEBHOOK_URL?: string; SHARED_SECRET?: string; HUB_SECRET?: string; INBOX: KVNamespace;
}
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const topicFor = (env: Env) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${env.CHANNEL_ID}`;
const eventKey = (env: Env, id: string) => `event:${env.CHANNEL_ID}:${id}`;
const ackKey = (env: Env, id: string) => `ack:${env.CHANNEL_ID}:${id}`;
const stateKey = (env: Env, key: string) => `state:${env.CHANNEL_ID}:${key}`;
async function stored<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.INBOX.get(key);
  return value === null ? null : JSON.parse(value) as T;
}
function publicHttps(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid-config');
  return url;
}
type Lease = { confirmedAt: number; leaseSeconds: number; expiresAt: number; renewAt: number };
type Pending = { topic: string; mode: 'subscribe'; expiresAt: number; verificationToken: string };
async function acknowledge(env: Env, id: string) {
  // Keep a receipt for redelivery/consistency races. No unacknowledged event TTL.
  await env.INBOX.put(ackKey(env, id), '1', { expirationTtl: 2_592_000 });
  await env.INBOX.delete(eventKey(env, id));
}
export async function handleRequest(request: Request, env: Env, fetcher: typeof fetch = fetch, clock: () => number = Date.now): Promise<Response> {
  if (env.ENABLED !== 'true') return json({ error: 'disabled' }, 503);
  try {
    channelId.parse(env.CHANNEL_ID); z.uuid().parse(env.COMPANY_ID);
    if (!env.SHARED_SECRET || env.SHARED_SECRET.length < 32 || !env.HUB_SECRET || env.HUB_SECRET.length < 32 || env.HUB_SECRET === env.SHARED_SECRET) throw new Error('missing-config');
    const callback = publicHttps(env.CALLBACK_URL);
    if (callback.pathname !== '/websub') throw new Error('invalid-callback');
    const url = new URL(request.url); const now = clock();
    if (url.pathname === '/websub' && url.origin !== callback.origin) return json({ error: 'not-found' }, 404);
    if (url.pathname === '/websub' && request.method === 'GET') {
      const pending = await stored<Pending>(env, stateKey(env, 'pending'));
      const mode = url.searchParams.get('hub.mode'), topic = url.searchParams.get('hub.topic'), challenge = url.searchParams.get('hub.challenge');
      const seconds = url.searchParams.get('hub.lease_seconds');
      if (!pending?.verificationToken || url.searchParams.get('verify') !== pending.verificationToken || pending.expiresAt <= now || mode !== pending.mode || topic !== pending.topic || topic !== topicFor(env) || !challenge || challenge.length > 4096 || !seconds || !/^\d+$/.test(seconds) || Number(seconds) < 60 || Number(seconds) > 31_536_000) return json({ error: 'not-found' }, 404);
      const leaseSeconds = Number(seconds);
      await env.INBOX.put(stateKey(env, 'lease'), JSON.stringify({ confirmedAt: now, leaseSeconds, expiresAt: now + leaseSeconds * 1000, renewAt: now + leaseSeconds * 800 } satisfies Lease));
      await env.INBOX.delete(stateKey(env, 'pending'));
      return new Response(challenge, { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/websub' && request.method === 'POST') {
      const body = await readLimited(new Response(request.body), 262_144);
      const signature = request.headers.get('x-hub-signature') ?? '';
      if (!await verify(env.HUB_SECRET, body, signature)) return json({ error: 'unauthorized' }, 401);
      const entries = parseFeed(body, env.CHANNEL_ID);
      const id = await digest(body);
      if (!await env.INBOX.get(ackKey(env, id))) {
        const event = { id, companyId: env.COMPANY_ID, channelId: env.CHANNEL_ID, entries };
        await env.INBOX.put(eventKey(env, id), JSON.stringify(event));
        if (env.PLUGIN_WEBHOOK_URL) {
          try {
            const target = publicHttps(env.PLUGIN_WEBHOOK_URL);
            if (!/^\/api\/plugins\/[^/]+\/webhooks\/youtube$/.test(target.pathname)) throw new Error('invalid-plugin-webhook');
            const payload = JSON.stringify({ companyId: env.COMPANY_ID, channelId: env.CHANNEL_ID, eventId: id, entries });
            const response = await fetcher(target.href, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
              headers: await signedHeaders(env.SHARED_SECRET, 'POST', PLUGIN_PUSH_PATH, payload, now), body: payload });
            if (response.ok) await acknowledge(env, id);
          } catch { /* Durable inbox pull retries without a Worker cron. */ }
        }
      }
      return json({ accepted: true, id }, 202);
    }
    const body = request.method === 'GET' ? '' : await readLimited(new Response(request.body), 32_768);
    try { await authenticate(env.SHARED_SECRET, request.method, url.pathname + url.search, body, request.headers, now); }
    catch { return json({ error: 'unauthorized' }, 401); }
    if (url.pathname === '/status' && request.method === 'GET') {
      const pending = await stored<Pending>(env, stateKey(env, 'pending'));
      // The verification capability must not enter plugin health/delivery logs.
      return json({ lease: await stored(env, stateKey(env, 'lease')), pending: pending ? { topic: pending.topic, mode: pending.mode, expiresAt: pending.expiresAt } : null });
    }
    if (url.pathname === '/subscription' && request.method === 'POST') {
      const pending = await stored<Pending>(env, stateKey(env, 'pending'));
      if (pending && pending.expiresAt > now) return json({ pending: true }, 202);
      let verificationToken = await stored<string>(env, stateKey(env, 'verification-token'));
      if (!verificationToken) {
        verificationToken = crypto.randomUUID();
        await env.INBOX.put(stateKey(env, 'verification-token'), JSON.stringify(verificationToken));
      }
      const verifiedCallback = new URL(env.CALLBACK_URL); verifiedCallback.searchParams.set('verify', verificationToken);
      await env.INBOX.put(stateKey(env, 'pending'), JSON.stringify({ topic: topicFor(env), mode: 'subscribe', expiresAt: now + 600_000, verificationToken } satisfies Pending));
      // Workers rejects redirect: 'error' before sending anything. Manual mode
      // plus the non-2xx check below also refuses redirects without leaking secrets.
      const response = await fetcher('https://pubsubhubbub.appspot.com/subscribe', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.topic': topicFor(env), 'hub.callback': verifiedCallback.href, 'hub.lease_seconds': '86400', 'hub.secret': env.HUB_SECRET }) });
      if (!response.ok) throw new Error('hub-request-failed');
      return json({ pending: true }, 202);
    }
    if (url.pathname === '/inbox' && request.method === 'GET') {
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (cursor && cursor.length > 2048) return json({ error: 'invalid-cursor' }, 400);
      const page = await env.INBOX.list({ prefix: `event:${env.CHANNEL_ID}:`, limit: 50, cursor });
      const events = [];
      for (const { name } of page.keys) {
        const value = await env.INBOX.get(name);
        if (value) events.push(JSON.parse(value));
      }
      return json({ events, cursor: page.list_complete ? undefined : page.cursor });
    }
    if (url.pathname === '/ack' && request.method === 'POST') {
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(body));
      await acknowledge(env, id); return json({ acknowledged: true });
    }
    return json({ error: 'not-found' }, 404);
  } catch { return json({ error: 'upstream-or-validation-failed' }, 503); }
}
export default { fetch: (request: Request, env: Env) => handleRequest(request, env) };
