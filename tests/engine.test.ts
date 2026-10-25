import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@paperclipai/plugin-sdk';
import { FeedWatch, type Transport, type Transcript } from '../src/engine.ts';
import { parseConfig } from '../src/config.ts';
import { parseFeed } from '../src/feed.ts';
import { channel, video, atom } from './fixtures.ts';
const companyId = '11111111-1111-4111-8111-111111111111';
const config = parseConfig({ enabled: true, channelId: channel, researchAgentId: companyId, projectId: companyId,
  workerUrl: 'https://worker.example', workerSecretRef: { type: 'secret_ref', secretId: companyId },
  publishedAfter: '2026-10-24T00:00:00Z', catalogUrl: 'https://catalog.example', maxVideosPerTick: 5 });
const capture: Transcript = { videoId: video, language: 'en', source: 'youtube-captions', retrievedAt: '2026-10-25T12:00:00Z', raw: '<timedtext><p t="0">Full transcript</p></timedtext>', segments: [{ startMs: 0, text: 'Full transcript' }] };
function fixture() {
  const localConfig = parseConfig(structuredClone(config));
  const states = new Map<string, any>();
  const issues: any[] = [];
  const docs = new Map<string, any>();
  let fetchCount = 0;
  let failCreateAfterCommit = false;
  let failCreateBeforeCommit = false;
  let failDoc = false;
  const ctx = {
    agents: { get: async () => ({ id: companyId, companyId, status: 'idle' }) },
    state: { get: async (key: any) => structuredClone(states.get(key.stateKey) ?? null), set: async (key: any, value: any) => { states.set(key.stateKey, structuredClone(value)); }, delete: async (key: any) => { states.delete(key.stateKey); } },
    issues: {
      list: async (input: any) => structuredClone(issues.filter(i => i.originId === input.originId && i.originKind === input.originKind && i.companyId === input.companyId)),
      get: async (id: string) => structuredClone(issues.find(i => i.id === id)),
      create: async (input: any) => {
        if (failCreateBeforeCommit) { failCreateBeforeCommit = false; throw new Error('transport'); }
        const issue = { ...input, id: `issue-${issues.length}`, assigneeAgentId: null };
        issues.push(issue);
        if (failCreateAfterCommit) { failCreateAfterCommit = false; throw new Error('transport'); }
        return structuredClone(issue);
      },
      update: async (id: string, patch: any) => {
        const issue = issues.find(i => i.id === id)!;
        assert.ok(docs.has(`${id}:plan`), 'plan must be durable before assignment');
        assert.ok([...docs.keys()].some(k => k.startsWith(`${id}:transcript-`)), 'full transcript before wake');
        Object.assign(issue, patch);
        return structuredClone(issue);
      },
      documents: {
        get: async (id: string, key: string) => docs.get(`${id}:${key}`) ?? null,
        upsert: async (input: any) => { if (failDoc) { failDoc = false; throw new Error('connection'); } docs.set(`${input.issueId}:${input.key}`, structuredClone(input)); return input; },
      },
    },
  } as unknown as PluginContext;
  const io: Transport = {
    rss: async () => parseFeed(atom(), channel),
    recoverGap: async () => { throw new Error('gap-recovery-unconfigured'); },
    transcript: async entry => { fetchCount++; return { ...capture, videoId: entry.videoId }; },
    maintenance: async () => {}, inbox: async () => [], acknowledge: async () => {},
  };
  let time = Date.parse('2026-10-25T12:00:00Z');
  const engine = () => new FeedWatch(ctx, companyId, localConfig, io, () => time);
  return { states, docs, issues, io, ctx, engine, config: localConfig, fetchCount: () => fetchCount,
    advance: () => { time += 86400000; }, failCreate: (after: boolean) => { if (after) failCreateAfterCommit = true; else failCreateBeforeCommit = true; }, failDoc: () => { failDoc = true; } };
}

