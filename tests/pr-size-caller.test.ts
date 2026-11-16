import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'pr-size.yml'),
  'utf8',
);

function useRefs(): string[] {
  return [...workflow.matchAll(/uses:\s*TogetherWeOwn\/\.github\/\.github\/workflows\/(pr-size(?:-gate|-weekly)?)\.yml@(\S+)/g)]
    .map((m) => m[2]);
}

test('pr-size caller calls the three org reusables at one pinned full SHA with no floating refs', () => {
  const refs = useRefs();
  assert.equal(refs.length, 3, 'expected exactly three org reusable calls');
  for (const ref of refs) assert.match(ref, /^[0-9a-f]{40}$/, `pin must be a full SHA: ${ref}`);
  assert.equal(new Set(refs).size, 1, 'all three calls must share one pinned org main SHA');
  assert.doesNotMatch(workflow, /uses:.*@(main|master|v\d)/, 'no floating refs');
});

test('pr-size caller keeps advisory jobs outside the required set and grants write scopes only to label and gate', () => {
  assert.match(workflow, /pr-size-gate:/, 'required gate job is present');
  assert.match(workflow, /pr-size-weekly:/, 'weekly tally job is present');
  // exclude-extra is empty: package-lock.json and dist/ are already excluded
  // by the org script's built-in lockfile/dist rules; this repo adds none.
  // (Ignore the commented example value.)
  const assignments = workflow.split('\n').filter((l) => !l.trim().startsWith('#'));
  for (const m of assignments.join('\n').matchAll(/exclude-extra:\s*"([^"]*)"/g)) assert.equal(m[1], '');
  // Least privilege: weekly job grants only read; only label and gate may write.
  const weekly = workflow.slice(workflow.indexOf('pr-size-weekly:'));
  assert.match(weekly, /issues: read/);
  assert.match(weekly, /pull-requests: read/);
  assert.doesNotMatch(weekly, /issues: write/);
  assert.doesNotMatch(workflow, /secrets: inherit/);
});

test('pr-size caller re-evaluates the gate on label and review events', () => {
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, labeled, unlabeled, edited\]/);
  assert.match(workflow, /pull_request_review:/);
  assert.match(workflow, /types: \[submitted, dismissed\]/);
});
