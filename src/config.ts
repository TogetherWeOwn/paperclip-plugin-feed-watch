import { z } from 'zod';
import { channelId, videoId } from './feed.ts';
const httpsUrl = z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search; }, 'Must be HTTPS without credentials, query or fragment');
export const secretRef = z.object({ type: z.literal('secret_ref'), secretId: z.uuid(), version: z.union([z.number(), z.literal('latest')]).optional() }).strict();
const schema = z.object({
  enabled: z.boolean().default(false),
  channelId: channelId.optional(), researchAgentId: z.uuid().optional(), projectId: z.uuid().optional(),
  publishedAfter: z.iso.datetime({ offset: true }).optional(),
  seedVideoIds: z.array(videoId).max(50_000).default([]),
  workerUrl: httpsUrl.optional(), workerSecretRef: secretRef.optional(),
  transcriptProviderUrl: httpsUrl.optional(), transcriptSecretRef: secretRef.optional(),
  youtubeApiKeyRef: secretRef.optional(),
  catalogUrl: httpsUrl.optional(),
  maxVideosPerTick: z.number().int().min(1).max(5).default(1),
  maxCaptionAttempts: z.number().int().min(2).max(100).default(12),
  webhookEnabled: z.boolean().default(false),
}).strict();
export type Config = z.infer<typeof schema>;
export function parseConfig(value: unknown): Config {
  const config = schema.parse(value);
  if (config.enabled && (!config.channelId || !config.researchAgentId || !config.projectId || !config.publishedAfter || !config.catalogUrl || !config.workerUrl || !config.workerSecretRef)) throw new Error('Enabled intake requires channel, researcher, project, publishedAfter, catalogUrl, workerUrl and company secret ref');
  if (config.transcriptProviderUrl && !config.transcriptSecretRef) throw new Error('Transcript provider requires a company secret ref');
  return config;
}
