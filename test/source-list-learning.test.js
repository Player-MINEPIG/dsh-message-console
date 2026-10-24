import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { ConsoleService, fingerprint } from '../src/core.js';
import { createHandler } from '../src/http.js';

const analysis = { summary: '保留的分析', importance: 1, urgent: false, intervention: 'none' };
const entry = (id, extra = {}) => ({ remoteId: id, kind: 'issue', title: id, body: '正文', payload: { state: 'open' }, ...extra });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-source-list-')), store = await new Store(directory).start();
  const analyzed = [], fetched = [], rows = new Map();
  const service = new ConsoleService({ store, clock: () => Date.parse('2026-10-19T12:00:00Z'), connectors: { github: { status: () => ({ ready: true }), fetch: async source => { fetched.push(source.id); return { complete: true, items: rows.get(source.id) ?? [] }; } } }, executor: { analyze: async request => { analyzed.push(request); return analysis; } }, workspaces: { resolve: async id => ({ id, path: directory }) } });
  const source = await service.saveSource({ name: 'A', platform: 'github', target: 'o/a', types: ['issue', 'pr', 'release'], workspaceId: 'ws' });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const adopt = (itemId, result = analysis) => {
    const item = store.item(itemId), source = store.source(item.sourceId), run = { id: `run-${itemId}-${item.analysisRevision}`, itemId, sourceId: source.id, version: item.version, workspaceId: 'ws', sourceContextVersion: source.contextVersion, contextVersion: source.contextVersion, baseAnalysisRevision: item.analysisRevision, status: 'completed', startedAt: '2026-10-19T01:00:00Z' };
    store.createRun(run); assert.equal(store.adoptResult(run.id, result), true); return run;
  };
  return { directory, store, service, source, rows, analyzed, fetched, adopt };
}
async function post(service, path) {
  const req = Readable.from([Buffer.from('{}')]);
  Object.assign(req, { method: 'POST', url: `/api/dsh-message-console/${path}`, headers: { 'content-type': 'application/json', 'x-dsh-message-console': '1' } });
  let code, result;
  await createHandler(service, () => ({}))(req, { writeHead(status) { code = status; }, end(text) { result = JSON.parse(text); } });
  assert.equal(code, 200); return result;
}

