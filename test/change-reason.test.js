import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { reasonText } from '../src/change-reason.js';

const reply = (id, body = `楼内问题 ${id}`) => ({ id, author: `观众${id}`, body, parent: 'root' });
const result = choice => ({ processing: 'decision-only', summary: '本轮处理建议', importance: choice === 'human' ? 2 : 0, urgent: false, reason: '依据已采集对话', intervention: choice === 'human' ? 'human' : 'none', evidence: 'inferred', decision: { choice } });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-change-reason-')), store = await new Store(directory).start();
  let clock = Date.parse('2026-10-21T00:00:00Z'), choice = 'ignore', fail = false;
  const entry = { remoteId: 'root', kind: 'comment', title: '根评论已处理', body: '根评论正文', payload: { video: { title: '合成视频' }, comments: [reply('old')] } };
  const service = new ConsoleService({ store, clock: () => clock, connectors: { bilibili: { status: () => ({ ready: true }), fetch: async () => ({ complete: true, items: [structuredClone(entry)] }) } }, executor: { analyze: async () => { if (fail) throw new Error('合成失败'); return result(choice); } }, workspaces: { resolve: async id => ({ id, path: directory }) } });
  const source = await service.saveSource({ workspaceId: 'ws', name: '合成来源', platform: 'bilibili', target: 'BV1111111111', types: ['comment'] });
  const id = `${source.id}:root`;
  const fetch = async () => { clock += 60000; return service.refresh(source.id, { organize: false }); };
  const organize = async () => { clock += 60000; return service.organize(source.id, { trigger: 'scheduled' }); };
  await fetch(); await service.organize(source.id, { scope: 'history' });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, service, source, id, entry, fetch, organize, choice: value => { choice = value; }, fail: value => { fail = value; }, card: () => service.items(source.id).items[0], runs: () => service.runs(id).items };
}

test('reply-only changes retain root identity and show changed replies and before/after suggestions after scheduled organization', async t => {
  const f = await fixture(t), originalRun = structuredClone(f.store.run(f.runs()[0].id));
  await f.service.setHandling(f.id, 'done');
  f.entry.payload.comments.push(reply('new')); f.choice('human'); await f.fetch();
  const pending = f.card(); assert.equal(pending.organization.pending, true); assert.equal(pending.title, '根评论已处理');
  await f.organize();
  const card = f.card(), reason = card.organization.reason;
  assert.equal(reason.rootChanged, false); assert.equal(reason.contextChanged, false);
  assert.equal(reason.comments.added, 1); assert.equal(reason.comments.samples[0].excerpt, '楼内问题 new');
  assert.equal(reason.previousConclusion, 'ignore'); assert.equal(card.organization.conclusion, 'human');
  assert.match(reasonText(reason), /楼中楼新增 1 条/);
  assert.deepEqual(f.runs()[0].triggerReason, reason); assert.equal(f.runs()[0].trigger, 'scheduled');
  assert.deepEqual(f.store.run(originalRun.id), originalRun, 'old run stays immutable');
  await f.store.close(); await f.store.start(); assert.deepEqual(f.card().organization, card.organization);
  const count = f.runs().length; await f.organize(); assert.equal(f.runs().length, count, 'unchanged version does not rerun');
});

