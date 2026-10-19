import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHandler } from '../src/http.js';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { ConsoleService, fingerprint } from '../src/core.js';

const analysis = { summary: '建议关注', importance: 3, urgent: true, urgencyReason: '明日截止', reason: '版本变化', intervention: 'human', evidence: 'confirmed' };
async function fixture(t, count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-learning-'));
  const store = await new Store(directory).start();
  const workspace = await mkdtemp(join(tmpdir(), 'dmc-learning-workspace-'));
  const service = new ConsoleService({ store, connectors: {}, executor: {}, workspaces: { resolve: async id => ({ id, path: workspace }), list: async () => [{ id: 'ws', path: workspace }] } });
  const source = await service.saveSource({ workspaceId: 'ws', name: '评价来源', platform: 'bilibili', target: 'BV1111111111', types: ['comment'], context: '原背景', materials: [{ kind: 'text', name: '原资料', text: '原知识' }] });
  store.applyFetch(source.id, Array.from({ length: count }, (_, index) => ({ remoteId: String(index), kind: 'comment', title: `问题${index}`, body: `原文${index}`, payload: { comments: [{ id: 'c1', author: '观众', body: '原评论' }] } })), {}, new Date().toISOString(), fingerprint);
  const items = () => store.items(source.id, { pageSize: 50 }).items;
  const feedback = item => service.saveFeedback(item.id, { text: '我更关注实际经验', expectedRevision: 0, itemVersion: item.version, analysisRevision: item.analysisRevision });
  for (const row of store.items(source.id, { pageSize: 50 }).items) feedback(row);
  if (count > 50) for (const row of store.items(source.id, { page: 2, pageSize: 50 }).items) feedback(row);
  service.executor.learn = async ({ batchId }) => {
    const batch = store.learning(batchId), sessionId = `learning-${batchId}-${Date.now()}`;
    await service.bindLearningSession({ batchId, sessionId, workspaceId: batch.workspaceId, cwd: workspace });
    const cases = service.readLearningFromSession({ sessionId, actualCwd: workspace }, { section: 'cases' }).items;
    await service.proposeLearningFromSession({ sessionId, actualCwd: workspace, callId: 'propose' }, { operationKey: 'proposal', summary: '调整关注规则', changes: [{ target: 'source', field: 'attentionRules', after: '关注实际经验', caseIds: [cases[0].id] }] });
  };
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); });
  const settled = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const batch = service.learning(id);
      if (!['queued', 'running'].includes(batch.status)) return batch;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('learning did not settle');
  };
  const start = async () => { const batch = await service.startLearning({ sourceId: source.id }); return settled(batch.id); };
  return { service, store, source, items, directory, workspace, settled, start };
}
const approval = batch => ({ proposalRevision: batch.proposal.revision, proposalHash: batch.proposal.hash });

test('learning preserves evaluation revisions, saves a pending diff and applies only after explicit CAS approval', async t => {
  const f = await fixture(t), item = f.items()[0], batch = await f.start();
  assert.equal(batch.status, 'pending');
  assert.equal(batch.proposal.changes[0].before, '');
  assert.equal(f.service.source(f.source.id).attentionRules, '');
  assert.equal(f.service.feedback(item.id).learned, false);
  assert.equal(f.store.runs(item.id).total, 0);
  assert.equal(f.store.sessionBinding(batch.sessionId).role, 'learning');
  assert.equal(f.service.learningList({ sourceId: f.source.id }).unlearnedCount, 1);
  const receipt = await f.service.applyLearning(batch.id, approval(batch));
  assert.equal(receipt.learnedCount, 1);
  assert.equal(f.service.source(f.source.id).attentionRules, '关注实际经验');
  assert.equal(f.service.feedback(item.id).learned, true);
  assert.deepEqual(await f.service.applyLearning(batch.id, approval(batch)), receipt);
  assert.throws(() => f.service.proposeLearningFromSession({ sessionId: batch.sessionId, actualCwd: f.workspace }, { operationKey: 'after-apply', summary: '追问不重开已应用批次', changes: [{ target: 'source', field: 'context', after: '不允许的新背景', caseIds: [batch.cases[0].id] }] }), /此批次不能提交学习建议/);
  assert.equal(f.service.source(f.source.id).context, '原背景');
  await f.store.close(); await f.store.start();
  assert.equal(f.service.learning(batch.id).status, 'applied');
  assert.equal(f.service.feedback(item.id).learned, true);
});

