import { definePlugin, runWorker, type PluginContext } from '@paperclipai/plugin-sdk';
import { z } from 'zod';
import { parseConfig } from './config.ts';
import { FeedWatch, PLUGIN_ID } from './engine.ts';
import { createTransport } from './adapters.ts';
import { authenticate, PLUGIN_PUSH_PATH } from './crypto.ts';
import { channelId, entrySchema } from './feed.ts';
export function createPlugin() {
  let ctx: PluginContext;
  const invocationErrors: Record<string, string> = {};
  const watcher = async (companyId: string, raw: unknown) => {
    const config = parseConfig(raw);
    return { config, feed: new FeedWatch(ctx, companyId, config, createTransport(ctx, companyId, config)) };
  };
  // The host scopes a job's config reads to companies that stored this plugin's
  // config; any other company is denied with this message. That company simply
  // never configured the plugin, so it is skipped rather than reported failing.
  const unconfigured = (error: unknown) => error instanceof Error && error.message.includes('company context is required');
  async function companies() {
    const result = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.companies.list({ limit: 100, offset }); result.push(...page);
      if (page.length < 100) return result;
    }
  }
  return definePlugin({
    async setup(context) {
      ctx = context;
      ctx.jobs.register('poll', async () => {
        for (const company of await companies()) {
          let raw: unknown;
          try { raw = await ctx.config.get(company.id); }
          catch (error) {
            if (unconfigured(error)) { delete invocationErrors[company.id]; continue; }
            invocationErrors[company.id] = 'configuration-or-poll-failed'; continue;
          }
          try { const { feed } = await watcher(company.id, raw); await feed.tick(); delete invocationErrors[company.id]; }
          catch { invocationErrors[company.id] = 'configuration-or-poll-failed'; }
        }
        if (Object.keys(invocationErrors).length) throw new Error('One or more company intakes failed; inspect plugin health');
      });
    },
    async onValidateConfig(value) {
      try { parseConfig(value); return { ok: true }; }
      catch { return { ok: false, errors: ['Invalid feed-watch configuration. See README for required scope, bootstrap boundary and company secret-ref objects.'] }; }
    },
    async onWebhook(input) {
      if (input.endpointKey !== 'youtube' || new TextEncoder().encode(input.rawBody).length > 262_144) throw new Error('invalid-intake');
      // Parse only a bounded tenant selector before authentication; never trust a
      // tenant/channel/agent supplied by the payload for routing or assignment.
      const body = JSON.parse(input.rawBody);
      const companyId = z.uuid().parse(body.companyId);
      const { config, feed } = await watcher(companyId, await ctx.config.get(companyId));
      if (!config.enabled || !config.webhookEnabled) throw new Error('intake-disabled');
      await authenticate(await ctx.secrets.resolve(config.workerSecretRef!, { companyId, configPath: 'workerSecretRef' }), 'POST', PLUGIN_PUSH_PATH, input.rawBody, input.headers);
      const event = z.object({ companyId: z.literal(companyId), channelId, eventId: z.string().regex(/^[a-f0-9]{64}$/), entries: z.array(entrySchema).max(1000) }).strict().parse(body);
      if (event.channelId !== config.channelId) throw new Error('channel-not-allowed');
      await feed.receive(event.entries); // Persisted acceptance, NOT research completion.
    },
    async onHealth() {
      const summaries: Record<string, unknown> = {};
      let degraded = Object.keys(invocationErrors).length > 0;
      for (const company of await companies()) {
        let raw: unknown;
        try { raw = await ctx.config.get(company.id); }
        catch (error) {
          if (unconfigured(error)) continue;
          degraded = true; invocationErrors[company.id] = 'configuration-or-health-failed'; continue;
        }
        try {
          const { config, feed } = await watcher(company.id, raw);
          if (!config.enabled) continue;
          const state = await feed.status();
          const pending = Object.values(state.videos).filter(video => video.stage !== 'research-pending');
          const blocked = pending.filter(video => video.stage === 'caption-blocked' || video.error).length;
          const stale = !state.lastCheckAt || Date.now() - state.lastCheckAt > 2_700_000;
          const lease = await ctx.state.get({ scopeKind: 'company', scopeId: company.id, namespace: PLUGIN_ID, stateKey: `${config.channelId}:websub-status` });
          summaries[company.id] = { channelId: config.channelId, queueDepth: pending.length, blocked,
            oldestPendingAgeSeconds: pending.length ? Math.floor((Date.now() - Math.min(...pending.map(video => video.discoveredAt))) / 1000) : 0,
            lastCheckAt: state.lastCheckAt, lastSeen: state.lastSeen, degraded: state.degraded, stale, websub: lease,
            errors: Object.values(state.videos).filter(video => video.error).map(video => ({ videoId: video.entry.videoId, stage: video.stage, error: video.error, retryAt: video.retryAt, issueId: video.issueId })) };
          degraded ||= stale || blocked > 0 || Object.keys(state.degraded).length > 0;
        } catch { degraded = true; invocationErrors[company.id] = 'configuration-or-health-failed'; }
      }
      return { status: degraded ? 'degraded' : 'ok', message: Object.keys(summaries).length ? 'Feed intake status (research completion is tracked by native issues)' : 'Intake disabled; no external work scheduled', details: { companies: summaries, invocationErrors } };
    },
  });
}
const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
