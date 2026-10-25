import { open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { authenticate } from '../src/crypto.ts';
import { channelId, videoId, parseCaptions, readLimited } from '../src/feed.ts';

const controlSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().min(0).max(96), last: z.number().int().nonnegative(), blockedUntil: z.number().int().nonnegative() }).strict();
const transcriptSchema = z.object({ videoId, language: z.string().min(1).max(50), source: z.literal('youtube-captions'),
  retrievedAt: z.iso.datetime({ offset: true }), raw: z.string().min(1).max(4_194_304),
  segments: z.array(z.object({ startMs: z.number().finite().nonnegative(), text: z.string().min(1) })).min(1).max(100_000) });
const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export interface ProviderOptions {
  secret: string; channelId: string; proxyUrl: string; stateFile: string;
  clock?: () => number; fetcher?: typeof fetch;
}
// Exactly one process/replica owns the state file. No fallback to direct egress.
export async function createProvider(options: ProviderOptions) {
  z.string().min(32).max(512).parse(options.secret); channelId.parse(options.channelId);
  const proxy = new URL(options.proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('invalid-proxy');
  const clock = options.clock ?? Date.now;
  let control = { day: new Date(clock()).toISOString().slice(0, 10), count: 0, last: 0, blockedUntil: 0 };
  try { control = controlSchema.parse(JSON.parse(await readFile(options.stateFile, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('invalid-state'); }
  const dispatcher = new ProxyAgent({ uri: proxy.href, connections: 1 });
  // Use matching Undici versions: Node's built-in fetch can have an older dispatcher protocol.
  const fetcher: typeof fetch = options.fetcher ?? ((input, init) => undiciFetch(String(input), init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>);
  let busy = false;
  let stateFailed = false;
  async function persist() {
    try {
      const file = await open(`${options.stateFile}.tmp`, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(control)); await file.sync(); } finally { await file.close(); }
      await rename(`${options.stateFile}.tmp`, options.stateFile);
      const dir = await open(dirname(options.stateFile), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { stateFailed = true; throw new ProviderError('state-unavailable', 503); }
  }
  async function transcript(id: string) {
    const now = clock();
    const day = new Date(now).toISOString().slice(0, 10);
    if (control.day !== day) { control.day = day; control.count = 0; }
    if (control.blockedUntil > now || (control.last > 0 && now - control.last < 60_000) || control.count >= 96) throw new ProviderError('caption-cooldown', 429);
    control.last = now; control.count++;
    // Persist the attempt BEFORE any external request, including failed attempts.
    await persist();
    const userAgent = 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip';
    const fetchText = async (url: string, init?: RequestInit) => {
      const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000), dispatcher } as RequestInit & { dispatcher: ProxyAgent });
      if (response.status === 429 || response.status === 403) {
        control.blockedUntil = clock() + 21_600_000;
        await response.body?.cancel();
        await persist();
        throw new ProviderError('upstream-unavailable', 502);
      }
      return readLimited(response, 4_194_304);
    };
    const player = JSON.parse(await fetchText('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': userAgent },
      body: JSON.stringify({ videoId: id, context: { client: { clientName: 'ANDROID', clientVersion: '21.26.364', androidSdkVersion: 30, hl: 'en', gl: 'US', userAgent } } }),
    }));
    if (player.videoDetails?.channelId !== options.channelId) throw new Error('caption-pending');
    const tracks = z.array(z.object({ baseUrl: z.url(), languageCode: z.string().min(1).max(50), kind: z.string().optional() })).max(1000)
      .parse(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
    const rank = (track: typeof tracks[number]) => track.languageCode === 'en' ? track.kind === 'asr' ? 1 : 0 : 2;
    const track = tracks.sort((a, b) => rank(a) - rank(b))[0];
    if (!track) throw new Error('caption-pending');
    const url = new URL(track.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !['www.youtube.com', 'youtube.com'].includes(url.hostname) || url.pathname !== '/api/timedtext' || url.port) throw new Error('caption-url-not-allowed');
    url.searchParams.delete('tlang');
    const raw = await fetchText(url.href, { headers: { 'user-agent': userAgent } });
    return transcriptSchema.parse({ videoId: id, raw, segments: parseCaptions(raw), language: track.languageCode, source: 'youtube-captions', retrievedAt: new Date(now).toISOString() });
  }
  return {
    close: () => dispatcher.close(),
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/healthz' && !url.search) return json({ ok: true });
      if (request.method !== 'POST' || url.pathname !== '/transcript' || url.search) return json({ error: 'not-found' }, 404);
      let body: string;
      try { body = await readLimited(new Response(request.body), 32_768); }
      catch { return json({ error: 'invalid-body' }, 413); }
      try { await authenticate(options.secret, request.method, url.pathname, body, request.headers, clock()); }
      catch { return json({ error: 'unauthorized' }, 401); }
      let input: { videoId: string; channelId: string };
      try { input = z.object({ videoId, channelId: z.literal(options.channelId) }).strict().parse(JSON.parse(body)); }
      catch { return json({ error: 'invalid-request' }, 400); }
      if (stateFailed) return json({ error: 'state-unavailable' }, 503);
      if (busy) return json({ error: 'caption-cooldown' }, 429);
      busy = true;
      try { return json(await transcript(input.videoId)); }
      catch (error) { return error instanceof ProviderError ? json({ error: error.message }, error.status) : json({ error: 'upstream-unavailable' }, 502); }
      finally { busy = false; }
    },
  };
}