test('withdrawn feedback and changed configuration reject old proposals without consuming evaluations', async t => {
  const f = await fixture(t), batch = await f.start(), item = f.items()[0];
  f.service.saveFeedback(item.id, { text: '', expectedRevision: 1, itemVersion: item.version, analysisRevision: item.analysisRevision });
  await assert.rejects(f.service.applyLearning(batch.id, approval(batch)), /评价已修改或撤回/);
  assert.equal(f.service.source(f.source.id).attentionRules, '');
  assert.equal(f.service.feedback(item.id).learned, false);
  f.service.rejectLearning(batch.id, approval(batch));
  f.service.saveFeedback(item.id, { text: '新的评价', expectedRevision: 2, itemVersion: item.version, analysisRevision: item.analysisRevision });
  const next = await f.start();
  await f.service.saveSource({ ...f.service.source(f.source.id), context: '用户自行调整' }, f.source.id);
  await assert.rejects(f.service.applyLearning(next.id, approval(next)), /配置已变化/);
  assert.equal(f.service.learning(next.id).status, 'pending');
  assert.equal(f.service.feedback(item.id).revision, 3);
  assert.throws(() => f.service.saveFeedback(item.id, { text: '丢失更新', expectedRevision: 2, itemVersion: item.version, analysisRevision: item.analysisRevision }), /评价已变化/);
});

test('learning tools read frozen cases and bounded original content, reject ordinary sessions and forbidden configuration targets', async t => {
  const f = await fixture(t), batch = await f.start(), actor = { sessionId: batch.sessionId, actualCwd: f.workspace }, entry = batch.cases[0];
  assert.equal(f.service.readLearningFromSession(actor, { section: 'body', caseId: entry.id, offset: 1, length: 2 }).text, '文0');
  assert.equal(f.service.readLearningFromSession(actor, { section: 'configuration', target: 'source', field: 'context', length: 1 }).text, '原');
  assert.equal(f.service.readLearningFromSession(actor, { section: 'materials', materialName: '原资料' }).text, '原知识');
  assert.throws(() => f.service.readLearningFromSession(actor, { section: 'case', caseId: 'outside' }), /批次案例/);
  assert.throws(() => f.service.readLearningFromSession({ sessionId: 'ordinary', actualCwd: f.workspace }, { section: 'batch' }), /受管会话绑定/);
  await assert.rejects(f.service.submitFromSession(actor, { kind: 'draft', body: '不能存稿' }), /学习会话不能/);
  for (const change of [
    { target: 'source', field: 'postHistoryInstruction', after: '覆盖保护' },
    { target: 'global', field: 'writerModel', after: 'other' },
    { target: 'source', field: 'context', after: 'x', materialName: '绕过' },
  ]) assert.throws(() => f.service.proposeLearningFromSession(actor, { operationKey: JSON.stringify(change), summary: 'bad', changes: [{ ...change, caseIds: [entry.id] }] }), /不允许|只有文本知识/);
  assert.throws(() => f.service.proposeLearningFromSession(actor, { operationKey: 'duplicate', summary: 'bad', changes: [' 原资料 ', '原资料'].map(materialName => ({ target: 'source', field: 'textMaterial', materialName, after: '新知识', caseIds: [entry.id] })) }), /重复修改/);
});