test('disabled tick and webhook have no network, state writes or cards', async () => {
  const f = fixture();
  const watcher = new FeedWatch(f.ctx, companyId, parseConfig({}), f.io);
  await watcher.tick(); await watcher.receive(parseFeed(atom(), channel));
  assert.equal(f.states.size, 0); assert.equal(f.fetchCount(), 0); assert.equal(f.issues.length, 0);
});
test('duplicate/out-of-order notifications + metadata changes produce exactly one prepared card across restarts', async () => {
  const f = fixture();
  await Promise.all([f.engine().receive(parseFeed(atom(), channel)), f.engine().receive(parseFeed(atom(), channel))]);
  await f.engine().tick();
  const docsCount = f.docs.size;
  await f.engine().receive(parseFeed(atom().replace('Research &amp; testing', 'New title'), channel));
  await f.engine().tick();
  assert.equal(f.issues.length, 1); assert.equal(f.fetchCount(), 1); assert.equal(f.docs.size, docsCount);
  assert.equal(f.issues[0].status, 'todo'); assert.equal(f.issues[0].assigneeAgentId, config.researchAgentId);
});
test('no known latest marker triggers paginated recovery rather than trusting the 15-video window', async () => {
  const f = fixture(); await f.engine().tick();
  const newer = 'dZgA6btnb_s', missed = 'aVbRSIQO2dE';
  f.io.rss = async () => parseFeed(atom([newer]), channel);
  let recovered = false;
  f.io.recoverGap = async marker => { assert.equal(marker, video); recovered = true; return parseFeed(atom([newer, missed, video]), channel); };
  await f.engine().tick();
  assert.equal(recovered, true); assert.equal(f.issues.length, 3);
});
test('missing long-gap credentials is visible degraded state and preserves the old checkpoint', async () => {
  const f = fixture(); await f.engine().tick();
  f.io.rss = async () => parseFeed(atom(['dZgA6btnb_s']), channel);
  await f.engine().tick();
  const status = await f.engine().status();
  assert.equal(status.lastSeen, video); assert.equal(status.degraded?.gap, 'gap-recovery-unconfigured');
});
test('ambiguous successful issue create is recovered by origin query, never re-created', async () => {
  const f = fixture(); f.failCreate(true); await f.engine().tick();
  assert.equal(f.issues.length, 1); assert.equal(f.issues[0].status, 'backlog');
  f.advance(); await f.engine().tick();
  assert.equal(f.issues.length, 1); assert.equal(f.issues[0].status, 'todo');
});
test('ambiguous failed create is quarantined, including a crash before send; no blind duplicate retry', async () => {
  const f = fixture(); f.failCreate(false); await f.engine().tick();
  f.advance(); await f.engine().tick(); f.advance(); await f.engine().tick();
  assert.equal(f.issues.length, 0);
  assert.equal((await f.engine().status()).videos[video].error, 'ambiguous-create');
});
test('document failure cannot wake an agent; restart resumes cached full transcript without refetching', async () => {
  const f = fixture(); f.failDoc(); await f.engine().tick();
  assert.equal(f.issues[0].assigneeAgentId, null);
  f.advance(); await f.engine().tick();
  assert.equal(f.fetchCount(), 1); assert.equal(f.issues.length, 1); assert.equal(f.issues[0].status, 'todo');
});
test('caption absence retries durably, then creates an unwoken backlog card with explicit retry instructions', async () => {
  const f = fixture(); f.config.maxCaptionAttempts = 2;
  f.io.transcript = async () => { throw new Error('caption-pending'); };
  await f.engine().tick(); assert.equal(f.issues.length, 0);
  f.advance(); await f.engine().tick();
  assert.equal(f.issues.length, 1); assert.equal(f.issues[0].status, 'backlog'); assert.equal(f.issues[0].assigneeAgentId, null);
  f.advance(); await f.engine().tick(); assert.equal(f.issues.length, 1);
});
test('transcripts larger than one document are completely chunked, not truncated', async () => {
  const f = fixture(); const full = 'x'.repeat(650_000);
  f.io.transcript = async () => ({ ...capture, segments: [{ startMs: 0, text: full }] });
  await f.engine().tick();
  const transcript = [...f.docs.values()].filter(d => d.key.startsWith('transcript-')).sort((a,b) => a.key.localeCompare(b.key)).map(d => d.body).join('');
  assert.ok(transcript.includes(full)); assert.ok([...f.docs.values()].every(d => d.body.length < 524288));
});
test('seeded completed videos are not re-researched and unrelated channels cannot enter state', async () => {
  const f = fixture(); f.config.seedVideoIds.push(video);
  await f.engine().tick(); assert.equal(f.issues.length, 0);
  await assert.rejects(f.engine().receive([{ ...parseFeed(atom(), channel)[0], channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' }]));
});
test('migration can start from an explicit corpus marker outside the RSS window', async () => {
  const f = fixture();
  const migrated = parseConfig({ ...f.config, initialLastSeen: 'aVbRSIQO2dE' });
  let recovered = false;
  f.io.recoverGap = async marker => { recovered = true; assert.equal(marker, 'aVbRSIQO2dE'); return parseFeed(atom(), channel); };
  await new FeedWatch(f.ctx, companyId, migrated, f.io).tick();
  assert.equal(recovered, true); assert.equal(f.issues.length, 1);
});
test('caption-blocked card has a one-shot native retry token, preserving the existing issue', async () => {
  const f = fixture(); f.config.maxCaptionAttempts = 2;
  f.io.transcript = async () => { throw new Error('caption-pending'); };
  await f.engine().tick(); f.advance(); await f.engine().tick();
  f.config.retryRequests[video] = companyId;
  f.io.transcript = async () => capture;
  f.advance(); await f.engine().tick(); await f.engine().tick();
  assert.equal(f.issues.length, 1); assert.equal(f.issues[0].status, 'todo');
});
test('researcher-authored initial plan is never silently overwritten or assigned on conflict', async () => {
  const f = fixture(); f.failCreate(true); await f.engine().tick();
  f.docs.set('issue-0:plan', { body: 'human-authored instructions' });
  f.advance(); await f.engine().tick();
  assert.equal(f.docs.get('issue-0:plan').body, 'human-authored instructions');
  assert.equal(f.issues[0].status, 'backlog'); assert.equal((await f.engine().status()).videos[video].error, 'document-conflict');
});
test('well-formed video IDs that coincide with Object prototype keys remain ordinary records', async () => {
  const f = fixture(); f.io.rss = async () => parseFeed(atom(['constructor']), channel);
  await f.engine().tick();
  assert.equal(f.issues.length, 1);
});