test('missing replies show historical content, retain their old version for full-text access and reconstruct old runs without rewriting them', async t => {
  const f = await fixture(t), oldVersion = f.card().version;
  f.entry.payload.comments = []; await f.fetch(); await f.organize();
  const latest = f.runs()[0], frozen = structuredClone(f.store.run(latest.id));
  assert.equal(latest.triggerReason.comments.removed, 1);
  const sample = latest.triggerReason.comments.samples[0]; assert.equal(sample.version, oldVersion); assert.equal(sample.change, 'removed');
  assert.equal(f.service.content(f.id, { section: 'comment', commentId: sample.id, version: sample.version }).text, '楼内问题 old');
  const page = f.service.changedComments(f.id, { version: latest.version, baseVersion: oldVersion });
  assert.equal(page.total, 1); assert.equal(page.items[0].change, 'removed');
  const db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  db.prepare("UPDATE runs SET data=json_remove(data,'$.triggerReason') WHERE item_id=?").run(f.id); db.close();
  const legacyBefore = structuredClone(f.store.run(latest.id)), restored = f.card().organization.reason;
  assert.equal(restored.inferred, true); assert.equal(restored.comments.removed, 1); assert.equal(restored.rootChanged, false);
  assert.equal(restored.previousConclusion, 'ignore');
  assert.deepEqual(f.store.run(latest.id), legacyBefore, 'read-time reconstruction never rewrites historical runs');
  assert.equal(f.runs().find(r => r.id === frozen.id).triggerReason.comments.removed, 1);
  assert.equal(f.runs().find(r => r.id !== frozen.id).triggerReason.kind, 'unknown');
  assert.equal(f.service.item(f.id, oldVersion).organization, null, 'historical header does not borrow current cause');
});

test('multiple fetches compare against last organized version, retries keep causal evidence and samples stay bounded', async t => {
  const f = await fixture(t), oldVersion = f.card().version;
  f.entry.payload.comments[0].body = '已修改'; f.entry.payload.comments.push(reply('first')); await f.fetch();
  f.entry.payload.comments.push(...Array.from({ length: 15 }, (_, i) => reply(`next-${i}`, '长回复'.repeat(1000)))); await f.fetch();
  f.fail(true); await f.organize(); f.fail(false); await f.organize();
  assert.equal(f.runs()[0].status, 'failed', 'scheduled runs leave failed items paused');
  await f.service.organizeItem(f.id, { version: f.card().version });
  const latest = f.runs()[0], reason = latest.triggerReason;
  assert.equal(reason.baseVersion, oldVersion); assert.equal(reason.comments.added, 16); assert.equal(reason.comments.edited, 1); assert.equal(reason.retry, true);
  assert.equal(reason.comments.samples.length, 3); assert.ok(reason.comments.samples.every(x => Array.from(x.excerpt).length <= 600));
  assert.match(reasonText(reason), /上轮未完成，重试/);
  const pages = [1, 2].flatMap(page => f.service.changedComments(f.id, { version: latest.version, baseVersion: oldVersion, page }).items);
  assert.equal(pages.length, 17); assert.equal(new Set(pages.map(x => x.id)).size, 17);
  f.entry.body = '根内容后来改变'; await f.fetch();
  assert.equal(f.card().organization.reason.rootChanged, true);
  assert.deepEqual(f.runs().find(r => r.id === latest.id).triggerReason, reason, 'run reason survives later fetch');
});

test('root and context changes are separate from reply changes, including a return to an older content version', async t => {
  const f = await fixture(t), original = structuredClone(f.entry);
  f.entry.body = '新正文'; f.entry.payload.video.title = '新视频标题'; await f.fetch(); await f.organize();
  const reason = f.card().organization.reason;
  assert.equal(reason.rootChanged, true); assert.equal(reason.contextChanged, true); assert.equal(reason.comments.added + reason.comments.edited + reason.comments.removed, 0);
  Object.assign(f.entry, original); await f.fetch();
  assert.equal(f.card().organization.pending, true, 'an old successful run for a returned version is not the current analysis');
  assert.equal(f.card().analysis, null);
  assert.throws(() => f.service.changedComments(f.id, { version: f.card().version, baseVersion: 'unrelated-version' }), /内容版本不存在/);
});

test('legacy run time comes from its authoritative column when JSON omitted it', async t => {
  const f = await fixture(t); f.entry.payload.comments = []; await f.fetch(); await f.organize();
  const latest = f.runs()[0], db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  db.prepare("UPDATE runs SET data=json_remove(data,'$.triggerReason','$.startedAt') WHERE item_id=?").run(f.id); db.close();
  assert.equal(f.card().organization.reason.comments.removed, 1);
  assert.equal(f.runs()[0].startedAt, latest.startedAt);
  assert.equal(f.runs()[0].triggerReason.comments.removed, 1);
});