test('no suggestions and failed batches retain evaluations while later batches can reach the remaining cases', async t => {
  const f = await fixture(t, 51);
  f.service.executor.learn = async ({ batchId }) => {
    await f.service.bindLearningSession({ batchId, sessionId: `none-${batchId}`, workspaceId: 'ws', cwd: f.workspace });
    f.service.proposeLearningFromSession({ sessionId: `none-${batchId}`, actualCwd: f.workspace }, { operationKey: 'none', summary: '暂无可靠修改建议', changes: [] });
  };
  const first = await f.start();
  assert.equal(first.caseCount, 50); assert.equal(first.remainingCount, 1); assert.equal(first.status, 'no-suggestions');
  assert.equal(f.service.learningList().unlearnedCount, 51);
  await assert.rejects(f.service.applyLearning(first.id, approval(first)), /不能应用/);
  const second = await f.start();
  assert.ok(second.cases.some(entry => !first.cases.some(old => old.feedbackId === entry.feedbackId)));
  f.service.executor.learn = async () => { throw new Error('synthetic transport failure'); };
  const failed = await f.start(); assert.equal(failed.status, 'failed');
  assert.match(failed.error, /transport/);
  assert.equal(f.service.learningList().unlearnedCount, 51);
  f.service.retryLearning(failed.id);
  assert.equal((await f.settled(failed.id)).status, 'failed');
});

test('learning configuration discovery identifies exact targets without exposing unrelated settings', async t => {
  const f = await fixture(t);
  await f.service.configure({ learningGuidance: '冻结通用指导', writerModel: 'PRIVATE_MODEL_ROUTE' });
  const batch = await f.start(), actor = { sessionId: batch.sessionId, actualCwd: f.workspace };
  const read = args => f.service.readLearningFromSession(actor, { section: 'configuration', ...args });
  const discovery = f.service.readLearningFromSession(actor, { section: 'batch' });
  assert.deepEqual(discovery.fields.global, ['learningGuidance']);
  assert.ok(discovery.fields.source.includes('attentionRules'));
  assert.ok(!discovery.fields.source.includes('learningGuidance'));
  assert.ok(discovery.examples.some(example => example.target === 'global' && example.field === 'learningGuidance'));
  for (const target of ['source', 'global']) {
    const index = read({ target });
    assert.deepEqual(index.fields, discovery.fields[target]);
    assert.equal(index.text, undefined);
    for (const example of index.examples) assert.equal(typeof read(example).text, 'string');
  }
  assert.deepEqual(read({}).fields, discovery.fields);
  assert.doesNotMatch(JSON.stringify(read({})), /PRIVATE_MODEL_ROUTE|冻结通用指导|writerModel/);
  for (const args of [{ target: 'source', field: 'learningGuidance' }, { target: 'global', field: 'context' }, { field: 'learningGuidance' }, { target: 'global', field: 'writerModel' }]) assert.throws(() => read(args), /global.*learningGuidance/);
  assert.throws(() => read({ target: 'credentials' }), /source.*global/);
  await f.service.configure({ learningGuidance: '当前新指导' });
  assert.equal(read({ target: 'global', field: 'learningGuidance' }).text, '冻结通用指导');
});

test('bulk read acknowledges attention while preserving analysis and draft history; new analysis or draft reopens attention', async t => {
  const f = await fixture(t), item = f.items()[0], source = f.service.source(f.source.id);
  const run = { id: 'run', itemId: item.id, sourceId: source.id, workspaceId: 'ws', version: item.version, contextVersion: source.contextVersion, sourceContextVersion: source.contextVersion, baseAnalysisRevision: 0, status: 'completed' };
  f.store.createRun(run); f.store.adoptResult(run.id, analysis);
  assert.equal(f.items()[0].priority, 33); assert.equal(f.items()[0].needsHandling, true);
  f.service.bindSession({ sessionId: 'human', runId: run.id, role: 'human', workspaceId: 'ws', cwd: f.workspace });
  const draft = await f.service.submitFromSession({ sessionId: 'human' }, { kind: 'draft', operationKey: 'draft1', body: '保留草稿' });
  const storedAnalysis = f.store.item(item.id).analysis;
  assert.deepEqual(f.service.markAllRead({ sourceId: source.id }), { count: 1 });
  const cleared = f.items()[0]; assert.equal(cleared.attentionAcknowledged, true); assert.equal(cleared.priority, 0); assert.equal(cleared.needsHandling, false);
  assert.deepEqual(f.store.item(item.id).analysis, storedAnalysis); assert.equal(f.service.draft(draft.draftId).body, '保留草稿');
  await f.service.submitFromSession({ sessionId: 'human' }, { kind: 'draft', operationKey: 'draft2', body: '新草稿' });
  assert.equal(f.items()[0].attentionAcknowledged, false); assert.equal(f.items()[0].needsHandling, true);
  f.service.markAllRead();
  f.store.applyFetch(source.id, [{ remoteId: '0', kind: 'comment', title: '问题0', body: '新的原文', payload: {} }], {}, new Date().toISOString(), fingerprint);
  assert.equal(f.items()[0].attentionAcknowledged, false); assert.equal(f.items()[0].status, 'handling');
});

