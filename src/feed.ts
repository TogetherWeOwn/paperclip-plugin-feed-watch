import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
export const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const channelId = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
export const entrySchema = z.object({
  videoId, channelId, title: z.string().min(1).max(500),
  published: z.iso.datetime({ offset: true }), updated: z.iso.datetime({ offset: true }),
  url: z.string().url(),
});
export type Entry = z.infer<typeof entrySchema>;
export type Segment = { startMs: number; text: string };
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
// No DTDs (including internal expansion), external entities, or unbounded XML.
function xml(body: string, maxBytes: number, preserveOrder = false) {
  if (new TextEncoder().encode(body).length > maxBytes || /<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) throw new Error('invalid-xml');
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false,
    trimValues: false, preserveOrder, processEntities: true }).parse(body);
}
export function parseFeed(body: string, expectedChannel: string): Entry[] {
  channelId.parse(expectedChannel);
  const data = xml(body, 262_144);
  if (data.feed === undefined) throw new Error('invalid-feed');
  return array<any>(data.feed.entry).map(item => {
    const id = videoId.parse(item['yt:videoId']);
    const result = entrySchema.parse({ videoId: id, channelId: item['yt:channelId'], title: item.title,
      published: item.published, updated: item.updated ?? item.published,
      url: `https://www.youtube.com/watch?v=${id}` });
    if (result.channelId !== expectedChannel) throw new Error('channel-not-allowed');
    return result;
  });
}
function text(nodes: any[]): string {
  return nodes.map(node => typeof node['#text'] === 'string' ? node['#text'] : Object.entries(node)
    .filter(([key]) => key !== ':@').map(([, value]) => Array.isArray(value) ? text(value) : '').join('')).join('');
}
export function parseCaptions(body: string): Segment[] {
  if (new TextEncoder().encode(body).length > 4_194_304) throw new Error('captions-too-large');
  const segments: Segment[] = [];
  if (body.trimStart().startsWith('{')) {
    const data = JSON.parse(body);
    for (const event of array<any>(data.events)) {
      const value = array<any>(event.segs).map(seg => typeof seg.utf8 === 'string' ? seg.utf8 : '').join('');
      if (value.trim()) segments.push({ startMs: Number(event.tStartMs ?? 0), text: value });
    }
  } else {
    const nodes = xml(body, 4_194_304, true);
    const visit = (items: any[]) => {
      for (const node of items) {
        for (const [name, value] of Object.entries(node)) {
          if ((name === 'p' || name === 'text') && Array.isArray(value)) {
            const attrs = node[':@'] ?? {};
            const valueText = text(value);
            if (valueText.trim()) segments.push({ startMs: name === 'p' ? Number(attrs['@t'] ?? 0) : Math.round(Number(attrs['@start'] ?? 0) * 1000), text: valueText });
          } else if (Array.isArray(value)) visit(value);
        }
      }
    };
    visit(nodes);
  }
  if (!segments.length || segments.some(seg => !Number.isFinite(seg.startMs) || seg.startMs < 0)) throw new Error('caption-pending');
  return segments;
}
export async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`upstream-http-${response.status}`);
  if (!response.body) throw new Error('empty-upstream');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) throw new Error('upstream-too-large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
