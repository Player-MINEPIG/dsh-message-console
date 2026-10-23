import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const workflowPath = '.github/workflows/ci.yml';
export function checkedSha(value) {
  assert.match(value ?? '', /^[a-f0-9]{40}$/, 'A full candidate SHA is required');
  return value;
}
export function checkedId(value) {
  assert.match(String(value ?? ''), /^[1-9]\d*$/, 'A positive run ID is required');
  assert.ok(Number.isSafeInteger(Number(value)));
  return Number(value);
}
export function validateRun(run, repository, candidate, id) {
  assert.equal(run.id, checkedId(id));
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.path, workflowPath);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'dev');
  assert.equal(run.head_sha, checkedSha(candidate));
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  return `candidate-${candidate}-${run.id}-${checkedId(run.run_attempt)}`;
}
export function validatePackage(record, bytes, { repository, candidate, run }) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.repository, repository);
  assert.equal(record.candidateSha, checkedSha(candidate));
  assert.equal(record.runId, String(run.id));
  assert.equal(record.runAttempt, String(run.run_attempt));
  assert.equal(record.name, 'dsh-message-console');
  assert.match(record.filename, /^dsh-message-console-[0-9A-Za-z.+-]+\.tgz$/);
  assert.equal(record.installed, true);
  assert.ok(record.installedFiles > 0);
  assert.equal(record.sha256, createHash('sha256').update(bytes).digest('hex'));
}
export function acceptanceRecord(input) {
  assert.equal(input.confirm, 'true', 'Real acceptance and user confirmation are required');
  for (const name of ['acceptance', 'userConfirmation']) {
    assert.ok(typeof input[name] === 'string' && input[name].trim(), `${name} is required`);
    assert.ok(Buffer.byteLength(input[name]) <= 40000);
  }
  return { acceptance: input.acceptance.trim(), userConfirmation: input.userConfirmation.trim() };
}

async function main(command) {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  assert.equal(repository, 'Player-MINEPIG/dsh-message-console');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  const candidate = checkedSha(env.CANDIDATE_SHA);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ancestor = (a, b) => git('merge-base', '--is-ancestor', checkedSha(a), checkedSha(b));
  if (command === 'verify') {
    assert.equal(env.GITHUB_REF, 'refs/heads/dev');
    assert.equal(env.GITHUB_SHA, candidate, 'Dispatch dev at the exact candidate');
    git('fetch', '--no-tags', 'origin', 'main', 'dev');
    assert.equal(git('rev-parse', 'origin/dev'), candidate);
    ancestor(git('rev-parse', 'origin/main'), candidate);
    return;
  }
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Promotion must use trusted main');
  assert.ok(env.GITHUB_WORKFLOW_REF?.endsWith(`${workflowPath}@refs/heads/main`));
  const runId = checkedId(env.VERIFICATION_RUN_ID);
  async function api(path, method = 'GET', body) {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `GitHub ${method} ${path}: ${response.status}`);
    return response.json();
  }
  const run = await api(`/actions/runs/${runId}`);
  const name = validateRun(run, repository, candidate, runId);
  if (command === 'resolve') {
    const { artifacts } = await api(`/actions/runs/${runId}/artifacts?per_page=100`);
    const matches = artifacts.filter(item => item.name === name && !item.expired);
    assert.equal(matches.length, 1, 'One retained candidate archive is required');
    appendFileSync(env.GITHUB_OUTPUT, `artifact_id=${checkedId(matches[0].id)}\n`);
    return;
  }
  assert.ok(command === 'record' || command === 'promote');
  const directory = resolve('.local/ci/candidate');
  const record = JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'));
  assert.match(record.filename ?? '', /^dsh-message-console-[0-9A-Za-z.+-]+\.tgz$/);
  const bytes = readFileSync(join(directory, record.filename));
  validatePackage(record, bytes, { repository, candidate, run });
  const version = JSON.parse(git('show', `${candidate}:package.json`)).version;
  const packed = JSON.parse(execFileSync('tar', ['-xOf', join(directory, record.filename), 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(packed.name, record.name);
  assert.equal(packed.version, record.version);
  assert.equal(record.version, version);
  git('fetch', '--no-tags', 'origin', 'main', 'dev');
  ancestor(candidate, git('rev-parse', 'origin/dev'));
  ancestor(git('rev-parse', 'origin/main'), candidate);
  const receipt = { candidate: record, verificationRunId: runId,
    ...acceptanceRecord({ confirm: env.CONFIRM, acceptance: env.ACCEPTANCE_RECORD, userConfirmation: env.USER_CONFIRMATION }),
    actor: env.GITHUB_ACTOR, runId: checkedId(env.GITHUB_RUN_ID), runAttempt: checkedId(env.GITHUB_RUN_ATTEMPT) };
  const receiptPath = join(directory, 'promotion.json');
  if (command === 'record') {
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    return;
  }
  assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf8')), receipt);
  const { artifacts } = await api(`/actions/runs/${checkedId(env.GITHUB_RUN_ID)}/artifacts?per_page=100`);
  const artifact = artifacts.find(item => item.id === checkedId(env.RECORD_ARTIFACT_ID));
  assert.equal(artifact?.name, `promotion-${candidate}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  assert.equal(artifact.expired, false);
  assert.ok(artifact.size_in_bytes > 0);
  assert.match(env.RECORD_ARTIFACT_DIGEST ?? '', /^[a-f0-9]{64}$/);
  assert.equal(artifact.digest, `sha256:${env.RECORD_ARTIFACT_DIGEST}`);
  await api(`/statuses/${candidate}`, 'POST', { state: 'success', context: 'Release approved',
    description: 'Acceptance and actual user confirmation recorded',
    target_url: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}` });
  git('push', 'origin', `${candidate}:refs/heads/main`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
