import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';
import { z } from 'zod';
import { schema } from './config.ts';
import { PLUGIN_ID } from './engine.ts';
// Contracts verified against /app/packages/plugins/sdk/src/types.ts and
// /app/packages/shared/src/types/plugin.ts on Paperclip SDK 1.0.0.
const manifest = {
  id: PLUGIN_ID, apiVersion: 1, version: '0.2.0', displayName: 'Feed Watch',
  description: 'Deterministic YouTube discovery (RSS/WebSub) issuing unassigned stub cards. No caption fetching. Disabled until configured.',
  author: 'TogetherWeOwn', categories: ['automation'],
  capabilities: ['companies.read', 'issues.read', 'issues.create',
    'issue.documents.read', 'issue.documents.write', 'plugin.state.read', 'plugin.state.write',
    'jobs.schedule', 'http.outbound', 'secrets.read-ref', 'webhooks.receive'],
  entrypoints: { worker: './dist/worker.js' },
  instanceConfigSchema: z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }),
  jobs: [{ jobKey: 'poll', displayName: 'Reconcile YouTube intake', schedule: '*/15 * * * *',
    description: 'RSS, inbox replay, lease renewal and stub-card issuance; no inference on empty checks.' }],
  webhooks: [{ endpointKey: 'youtube', displayName: 'Signed normalized YouTube intake',
    description: 'JSON from the protocol adapter only; not a direct YouTube WebSub callback.' }],
} satisfies PaperclipPluginManifestV1;
export default manifest;
