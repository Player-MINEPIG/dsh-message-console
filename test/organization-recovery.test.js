import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';

const analysis = { summary: '需要维护者审核', reason: '已确认依据', importance: 2, urgent: false, intervention: 'review', evidence: 'confirmed' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-recovery-'));
  const store = await new Store(directory).start();
  const rows = [1, 2].map(id => ({ remoteId: `pr:${id}`, kind: 'pr', title: `PR ${id}`, body: 'body', payload: { files: [{ path: 'a.js', patch: '变更甲乙丙', additions: 1 }, { path: 'binary.png' }] } }));
  let fail = true, calls = 0;
  const executor = { analyze: async () => { calls++; if (fail) throw new Error('synthetic failure'); return analysis; } };
  const service = new ConsoleService({ store, executor, connectors: { github: { fetch: async () => ({ complete: true, items: rows }) } }, workspaces: { resolve: async id => ({ id, path: directory }) } });
  const source = await service.saveSource({ name: 'fixture', platform: 'github', target: 'owner/repo', types: ['pr'], workspaceId: 'ws' });
  await service.refresh(source.id, { organize: false });
  const id = service.items(source.id).items[0].id;
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, service, source, id, rows, executor, get calls() { return calls; }, succeed() { fail = false; } };
}

test('manual no-action acknowledges a failure without clearing it or resuming automatic retries', async t => {
  const f = await fixture(t), original = f.service.item(f.id);
  await f.service.organizeItem(f.id, { version: original.version });
  const failure = f.service.item(f.id).organizationError;
  await f.service.setHandling(f.id, 'none');
  for (let pass = 0; pass < 2; pass++) {
    const item = f.service.item(f.id);
    assert.equal(item.handling, 'none'); assert.equal(item.needsHandling, false);
    assert.equal(item.attentionAcknowledged, true); assert.equal(item.readVersion, original.readVersion);
    assert.deepEqual(item.organizationError, failure); assert.equal(item.autoOrganizationPaused, true);
    assert.equal(f.service.items(f.source.id, { filter: 'handling' }).total, 0);
    await f.store.close(); await f.store.start();
  }
  await f.service.organize(f.source.id); assert.equal(f.calls, 1);
  await f.service.organizeItem(f.id, { version: original.version });
  assert.equal(f.service.item(f.id).needsHandling, true);
});

test('manual no-action acknowledges review until a new analysis requires attention', async t => {
  const f = await fixture(t); f.succeed();
  const item = f.service.item(f.id);
  await f.service.organizeItem(f.id, { version: item.version });
  await f.service.setHandling(f.id, 'none');
  assert.equal(f.service.item(f.id).needsHandling, false);
  assert.equal(f.service.item(f.id).analysis.intervention, 'review');
  await f.service.organizeItem(f.id, { version: item.version });
  assert.equal(f.service.item(f.id).needsHandling, true);
});

test('upgrade repairs an existing manual no-action after failure without dismissing untouched errors', async t => {
  const f = await fixture(t);
  for (const item of f.service.items(f.source.id).items) await f.service.organizeItem(item.id, { version: item.version });
  await f.service.setHandling(f.id, 'none');
  await f.store.close();
  const db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  db.prepare("DELETE FROM meta WHERE key='manual-no-action-v1'").run();
  db.prepare('UPDATE items SET acknowledged_attention_version=0 WHERE id=?').run(f.id);
  const error = db.prepare('SELECT data FROM items WHERE id=?').get(f.id).data;
  db.close(); await f.store.start();
  assert.equal(f.service.item(f.id).needsHandling, false);
  assert.equal(f.service.item(f.id).autoOrganizationPaused, true);
  assert.deepEqual(f.service.item(f.id).organizationError, JSON.parse(error).organizationError);
  const remaining = f.service.items(f.source.id, { filter: 'handling' });
  assert.equal(remaining.total, 1); assert.notEqual(remaining.items[0].id, f.id);
});

test('failed item becomes actionable, pauses across fetches/restarts, and only explicit retry resumes it', async t => {
  const f = await fixture(t);
  let item = f.service.item(f.id);
  const failed = await f.service.organizeItem(f.id, { version: item.version });
  assert.equal(failed.failed, 1);
  item = f.service.item(f.id);
  assert.equal(item.handling, 'pending'); assert.equal(item.needsHandling, true);
  assert.equal(item.organizationError.message, 'synthetic failure'); assert.equal(item.autoOrganizationPaused, true);
  assert.equal(f.service.items(f.source.id, { filter: 'handling' }).total, 1);
  await f.service.dismissOrganizationWarning(f.source.id, { reportId: failed.id });
  await f.service.organize(f.source.id); assert.equal(f.calls, 1);
  await f.service.markRead(f.id, item.version); await f.service.setHandling(f.id, 'done');
  f.rows[0].body = 'new change'; f.rows[1].body = 'new change';
  await f.service.refresh(f.source.id, { organize: false });
  assert.equal(f.store.candidates(f.source.id, 'history').refs.some(row => row.id === f.id), false);
  await f.store.close(); await f.store.start();
  item = f.service.item(f.id);
  assert.equal(item.autoOrganizationPaused, true); assert.ok(item.organizationError);
  assert.throws(() => f.service.organizeItem(f.id, { version: 'obsolete' }), /内容已更新/);
  assert.throws(() => f.service.setAutomation(f.id, { paused: false }), /重新整理/);
  f.succeed(); const result = await f.service.organizeItem(f.id, { version: item.version });
  assert.equal(result.completed, 1); assert.equal(f.calls, 2);
  item = f.service.item(f.id);
  assert.equal(item.organizationError, null); assert.equal(item.autoOrganizationPaused, false);
  assert.equal(item.handling, 'pending'); assert.equal(item.needsHandling, true);
  assert.equal(f.service.item(f.id).analysis.intervention, 'review');
  assert.equal(f.service.runs(f.id).items.some(run => run.status === 'failed'), true);
});

