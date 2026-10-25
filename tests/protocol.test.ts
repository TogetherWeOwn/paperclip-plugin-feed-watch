import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, parseCaptions } from '../src/feed.ts';
import { sign, verify, signedHeaders, authenticate, digest } from '../src/crypto.ts';
import { parseConfig } from '../src/config.ts';

import { atom, channel, video } from './fixtures.ts';

test('disabled is the default; an enabled config requires deliberate scope and bootstrap boundary', () => {
  assert.equal(parseConfig({}).enabled, false);
  assert.throws(() => parseConfig({ enabled: true }));
});
test('RSS extracts IDs, decoded title and canonical URLs, not untrusted link URLs', () => {
  const [entry] = parseFeed(atom(), channel);
  assert.equal(entry.videoId, video);
  assert.equal(entry.title, 'Research & testing');
  assert.equal(entry.url, `https://www.youtube.com/watch?v=${video}`);
  assert.equal(parseFeed('<feed/>', channel).length, 0);
});
test('XML rejects entities, mismatched channels, malformed IDs and oversize inputs', () => {
  for (const xml of ['<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed/>', atom([video], 'UCaaaaaaaaaaaaaaaaaaaaaa'), atom(['../../admin']), atom() + 'x', ' '.repeat(300_000)]) {
    assert.throws(() => parseFeed(xml, channel));
  }
});
test('parse complete srv3 and json3 captions including nested segments and timestamps', () => {
  assert.deepEqual(parseCaptions('<timedtext><body><p t="1234" d="2000"><s>Hello</s><s> world &amp; friends</s></p></body></timedtext>'), [{ startMs: 1234, text: 'Hello world & friends' }]);
  assert.deepEqual(parseCaptions(JSON.stringify({ events: [{ tStartMs: 3456, segs: [{ utf8: 'A' }, { utf8: ' B' }] }] })), [{ startMs: 3456, text: 'A B' }]);
});
test('WebSub HMAC verifies original bytes for SHA-1 and SHA-256 and fails closed', async () => {
  for (const algorithm of ['SHA-1', 'SHA-256'] as const) {
    const hmac = await sign('secret-for-tests-only', atom(), algorithm);
    assert.equal(await verify('secret-for-tests-only', atom(), hmac), true);
    assert.equal(await verify('secret-for-tests-only', `${atom()} `, hmac), false);
  }
  for (const bad of ['', 'md5=abc', 'sha1=z'.repeat(20), 'sha256=ab']) assert.equal(await verify('s', 'body', bad), false);
});
test('internal HMAC binds method, path, exact JSON and a bounded timestamp (not a reusable bearer)', async () => {
  const body = JSON.stringify({ channelId: channel });
  const headers = await signedHeaders('test-internal-key', 'POST', '/api/inbox', body, 1_000_000);
  await authenticate('test-internal-key', 'POST', '/api/inbox', body, headers, 1_000_000);
  await assert.rejects(authenticate('test-internal-key', 'GET', '/api/inbox', body, headers, 1_000_000));
  await assert.rejects(authenticate('test-internal-key', 'POST', '/api/inbox', body + ' ', headers, 1_000_000));
  await assert.rejects(authenticate('test-internal-key', 'POST', '/api/inbox', body, headers, 1_301_000));
  assert.equal((await digest('abc')).length, 64);
});
