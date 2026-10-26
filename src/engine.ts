import type { PluginContext } from '@paperclipai/plugin-sdk';
import type { Config } from './config.ts';
import { entrySchema, type Entry } from './feed.ts';
import { stubDescription, stubDocument } from './instructions.ts';
export const PLUGIN_ID = 'togetherweown.feed-watch';
export interface Transport {
  rss(): Promise<Entry[]>;
  recoverGap(lastSeen: string): Promise<Entry[]>;
  maintenance(): Promise<void>;
  inbox(): Promise<{ id: string; entries: Entry[] }[]>;
  acknowledge(id: string): Promise<void>;
}
type Video = {
  entry: Entry; stage: 'discovered' | 'stub-created';
  discoveredAt: number; lastAttemptAt?: number; retryAt: number; error?: string;
  issueId?: string; createAttempted?: boolean;
};
export type ChannelState = { videos: Record<string, Video>; lastSeen?: string; lastCheckAt?: number; degraded: Record<string, string> };
const queues = new WeakMap<PluginContext, Promise<unknown>>();
// One worker process per installed plugin. Webhooks only ingest; this serialized
// maintenance consumer is the ONLY issue issuer. No uniqueness is assumed in core.
function serialized<T>(ctx: PluginContext, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(ctx) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(ctx, run.catch(() => {}));
  return run;
}
function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return /^(gap-recovery-unconfigured|gap-page-limit|gap-marker-not-found|ambiguous-create|document-conflict|document-verification-failed|upstream-http-\d{3})$/.test(message) ? message : fallback;
}
// Versions before the discovery-only cut persisted caption/research stages.
// A record that already owns a card is complete discovery; one without a card
// still owes its stub. Nothing is re-issued and no document is rewritten.
function normalize(state: ChannelState): ChannelState {
  for (const record of Object.values(state.videos)) {
    if (record.stage !== 'discovered' && record.stage !== 'stub-created') {
      record.stage = record.issueId ? 'stub-created' : 'discovered';
    }
  }
  return state;
}
export class FeedWatch {
  private ctx: PluginContext;
  private companyId: string;
  private config: Config;
  private io: Transport;
  private now: () => number;
  constructor(ctx: PluginContext, companyId: string, config: Config, io: Transport, now: () => number = Date.now) {
    this.ctx = ctx; this.companyId = companyId; this.config = config; this.io = io; this.now = now;
  }
  private key(stateKey: string) { return { scopeKind: 'company' as const, scopeId: this.companyId, namespace: PLUGIN_ID, stateKey: `${this.config.channelId}:${stateKey}` }; }
  async status(): Promise<ChannelState> {
    const state = await this.ctx.state.get(this.key('channel')) as ChannelState | null ?? { videos: {}, degraded: {} };
    state.lastSeen ??= this.config.initialLastSeen;
    return normalize(state);
  }
  private save(state: ChannelState) { return this.ctx.state.set(this.key('channel'), state); }
  private discover(state: ChannelState, entries: Entry[]) {
    const seeded = new Set(this.config.seedVideoIds);
    for (const value of entries) {
      const entry = entrySchema.parse(value);
      if (entry.channelId !== this.config.channelId) throw new Error('channel-not-allowed');
      if (seeded.has(entry.videoId) || Date.parse(entry.published) < Date.parse(this.config.publishedAfter!)) continue;
      const existing = Object.hasOwn(state.videos, entry.videoId) ? state.videos[entry.videoId] : undefined;
      if (existing) {
        if (Date.parse(entry.updated) > Date.parse(existing.entry.updated)) existing.entry = entry;
      } else state.videos[entry.videoId] = { entry, stage: 'discovered', discoveredAt: this.now(), retryAt: 0 };
    }
  }
  async receive(entries: Entry[]): Promise<void> {
    if (!this.config.enabled) return;
    await serialized(this.ctx, async () => { const state = await this.status(); this.discover(state, entries); await this.save(state); });
  }
  async tick(): Promise<void> {
    if (!this.config.enabled) return;
    await serialized(this.ctx, async () => {
      const state = await this.status();
      try { await this.io.maintenance(); delete state.degraded.websub; }
      catch { state.degraded.websub = 'worker-maintenance-failed'; }
      try {
        for (const event of await this.io.inbox()) {
          this.discover(state, event.entries);
          await this.save(state); // Durable native intake BEFORE acknowledgement.
          await this.io.acknowledge(event.id);
        }
        delete state.degraded.inbox;
      } catch { state.degraded.inbox = 'worker-inbox-failed'; }
      try {
        const feed = await this.io.rss();
        this.discover(state, feed);
        let reconciled = true;
        if (state.lastSeen && !feed.some(entry => entry.videoId === state.lastSeen)) {
          try { this.discover(state, await this.io.recoverGap(state.lastSeen)); delete state.degraded.gap; }
          catch (error) { state.degraded.gap = safeError(error, 'gap-recovery-failed'); reconciled = false; }
        } else if (!state.lastSeen && feed.length && feed.every(entry => Date.parse(entry.published) > Date.parse(this.config.publishedAfter!))) {
          // A truncated RSS tail cannot prove that older in-scope videos were
          // handled. Keep bootstrap open until a corpus marker is supplied or
          // the explicit boundary is covered by the feed.
          state.degraded.gap = 'bootstrap-coverage-unverified'; reconciled = false;
        } else if (feed.length) delete state.degraded.gap;
        if (feed.length && reconciled) state.lastSeen = feed[0].videoId;
        state.lastCheckAt = this.now(); delete state.degraded.rss;
      } catch { state.degraded.rss = 'rss-reconciliation-failed'; }
      await this.save(state);
      const pending = Object.values(state.videos).filter(record => record.stage === 'discovered' && record.retryAt <= this.now())
        .sort((a,b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0) || Date.parse(a.entry.published) - Date.parse(b.entry.published)).slice(0, this.config.maxVideosPerTick);
      for (const record of pending) {
        try { record.lastAttemptAt = this.now(); await this.save(state); await this.prepare(state, record); }
        catch (error) { record.error = safeError(error, 'preparation-failed'); record.retryAt = this.now() + 900_000; await this.save(state); }
      }
      await this.save(state);
    });
  }
  private async issue(state: ChannelState, record: Video): Promise<any> {
    const originKind = `plugin:${PLUGIN_ID}` as const;
    const originId = `youtube:${this.config.channelId}:${record.entry.videoId}`;
    const matches = await this.ctx.issues.list({ companyId: this.companyId, originKind, originId, limit: 2 });
    if (matches.length > 1) throw new Error('ambiguous-create');
    if (matches.length === 1) { record.issueId = matches[0].id; await this.save(state); return matches[0]; }
    // Persist intent BEFORE create: a restart or timeout cannot safely assume the
    // request failed. Query recovers committed creates; absent rows are held.
    if (record.createAttempted || record.issueId) throw new Error('ambiguous-create');
    record.createAttempted = true; await this.save(state);
    const issue = await this.ctx.issues.create({ companyId: this.companyId, projectId: this.config.projectId,
      title: `Research YouTube: ${record.entry.title}`.slice(0, 200),
      description: stubDescription(record.entry),
      status: 'backlog', priority: 'low', originKind, originId });
    record.issueId = issue.id; await this.save(state); return issue;
  }
  private async immutable(issueId: string, key: string, body: string): Promise<void> {
    const existing = await this.ctx.issues.documents.get(issueId, key, this.companyId);
    if (existing && existing.body !== body) throw new Error('document-conflict');
    if (!existing) await this.ctx.issues.documents.upsert({ companyId: this.companyId, issueId, key, title: key, format: 'markdown', body });
    const saved = await this.ctx.issues.documents.get(issueId, key, this.companyId);
    if (saved?.body !== body) throw new Error('document-verification-failed');
  }
  // Discovery ends at an unassigned backlog stub: video link + publish date on
  // the card, provenance in one immutable source document. Assignment would
  // wake an agent that has no transcript yet, so this plugin never assigns.
  private async prepare(state: ChannelState, record: Video): Promise<void> {
    const issue = await this.issue(state, record);
    await this.immutable(issue.id, 'source', stubDocument(record.entry, record.discoveredAt));
    record.stage = 'stub-created'; delete record.error;
    await this.save(state);
  }
}