test('global learning guidance applies only through review and preserves operational state; user-edited source operational state survives apply', async t => {
  const f = await fixture(t);
  const item = f.items()[0], source = f.service.source(f.source.id);
  f.store.createRun({ id: 'learning-preserved-analysis', sourceId: source.id, itemId: item.id, version: item.version, contextVersion: source.contextVersion, sourceContextVersion: source.contextVersion, workspaceId: 'ws', baseAnalysisRevision: item.analysisRevision, status: 'completed' });
  assert.equal(f.store.adoptResult('learning-preserved-analysis', analysis), true);
  f.service.saveFeedback(item.id, { text: '已处理的评价', expectedRevision: 1, itemVersion: item.version, analysisRevision: f.store.item(item.id).analysisRevision });
  const before = f.store.item(item.id);
  f.service.executor.learn = async ({ batchId }) => {
    const sessionId = `global-${batchId}`;
    await f.service.bindLearningSession({ batchId, sessionId, workspaceId: 'ws', cwd: f.workspace });
    const entry = f.service.readLearningFromSession({ sessionId }, { section: 'cases' }).items[0];
    f.service.proposeLearningFromSession({ sessionId }, { operationKey: 'global', summary: '补充通用判断', changes: [{ target: 'global', field: 'learningGuidance', after: '先核对用户实际场景', caseIds: [entry.id] }, { target: 'source', field: 'context', after: '本源新增知识', caseIds: [entry.id] }] });
  };
  const batch = await f.start();
  f.store.updateSource(f.source.id, { fetchedAt: 'newer-fetch', fetchError: 'keep error' });
  await f.service.applyLearning(batch.id, approval(batch));
  assert.equal(f.store.settings().learningGuidance, '先核对用户实际场景');
  assert.equal(f.service.source(f.source.id).fetchedAt, 'newer-fetch');
  assert.equal(f.service.source(f.source.id).fetchError, 'keep error');
  assert.equal(f.service.source(f.source.id).context, '本源新增知识');
  const preview = await f.service.previewInput({ sourceId: f.source.id, source: f.service.source(f.source.id), stage: 'generation' });
  assert.match(preview.serialized, /先核对用户实际场景/);
  const after = f.store.item(item.id);
  for (const key of ['analysis', 'analysisRevision', 'analyzedVersion', 'analyzedContextVersion', 'readVersion', 'handling', 'attentionVersion', 'acknowledgedAttentionVersion']) assert.deepEqual(after[key], before[key]);
  assert.equal(f.items()[0].analysis.summary, analysis.summary);
  for (const scope of ['changes', 'history']) assert.equal((await f.service.organize(source.id, { scope })).candidates, 0);
});

test('schema four upgrade adds learning tables and attention columns without rewriting existing table rows', async t => {
  const f = await fixture(t), item = f.items()[0];
  await f.store.close();
  let db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  db.exec('ALTER TABLE items DROP COLUMN attention_version; ALTER TABLE items DROP COLUMN acknowledged_attention_version; PRAGMA user_version=4');
  const before = db.prepare('SELECT * FROM items').all().map(row => ({ ...row }));
  db.close(); await f.store.start(); await f.store.close();
  db = new DatabaseSync(join(f.directory, 'console.sqlite'));
  const after = db.prepare('SELECT * FROM items').all().map(({ attention_version, acknowledged_attention_version, ...row }) => row);
  assert.deepEqual(after, before); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  db.close(); await f.store.start(); assert.equal(f.store.header(item.id).title, '问题0');
});