test('single-item retry shares source lock, does not process siblings, and successful existing analysis can be rerun', async t => {
  const f = await fixture(t); f.succeed();
  let release;
  f.executor.analyze = () => new Promise(resolve => { release = () => resolve(analysis); });
  const item = f.service.item(f.id), retry = f.service.organizeItem(f.id, { version: item.version });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.organizeItem(f.id, { version: item.version }), /正在刷新或整理/);
  await assert.rejects(f.service.refresh(f.source.id), /正在刷新或整理/);
  assert.throws(() => f.service.setAutomation(f.id, { paused: true }), /正在刷新或整理/);
  release(); await retry;
  assert.equal(f.service.runs(f.id).total, 1);
  const sibling = f.service.items(f.source.id).items.find(row => row.id !== f.id);
  assert.equal(f.service.runs(sibling.id).total, 0);
  f.executor.analyze = async () => analysis;
  await f.service.organizeItem(f.id, { version: item.version });
  assert.equal(f.service.runs(f.id).total, 2);
  assert.equal(f.service.runs(sibling.id).total, 0);
});

test('legacy review/later and current failures migrate once without erasing analysis, source snapshots or explicit done', async t => {
  const f = await fixture(t); f.succeed();
  const item = f.service.item(f.id);
  await f.service.organizeItem(f.id, { version: item.version });
  await f.store.close();
  const db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  db.prepare("DELETE FROM meta WHERE key='organization-recovery-v1'").run();
  db.prepare("UPDATE items SET handling='none' WHERE id=?").run(f.id);
  const before = db.prepare('SELECT analysis FROM items WHERE id=?').get(f.id).analysis;
  db.close(); await f.store.start();
  assert.equal(f.service.item(f.id).handling, 'pending');
  assert.deepEqual(f.service.item(f.id).analysis, JSON.parse(before));
  await f.service.setHandling(f.id, 'done');
  await f.store.close(); await f.store.start();
  assert.equal(f.service.item(f.id).handling, 'done');
  await assert.rejects(f.service.setHandling(f.id, 'later'), /处理状态无效/);
});

test('PR files are paged without patches and a named patch is read in bounded Unicode chunks', async t => {
  const f = await fixture(t), item = f.service.item(f.id);
  const files = f.service.files(f.id, item.version, { pageSize: 10 });
  assert.equal(files.total, 2); assert.equal(files.items[0].patchAvailable, true);
  assert.equal(files.items[1].patchAvailable, false); assert.equal('patch' in files.items[0], false);
  const first = f.service.content(f.id, { section: 'file', filePath: 'a.js', length: 2 });
  assert.equal(first.text, '变更'); assert.equal(first.nextOffset, 2);
  const next = f.service.content(f.id, { section: 'file', filePath: 'a.js', offset: 2, length: 10 });
  assert.equal(next.text, '甲乙丙'); assert.equal(next.complete, true);
  assert.equal(f.service.content(f.id, { section: 'file', filePath: 'binary.png' }).available, false);
  assert.throws(() => f.service.content(f.id, { section: 'file', filePath: '../../secret' }), /已采集文件不存在/);
  assert.throws(() => f.service.content(f.id, { section: 'file', filePath: 'a.js', length: 32001 }), /参数无效/);
});

test('successful no-action retry clears error-owned pending but preserves a user-selected pending state', async t => {
  const f = await fixture(t), item = f.service.item(f.id);
  await f.service.organizeItem(f.id, { version: item.version });
  f.executor.analyze = async () => ({ ...analysis, intervention: 'none', importance: 0 });
  await f.service.organizeItem(f.id, { version: item.version });
  assert.equal(f.service.item(f.id).handling, 'none'); assert.equal(f.service.item(f.id).needsHandling, false);
  f.executor.analyze = async () => { throw new Error('second failure'); };
  await f.service.organizeItem(f.id, { version: item.version });
  await f.service.setHandling(f.id, 'pending');
  f.executor.analyze = async () => ({ ...analysis, intervention: 'none', importance: 0 });
  await f.service.organizeItem(f.id, { version: item.version });
  assert.equal(f.service.item(f.id).handling, 'pending'); assert.equal(f.service.item(f.id).needsHandling, true);
});

test('migration never resurrects a failure after a later adopted analysis revision', async t => {
  const f = await fixture(t), item = f.service.item(f.id);
  await f.service.organizeItem(f.id, { version: item.version });
  const failed = f.store.runs(f.id).items[0];
  f.store.bindSession({ sessionId: 'reviewer', runId: failed.id, role: 'review', itemId: f.id, sourceId: f.source.id, workspaceId: 'ws', cwd: f.directory });
  await f.service.reviseAnalysisFromSession({ sessionId: 'reviewer', actualCwd: f.directory, callId: 'revise' }, { operationKey: 'later-success', analysis, reason: 'later report' });
  assert.equal(f.service.item(f.id).organizationError, null);
  await f.store.close();
  const db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  db.prepare("DELETE FROM meta WHERE key='organization-recovery-v1'").run(); db.close();
  await f.store.start();
  assert.equal(f.service.item(f.id).organizationError, null);
});