test('source list includes all GitHub states and applies search and status filters before pagination and preserves priority in both time directions', async t => {
  const f = await fixture(t), id = remote => `${f.source.id}:${remote}`;
  f.store.applyFetch(f.source.id, [], {}, '2026-01-01', fingerprint);
  const rows = Array.from({ length: 24 }, (_, i) => entry(`open-${String(i).padStart(2, '0')}`, { updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  rows.push(entry('closed', { payload: { state: 'CLOSED' } }), entry('merged', { kind: 'pr', payload: { state: 'MERGED' } }), entry('merged-flag', { kind: 'pr', payload: { state: 'open', merged: true } }), entry('release', { kind: 'release', payload: { publishedAt: '2025-01-01T00:00:00Z' } }));
  f.store.applyFetch(f.source.id, rows, {}, '2026-10-19T01:00:00Z', fingerprint);
  f.adopt(id('open-02'), { ...analysis, importance: 3 });
  f.adopt(id('open-03'), { ...analysis, importance: 2 });
  f.store.handling(id('open-01'), 'pending'); f.store.handling(id('open-03'), 'pending'); f.store.handling(id('closed'), 'pending');
  for (const order of ['updated-desc', 'updated-asc']) {
    const first = f.service.items(f.source.id, { order });
    assert.equal(first.total, 28); assert.equal(first.pageCount, 3);
    assert.equal(first.items[0].remoteId,'open-03');
    assert.deepEqual(new Set(first.items.slice(1,3).map(item=>item.remoteId)),new Set(['open-01','closed']));
    assert.equal(first.items[3].remoteId,'open-02');
    const all = [1, 2, 3].flatMap(page => f.service.items(f.source.id, { page, order }).items);
    assert.equal(new Set(all.map(item => item.id)).size, 28);
    assert.ok(['closed','merged','merged-flag'].every(id=>all.some(item=>item.remoteId===id)));
    assert.equal(f.service.items(f.source.id, { filter: 'handling', order }).total, 3);
    const shown = f.service.items(f.source.id, { filter: 'handling', order, showClosed: 'true' });
    assert.equal(shown.total, 3); assert.equal(shown.items[0].remoteId, 'open-03');
  }
  assert.equal(f.service.items(f.source.id, { page: 99 }).page, 3);
  assert.equal(f.service.items(f.source.id, { showClosed: true }).total, 28);
  assert.equal(f.service.items(f.source.id, { q: 'merged' }).total, 2);
  assert.equal(f.service.items(f.source.id, { q: 'merged', showClosed: true }).total, 2);
  assert.equal(f.store.items(f.source.id).total, 28, 'internal tools retain access to all collected items');
  f.store.markRead(id('open-01')); f.store.handling(id('open-03'), 'done');
  const unread = f.service.items(f.source.id, { filter: 'unread' });
  assert.equal(unread.total, 27); assert.equal(unread.items[0].remoteId, 'closed');
  assert.equal(f.service.items(f.source.id, { filter: 'handling' }).total, 2);
  assert.throws(() => f.service.items(f.source.id, { order: 'unsafe' }), /参数/);
  assert.equal(f.service.items(f.source.id, { showClosed: false }).total,28,'old clients cannot hide closed items');
});

test('platform timestamp enrichment updates ordering without changing content versions, analysis, read state or attention', async t => {
  const f = await fixture(t), row = entry('old'), id = `${f.source.id}:old`;
  f.store.applyFetch(f.source.id, [row], {}, '2026-10-18T01:00:00Z', fingerprint); f.adopt(id);
  const before = f.store.item(id), at = '2026-01-01T00:00:00Z';
  f.store.applyFetch(f.source.id, [{ ...row, updatedAt: at }], {}, '2026-10-19T00:00:00Z', fingerprint);
  const enriched = f.store.item(id);
  for (const key of ['version', 'readVersion', 'analyzedVersion', 'analysisRevision', 'attentionVersion', 'handling', 'changedAt']) assert.deepEqual(enriched[key], before[key]);
  assert.deepEqual(enriched.analysis, before.analysis); assert.equal(enriched.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(f.service.items(f.source.id).items[0].updatedAt, enriched.updatedAt); assert.equal(f.store.versions(id).total, 1);
  f.store.applyFetch(f.source.id, [{ ...row, updatedAt: at }], {}, '2026-10-20T00:00:00Z', fingerprint);
  assert.deepEqual(f.store.item(id), enriched);
  f.store.applyFetch(f.source.id, [entry('fallback', { updatedAt: 'invalid' })], {}, '2026-10-19T01:00:00Z', fingerprint);
  assert.equal(f.service.items(f.source.id).items.find(item => item.remoteId === 'fallback').updatedAt, '2026-10-19T01:00:00.000Z');
});

test('HTTP source A actions do not fetch or organize B; independent scheduler work records scheduled trigger', async t => {
  const f = await fixture(t), b = await f.service.saveSource({ ...f.source, name: 'B', target: 'o/b' });
  for (const source of [f.source, b]) { f.rows.set(source.id, [entry('one')]); await f.service.refresh(source.id, { organize: false }); }
  f.fetched.length = 0;
  const report = await post(f.service, `sources/${f.source.id}/organize`);
  assert.equal(report.trigger, 'manual'); assert.deepEqual(f.analyzed.map(call => call.source.id), [f.source.id]);
  assert.equal(f.store.runs(`${b.id}:one`).total, 0); assert.deepEqual(f.fetched, []);
  f.rows.set(f.source.id, [entry('one', { body: 'A新变化' })]);
  await post(f.service, `sources/${f.source.id}/refresh`);
  assert.deepEqual(f.fetched, [f.source.id]); assert.equal(f.store.runs(`${b.id}:one`).total, 0);
  assert.equal(f.store.runs(`${f.source.id}:one`).items[0].trigger, 'manual');
  f.rows.set(b.id, [entry('one', { body: 'B新变化' })]); f.store.updateSource(b.id, { fetchedAt: '2026-01-01', organizedAt: '2026-01-01' });
  await f.service.tick();
  assert.equal(f.store.runs(`${b.id}:one`).items[0].trigger, 'scheduled');
  assert.equal(f.service.source(b.id).lastOrganization.trigger, 'scheduled');
});

test('learning guidance preserves current analysis and completion while future versions use new guidance and old in-flight results fail CAS', async t => {
  const f = await fixture(t), id = `${f.source.id}:one`;
  f.rows.set(f.source.id, [entry('one')]); await f.service.refresh(f.source.id, { organize: false }); f.adopt(id);
  f.service.saveFeedback(id, { text: '完成并学习', expectedRevision: 0, itemVersion: f.store.item(id).version, analysisRevision: f.store.item(id).analysisRevision });
  const before = f.store.item(id), oldSource = f.store.source(f.source.id);
  const inflight = { id: 'inflight', sourceId: f.source.id, itemId: id, version: before.version, sourceContextVersion: oldSource.contextVersion, contextVersion: oldSource.contextVersion, workspaceId: 'ws', baseAnalysisRevision: before.analysisRevision, status: 'running' };
  f.store.createRun(inflight);
  await f.service.configure({ learningGuidance: '新的全局指导' });
  await f.service.saveSource({ ...f.service.source(f.source.id), context: '新的来源背景' }, f.source.id);
  for (const scope of ['changes', 'history']) assert.equal((await f.service.organize(f.source.id, { scope })).candidates, 0);
  const after = f.store.item(id);
  for (const key of ['analysis', 'analyzedVersion', 'analyzedContextVersion', 'analysisRevision', 'readVersion', 'handling', 'attentionVersion', 'acknowledgedAttentionVersion']) assert.deepEqual(after[key], before[key]);
  assert.equal(f.service.items(f.source.id).items[0].analysis.summary, analysis.summary);
  assert.equal(f.service.feedback(id).text, '完成并学习'); assert.equal(f.store.adoptResult(inflight.id, { ...analysis, summary: '过期结果' }), false);
  f.rows.set(f.source.id, [entry('one', { body: '真实新内容' }), entry('unorganized')]); await f.service.refresh(f.source.id);
  assert.equal(f.analyzed.length, 2); assert.ok(f.analyzed.every(call => call.source.learningGuidance === '新的全局指导' && call.source.context === '新的来源背景'));
});

test('startup repairs only proven same-version adopted analysis and preserves completion; repeated startup is idempotent', async t => {
  const f = await fixture(t);
  f.store.applyFetch(f.source.id, ['valid', 'changed', 'unknown', 'different'].map(id => entry(id)), {}, '2026-01-01', fingerprint);
  for (const remote of ['valid', 'changed', 'different']) f.adopt(`${f.source.id}:${remote}`);
  const valid = `${f.source.id}:valid`; f.store.handling(valid, 'done');
  const before = f.store.item(valid);
  f.store.applyFetch(f.source.id, [entry('changed', { body: 'new version' })], {}, '2026-02-01', fingerprint);
  await f.store.close();
  const db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  db.exec('UPDATE items SET analyzed_version=NULL');
  db.prepare('UPDATE items SET analysis=? WHERE id=?').run(JSON.stringify({ ...analysis, summary: '无实际已采纳记录' }), `${f.source.id}:unknown`);
  db.prepare('UPDATE items SET analysis=? WHERE id=?').run(JSON.stringify({ ...analysis, summary: '不同结果' }), `${f.source.id}:different`); db.close();
  await f.store.start();
  assert.equal(f.store.item(valid).analyzedVersion, before.version);
  for (const key of ['analysisRevision', 'analyzedContextVersion', 'readVersion', 'handling', 'attentionVersion', 'acknowledgedAttentionVersion']) assert.deepEqual(f.store.item(valid)[key], before[key]);
  for (const remote of ['changed', 'unknown', 'different']) assert.equal(f.store.item(`${f.source.id}:${remote}`).analyzedVersion, null);
  await f.store.close(); await f.store.start();
  const check = new DatabaseSync(join(f.directory, 'console.sqlite'), { readOnly: true });
  const events = check.prepare("SELECT data FROM audit WHERE event='analysis.restored'").all(); check.close();
  assert.equal(events.length, 1); assert.equal(JSON.parse(events[0].data).count, 1);
});
