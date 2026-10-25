// WebSub signs original bytes. Internal requests additionally bind time + route.
// https://www.w3.org/TR/websub/#authenticated-content-distribution
// Native onWebhook receives no URL; sign a fixed purpose, not an unknowable UUID route.
export const PLUGIN_PUSH_PATH = '/paperclip-feed-watch/youtube';
const encoder = new TextEncoder();
const algorithms = { sha1: 'SHA-1', sha256: 'SHA-256' } as const;
export async function digest(body: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(body)));
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function key(secret: string, algorithm: 'SHA-1' | 'SHA-256') {
  if (!secret) throw new Error('missing-secret');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: algorithm }, false, ['sign', 'verify']);
}
export async function sign(secret: string, body: string, algorithm: 'SHA-1' | 'SHA-256' = 'SHA-256') {
  const bytes = await crypto.subtle.sign('HMAC', await key(secret, algorithm), encoder.encode(body));
  return `${algorithm === 'SHA-1' ? 'sha1' : 'sha256'}=${hex(bytes)}`;
}
export async function verify(secret: string, body: string, signature: string): Promise<boolean> {
  const match = /^(sha1|sha256)=([a-f0-9]+)$/i.exec(signature);
  if (!match) return false;
  const algorithm = algorithms[match[1].toLowerCase() as keyof typeof algorithms];
  if (match[2].length !== (algorithm === 'SHA-1' ? 40 : 64)) return false;
  const bytes = new Uint8Array(match[2].match(/../g)!.map(byte => parseInt(byte, 16)));
  return crypto.subtle.verify('HMAC', await key(secret, algorithm), bytes, encoder.encode(body));
}
const canonical = (method: string, path: string, time: string, body: string) => `${method}\n${path}\n${time}\n${body}`;
export async function signedHeaders(secret: string, method: string, path: string, body = '', now = Date.now()): Promise<Record<string, string>> {
  const time = String(Math.floor(now / 1000));
  return { 'content-type': 'application/json', 'x-feed-timestamp': time,
    'x-feed-signature': await sign(secret, canonical(method, path, time, body)) };
}
export async function authenticate(secret: string, method: string, path: string, body: string, headers: Headers | Record<string, string | string[]>, now = Date.now()): Promise<void> {
  const get = (name: string) => headers instanceof Headers ? headers.get(name) : headers[name];
  const time = get('x-feed-timestamp');
  const signature = get('x-feed-signature');
  if (typeof time !== 'string' || !/^\d{10}$/.test(time.padStart(10, '0')) || !Number.isSafeInteger(Number(time)) || Math.abs(now - Number(time) * 1000) > 300_000 || typeof signature !== 'string' || !signature.startsWith('sha256=')) throw new Error('authentication-failed');
  if (!await verify(secret, canonical(method, path, time, body), signature)) throw new Error('authentication-failed');
}
