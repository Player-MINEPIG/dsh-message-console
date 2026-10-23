import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { acceptanceRecord, validatePackage, validateRun } from '../scripts/ci/promote.js';

const repository = 'Player-MINEPIG/dsh-message-console';
const candidate = 'a'.repeat(40);
const run = { id: 17, repository: { full_name: repository }, head_repository: { full_name: repository },
  path: '.github/workflows/ci.yml', event: 'workflow_dispatch', head_branch: 'dev', head_sha: candidate,
  status: 'completed', conclusion: 'success', run_attempt: 2 };

test('main promotion accepts only the successful manual verification of the exact dev candidate', () => {
  assert.equal(validateRun(run, repository, candidate, 17), `candidate-${candidate}-17-2`);
  for (const patch of [
    { event: 'pull_request' }, { head_branch: 'main' }, { head_sha: 'b'.repeat(40) },
    { conclusion: 'failure' }, { status: 'in_progress' }, { id: 18 },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/repo' } },
    { head_repository: { full_name: 'fork/repo' } }, { run_attempt: 0 },
  ]) assert.throws(() => validateRun({ ...run, ...patch }, repository, candidate, 17));
});

test('promotion rejects a replaced archive, stale attempt, missing installation and different source', () => {
  const bytes = Buffer.from('tested archive');
  const record = { schemaVersion: 1, repository, candidateSha: candidate, runId: '17', runAttempt: '2',
    name: 'dsh-message-console', filename: 'dsh-message-console-0.1.11.tgz', version: '0.1.11',
    sha256: createHash('sha256').update(bytes).digest('hex'), installedFiles: 49, installed: true };
  validatePackage(record, bytes, { repository, candidate, run });
  assert.throws(() => validatePackage(record, Buffer.from('replacement'), { repository, candidate, run }));
  for (const patch of [{ runAttempt: '1' }, { installed: false }, { candidateSha: 'b'.repeat(40) },
    { filename: '../../package.tgz' }, { name: 'other-plugin' }, { runId: '16' }]) {
    assert.throws(() => validatePackage({ ...record, ...patch }, bytes, { repository, candidate, run }));
  }
});

test('promotion requires explicit acceptance and actual user approval text', () => {
  const input = { confirm: 'true', acceptance: 'Linux acceptance evidence', userConfirmation: 'Actual user instruction' };
  assert.deepEqual(acceptanceRecord(input), { acceptance: input.acceptance, userConfirmation: input.userConfirmation });
  for (const patch of [{ confirm: 'false' }, { acceptance: '' }, { userConfirmation: ' ' }]) {
    assert.throws(() => acceptanceRecord({ ...input, ...patch }));
  }
});