test('feedback and learning HTTP routes keep review application separate from agent submission', async t => {
  const f = await fixture(t), handler = createHandler(f.service, req => req.headers['x-owner'] === '1' ? {} : { rejection: 401 });
  async function call(path, body, headers = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: `/api/dsh-message-console/${path}`, headers: { 'x-owner': '1', 'content-type': 'application/json', 'x-dsh-message-console': '1', ...headers } });
    let status, data;
    await handler(req, { writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); } });
    return { status, data };
  }
  assert.equal((await call('learning', { sourceId: f.source.id }, { 'x-owner': '' })).status, 401);
  assert.equal((await call('learning', { sourceId: f.source.id }, { 'x-dsh-message-console': '' })).status, 403);
  const created = await call('learning', { sourceId: f.source.id }); assert.equal(created.status, 200);
  const batch = await f.settled(created.data.id);
  const list = await call(`learning?sourceId=${f.source.id}&page=1&pageSize=10`);
  assert.equal(list.data.unlearnedCount, 1); assert.equal(list.data.items[0].sourceSnapshot, undefined);
  assert.equal((await call(`learning/${batch.id}`)).data.proposal.status, 'pending');
  assert.equal((await call(`items/${encodeURIComponent(f.items()[0].id)}/feedback`)).data.revision, 1);
  assert.equal((await call(`learning/${batch.id}/apply`, approval(batch))).data.learnedCount, 1);
  assert.deepEqual((await call('read-all', { sourceId: f.source.id })).data, { count: 1 });
});

test('restart recovers unfinished learning and freezes original knowledge and Jev input/output snapshots', async t => {
  const f = await fixture(t), item = f.items()[0];
  const source = await f.service.saveSource({ ...f.service.source(f.source.id), materials: [{ kind: 'file', name: '文件知识', path: 'knowledge.md' }] }, f.source.id).catch(() => null);
  assert.equal(source, null);
  await writeFile(join(f.workspace, 'knowledge.md'), '初始文件知识');
  await f.service.saveSource({ ...f.service.source(f.source.id), materials: [{ kind: 'file', name: '文件知识', path: 'knowledge.md' }] }, f.source.id);
  const updatedSource = f.service.source(f.source.id);
  const run = { id: 'jev-run', itemId: item.id, sourceId: f.source.id, workspaceId: 'ws', version: item.version, contextVersion: updatedSource.contextVersion, sourceContextVersion: updatedSource.contextVersion, baseAnalysisRevision: 0, status: 'completed', decision: { input: { state: '原始输入' }, output: { result: '原始输出' } } };
  f.store.createRun(run); f.store.adoptResult(run.id, analysis);
  f.service.saveFeedback(item.id, { text: '学习此决策', expectedRevision: 1, itemVersion: item.version, analysisRevision: f.items()[0].analysisRevision });
  f.service.executor.learn = async ({ batchId }) => {
    await f.service.bindLearningSession({ batchId, sessionId: `freeze-${batchId}`, workspaceId: 'ws', cwd: f.workspace });
    const entry = f.service.readLearningFromSession({ sessionId: `freeze-${batchId}` }, { section: 'cases' }).items[0];
    f.service.proposeLearningFromSession({ sessionId: `freeze-${batchId}` }, { operationKey: 'freeze', summary: '检查冻结资料', changes: [] });
  };
  const batch = await f.start(), actor = { sessionId: batch.sessionId }, entry = batch.cases[0];
  await writeFile(join(f.workspace, 'knowledge.md'), '后改文件知识');
  f.store.updateRun(run.id, { decision: { input: { state: '后改输入' } } });
  assert.equal(f.service.readLearningFromSession(actor, { section: 'materials', materialName: '文件知识' }).text, '初始文件知识');
  assert.match(f.service.readLearningFromSession(actor, { section: 'decision', caseId: entry.id }).text, /原始输入/);
  f.store.updateLearning(batch.id, { status: 'running' });
  await f.store.close(); await f.store.start();
  assert.equal(f.service.learning(batch.id).status, 'interrupted');
  assert.equal(f.service.learningList().unlearnedCount, 1);
});

