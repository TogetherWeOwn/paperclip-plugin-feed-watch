import { z } from 'zod';
import type { PluginContext } from '@paperclipai/plugin-sdk';
import type { Config } from './config.ts';
import { entrySchema, parseFeed, readLimited, type Entry } from './feed.ts';
import { PLUGIN_ID, type Transport } from './engine.ts';
import { signedHeaders } from './crypto.ts';
export function createTransport(ctx: PluginContext, companyId: string, config: Config): Transport {
  const key = (name: string) => ({ scopeKind: 'company' as const, scopeId: companyId, namespace: PLUGIN_ID, stateKey: `${config.channelId}:${name}` });
  const request = async (path: string, method = 'GET', value?: unknown): Promise<any> => {
    const root = new URL(config.workerUrl!); root.pathname = root.pathname.replace(/\/$/, '') + path.split('?')[0]; root.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    const body = value === undefined ? '' : JSON.stringify(value);
    const headers = await signedHeaders(await ctx.secrets.resolve(config.workerSecretRef!, { companyId, configPath: 'workerSecretRef' }), method, root.pathname + root.search, body);
    const response = await ctx.http.fetch(root.href, { method, headers, body: body || undefined, redirect: 'error' });
    return JSON.parse(await readLimited(response, 12_582_912));
  };
  const api = async (resource: string, params: Record<string, string>): Promise<any> => {
    if (!config.youtubeApiKeyRef) throw new Error('gap-recovery-unconfigured');
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await ctx.http.fetch(url.href, { redirect: 'error', headers: { 'x-goog-api-key': await ctx.secrets.resolve(config.youtubeApiKeyRef, { companyId, configPath: 'youtubeApiKeyRef' }) } });
    return JSON.parse(await readLimited(response, 1_048_576));
  };
  return {
    async rss() {
      // The documented /xml/feeds topic is NOT the populated polling endpoint.
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${config.channelId}`;
      return parseFeed(await readLimited(await ctx.http.fetch(url, { redirect: 'error' }), 262_144), config.channelId!);
    },
    async recoverGap(lastSeen) {
      const channels = await api('channels', { part: 'contentDetails', id: config.channelId! });
      const channel = channels.items?.find((item: any) => item.id === config.channelId);
      const playlist = z.string().min(1).max(100).parse(channel?.contentDetails?.relatedPlaylists?.uploads);
      const recovered: Entry[] = [];
      let pageToken = '';
      for (let page = 0; page < 20; page++) {
        const data = await api('playlistItems', { part: 'snippet,contentDetails', maxResults: '50', playlistId: playlist, ...(pageToken ? { pageToken } : {}) });
        for (const item of z.array(z.any()).max(50).parse(data.items)) {
          const id = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
          if (id === lastSeen) return recovered;
          // Private/deleted slots can be absent from the public uploads view.
          if (!id || item.snippet?.title === 'Private video' || item.snippet?.title === 'Deleted video') continue;
          const published = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
          recovered.push(entrySchema.parse({ videoId: id, channelId: config.channelId, title: item.snippet?.title, published, updated: published, url: `https://www.youtube.com/watch?v=${id}` }));
        }
        if (!data.nextPageToken) throw new Error('gap-marker-not-found');
        pageToken = z.string().max(1000).parse(data.nextPageToken);
      }
      throw new Error('gap-page-limit');
    },
    async maintenance() {
      const status = await request('/status');
      await ctx.state.set(key('websub-status'), status);
      const now = Date.now();
      const active = typeof status.lease?.expiresAt === 'number' && status.lease.expiresAt > now;
      const pending = typeof status.pending?.expiresAt === 'number' && status.pending.expiresAt > now;
      if ((!active || status.lease.renewAt <= now) && !pending) await request('/subscription', 'POST', {});
      if (!active) throw new Error('websub-verification-pending');
    },
    async inbox() {
      // Rotate one bounded page per job; after the tail, start at the beginning.
      // No monotonic high-water cursor: immutable hashes can sort anywhere.
      const cursor = await ctx.state.get(key('inbox-cursor'));
      const result = await request(`/inbox${typeof cursor === 'string' && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      const events = z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), companyId: z.literal(companyId), channelId: z.literal(config.channelId!), entries: z.array(entrySchema).max(1000) })).max(50).parse(result.events);
      const next = result.cursor === undefined ? '' : z.string().max(2048).parse(result.cursor);
      await ctx.state.set(key('inbox-cursor'), next);
      return events;
    },
    async acknowledge(id) { await request('/ack', 'POST', { id }); },
  };
}
