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
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
// No DTDs (including internal expansion), external entities, or unbounded XML.
function xml(body: string, maxBytes: number) {
  if (new TextEncoder().encode(body).length > maxBytes || /<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) throw new Error('invalid-xml');
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false,
    trimValues: false, processEntities: true }).parse(body);
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