test('feedback freezes the adopted analysis run and Jev decision even after a later human conversation', async t => {
  const f = await fixture(t), item = f.items()[0], source = f.service.source(f.source.id);
  const run = { id: 'adopted-run', itemId: item.id, sourceId: source.id, workspaceId: 'ws', version: item.version, contextVersion: source.contextVersion, sourceContextVersion: source.contextVersion, baseAnalysisRevision: 0, status: 'completed', startedAt: '2026-01-01T00:00:00Z', decision: { input: { state: '实际Jev输入' }, output: { answer: 'draft' } } };
  f.store.createRun(run); f.store.adoptResult(run.id, analysis);
  f.store.createRun({ ...run, id: 'later-human-run', kind: 'human', baseAnalysisRevision: 1, startedAt: '2026-01-02T00:00:00Z', decision: null });
  const current = f.items()[0];
  const saved = f.service.saveFeedback(item.id, { text: '这次判断值得保留', expectedRevision: 1, itemVersion: item.version, analysisRevision: current.analysisRevision });
  assert.equal(saved.runId, 'adopted-run');
  const batch = await f.start();
  assert.equal(batch.cases[0].runId, 'adopted-run');
  assert.match(f.service.readLearningFromSession({ sessionId: batch.sessionId }, { section: 'decision', caseId: batch.cases[0].id }).text, /实际Jev输入/);
});

test('feedback on a newer unorganized content version does not relabel old analysis or Jev decision as current', async t => {
  const f = await fixture(t), item = f.items()[0], source = f.service.source(f.source.id);
  const run = { id: 'old-analysis', itemId: item.id, sourceId: source.id, workspaceId: 'ws', version: item.version, contextVersion: source.contextVersion, sourceContextVersion: source.contextVersion, baseAnalysisRevision: 0, status: 'completed', decision: { input: 'v1', output: 'v1' } };
  f.store.createRun(run); f.store.adoptResult(run.id, analysis);
  f.store.applyFetch(source.id, [{ remoteId: '0', kind: 'comment', title: '问题0更新', body: 'v2', payload: {} }], {}, new Date().toISOString(), fingerprint);
  const current = f.items()[0]; assert.equal(current.analysis, null);
  const saved = f.service.saveFeedback(current.id, { text: '评价新内容', expectedRevision: 1, itemVersion: current.version, analysisRevision: current.analysisRevision });
  assert.equal(saved.analysisSnapshot, null); assert.equal(saved.runId, null);
  const batch = await f.start();
  assert.equal(batch.cases[0].analysisSnapshot, null); assert.equal(batch.cases[0].hasDecision, false);
  assert.equal(f.service.readLearningFromSession({ sessionId: batch.sessionId }, { section: 'decision', caseId: batch.cases[0].id }).text, 'null');
});

function adoptHuman(f, id) {
  const item = f.store.item(id), source = f.service.source(f.source.id), runId = `feedback-run-${item.analysisRevision}`;
  f.store.createRun({ id: runId, itemId: id, sourceId: source.id, workspaceId: 'ws', version: item.version, contextVersion: source.contextVersion, sourceContextVersion: source.contextVersion, baseAnalysisRevision: item.analysisRevision, status: 'completed' });
  assert.equal(f.store.adoptResult(runId, analysis), true);
  return runId;
}
function saveCurrentFeedback(f, id, text) {
  const item = f.store.item(id);
  return f.service.saveFeedback(id, { text, expectedRevision: f.service.feedback(id).revision, itemVersion: item.version, analysisRevision: item.analysisRevision });
}

test('saving nonempty feedback completes this attention atomically, retains drafts and frozen analysis; later events reopen it', async t => {
  const f = await fixture(t), id = f.items()[0].id;
  const runId = adoptHuman(f, id);
  f.service.bindSession({ sessionId: 'feedback-human', runId, role: 'human', workspaceId: 'ws', cwd: f.workspace });
  const draft = await f.service.submitFromSession({ sessionId: 'feedback-human' }, { kind: 'draft', operationKey: 'old-draft', body: '保留的旧草稿' });
  f.store.handling(id, 'later');
  assert.equal(f.items()[0].needsHandling, true);
  const saved = saveCurrentFeedback(f, id, '普通评论，已检查');
  let item = f.items()[0];
  assert.equal(item.handling, 'done'); assert.equal(item.status, 'read'); assert.equal(item.readVersion, item.version);
  assert.equal(item.attentionAcknowledged, true); assert.equal(item.priority, 0); assert.equal(item.needsHandling, false);
  assert.equal(f.store.items(f.source.id, { filter: 'handling' }).total, 0);
  assert.equal(f.service.overview().sources[0].handling, 0);
  assert.deepEqual(saved.analysisSnapshot, analysis); assert.deepEqual(f.store.item(id).analysis, analysis);
  assert.equal(f.service.draft(draft.draftId).body, '保留的旧草稿'); assert.equal(f.service.feedback(id).learned, false);
  await f.store.close(); await f.store.start();
  assert.equal(f.store.item(id).handling, 'done'); assert.equal(f.items()[0].needsHandling, false);
  f.store.updateDraft(draft.draftId, { status: 'ready' });
  item = f.items()[0]; assert.equal(item.handling, 'pending'); assert.equal(item.needsHandling, true);
  saveCurrentFeedback(f, id, '这次也处理完');
  await f.service.submitFromSession({ sessionId: 'feedback-human' }, { kind: 'draft', operationKey: 'new-draft', body: '后来保存的新草稿' });
  assert.equal(f.items()[0].needsHandling, true); assert.equal(f.store.header(id).handling, 'pending');
  saveCurrentFeedback(f, id, '已检查新草稿');
  adoptHuman(f, id);
  item = f.items()[0]; assert.equal(item.handling, 'pending'); assert.equal(item.attentionAcknowledged, false); assert.equal(item.status, 'handling');
  saveCurrentFeedback(f, id, '已处理新分析');
  f.store.applyFetch(f.source.id, [{ remoteId: '0', kind: 'comment', title: '问题0', body: '新增原文', payload: {} }], {}, new Date().toISOString(), fingerprint);
  item = f.items()[0]; assert.equal(item.handling, 'none'); assert.equal(item.attentionAcknowledged, false); assert.notEqual(item.readVersion, item.version);
  assert.equal(f.service.draft(draft.draftId).body, '保留的旧草稿');
});

test('empty or conflicting feedback leaves current handling, reading and attention untouched', async t => {
  const f = await fixture(t), id = f.items()[0].id;
  adoptHuman(f, id);
  const before = f.store.item(id), sourceBefore = f.service.overview().sources[0];
  const input = { text: '不要覆盖', expectedRevision: 1, itemVersion: before.version, analysisRevision: before.analysisRevision };
  for (const change of [{ expectedRevision: 0 }, { itemVersion: 'outdated' }, { analysisRevision: 0 }]) {
    assert.throws(() => f.service.saveFeedback(id, { ...input, ...change }), /评价已变化|内容或分析已更新/);
    assert.deepEqual(f.store.item(id), before); assert.equal(f.service.feedback(id).revision, 1);
    assert.deepEqual(f.service.overview().sources[0], sourceBefore);
  }
  const saved = saveCurrentFeedback(f, id, ' \n ');
  assert.equal(saved.text, ''); assert.deepEqual(f.store.item(id), before);
  assert.equal(f.items()[0].needsHandling, true);
});

test('manual completion acknowledges current drafts but a new human analysis restores pending consistently', async t => {
  const f = await fixture(t), id = f.items()[0].id;
  const runId = adoptHuman(f, id);
  f.service.bindSession({ sessionId: 'manual-human', runId, role: 'human', workspaceId: 'ws', cwd: f.workspace });
  await f.service.submitFromSession({ sessionId: 'manual-human' }, { kind: 'draft', operationKey: 'manual-draft', body: '保留待审核草稿' });
  await f.service.setHandling(id, 'done');
  assert.equal(f.store.header(id).handling, 'done'); assert.equal(f.items()[0].needsHandling, false);
  f.store.markRead(id);
  assert.equal(f.store.header(id).handling, 'done');
  adoptHuman(f, id);
  assert.equal(f.store.header(id).handling, 'pending'); assert.equal(f.items()[0].needsHandling, true);
});
