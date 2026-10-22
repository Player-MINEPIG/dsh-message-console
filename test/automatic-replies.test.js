import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { ConsoleService, fingerprint } from '../src/core.js';
import { WorkflowExecutor } from '../src/executor.js';
import { AUTO_REPLY_PREFIX, automaticReplyProblem } from '../src/publication.js';

const analysis = { summary: '回答现有事实问题', importance: 1, urgent: false, urgencyReason: null, reason: '背景有明确答案', intervention: 'review', evidence: 'confirmed' };
const thread = text => ({ remoteId: 'comment:123:100', kind: 'comment', title: '问题', body: '根评论', url: 'https://www.bilibili.com/video/BV1111111111/#reply100', payload: { aid: '123', bvid: 'BV1111111111', root: '100', authorId: '10', comments: [{ id: '101', parent: '100', authorId: '11', body: text }] } });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-auto-'));
  const store = new Store(directory); await store.start();
  let rows = [thread('原文')], sent = 0, service, target = options.target ?? '101';
  const roles = [], requests = [];
  const connector = { status: () => ({ ready: true, canPublish: true, identity: { id: '99' } }), fetch: async () => ({ complete: true, items: structuredClone(rows) }), getItem: async () => { if (options.beforeSend) await options.beforeSend(service); return structuredClone(rows[0]); }, publish: async (_source, _item, draft) => { sent++; requests.push(draft); if (options.sendError) throw options.sendError; return { remoteId: `remote-${sent}`, parent: draft.replyToCommentId }; } };
  const executor = new WorkflowExecutor({
    decision: async request => {
      assert.equal(Object.keys(request.questions).length, 2);
      return { answers: { reply: { probabilities: options.probabilities ?? { ignore: 0, draft: 1, human: 0 } }, importance: { probabilities: options.importance ?? { 0: 1, 1: 0, 2: 0, 3: 0 } } } };
    },
    runAgent: async input => {
      roles.push(input);
      const sessionId = `${input.role}-${input.runId}-${roles.length}`;
      service.bindSession({ sessionId, runId: input.runId, role: input.role, workspaceId: 'ws', cwd: directory, ...(input.draftId ? { draftId: input.draftId } : {}) });
      const submission = input.role === 'decision-escalation' ? { kind: 'decision', operationKey: 'decision', choice: 'draft', certain: options.certain !== false, reason: '升级依据', importance: 3 }
        : input.role === 'supervisor' ? { kind: 'supervision', operationKey: 'review', approved: options.approved !== false, reason: '已核对正文、目标、身份与事实' }
          : { kind: 'analysis', operationKey: 'write', analysis: options.analysis ?? analysis, draftBody: options.body ?? '依据背景，答案是42。', ...(target ? { replyToCommentId: target } : {}) };
      return service.submitFromSession({ sessionId, callId: 'call' }, submission);
    },
  });
  service = new ConsoleService({ store, executor, connectors: { bilibili: connector }, workspaces: { resolve: async () => ({ id: 'ws', path: directory }) } });
  const source = await service.saveSource({ platform: 'bilibili', target: 'BV1111111111', types: ['comment'], name: '测试', workspaceId: 'ws', autoReply: options.enabled !== false, settings: { writerProvider: 'p', writerModel: 'm' } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.refresh(source.id);
  const item = () => store.item(service.items(source.id, { pageSize: 50 }).items[0].id);
  return { store, service, source, roles, requests, item, connector, get sent() { return sent; },
    drafts: () => service.drafts(item().id, { pageSize: 50 }).items,
    change: async (next = thread('新问题')) => { rows = [next]; return service.refresh(source.id); },
  };
}

test('authorized new reply selects exact floor, discloses before independent review, publishes once and records automatic audit', async t => {
  const f = await fixture(t);
  assert.equal(f.sent, 0, 'baseline cannot publish');
  await f.change();
  assert.equal(f.sent, 1);
  const draft = f.drafts()[0], full = f.service.draft(draft.id);
  assert.equal(draft.status, 'sent'); assert.equal(draft.publicationMode, 'automatic'); assert.equal(draft.replyToCommentId, '101');
  assert.ok(full.body.startsWith(AUTO_REPLY_PREFIX));
  const review = f.roles.find(role => role.role === 'supervisor');
  assert.equal(review.input.draft, full.body); assert.equal(review.input.replyToCommentId, '101');
  assert.match(review.instructions, /缺少、改写或不在开头均不通过/);
  assert.equal(f.requests[0].body, full.body);
  assert.equal(f.service.runs(f.item().id).items[0].status, 'completed');
  await f.service.organize(f.source.id); assert.equal(f.sent, 1);
  await f.change(thread('同一评论编辑')); assert.equal(f.sent, 1, 'a new content version cannot reply twice to the same target');
  assert.match(f.drafts()[0].automaticError, /不能重复/);
});

test('human and ignore routing use independent importance and never draft or publish', async t => {
  for (const probabilities of [{ ignore: 0, draft: 0, human: 1 }, { ignore: 1, draft: 0, human: 0 }]) {
    const f = await fixture(t, { probabilities, importance: { 0: 0, 1: 0, 2: 0, 3: 1 } });
    await f.change(); assert.equal(f.sent, 0); assert.equal(f.roles.length, 0); assert.equal(f.item().analysis.importance, 3);
  }
});

test('low confidence may upgrade once and publish only a certain reply', async t => {
  for (const certain of [true, false]) {
    const f = await fixture(t, { probabilities: { ignore: .4, draft: .5, human: .1 }, certain });
    await f.change(); assert.equal(f.sent, certain ? 1 : 0);
    assert.equal(f.roles.filter(role => role.role === 'decision-escalation').length, 1);
    if (!certain) assert.equal(f.item().analysis.intervention, 'human');
    const resolved = f.service.decision(f.service.runs(f.item().id).items[0].id).resolved;
    assert.equal(resolved.choice, certain ? 'draft' : 'human'); assert.equal(resolved.certain, certain);
  }
});

test('disabled automatic permission, rejected supervision and missing facts retain drafts or human decision without sending', async t => {
  for (const options of [{ enabled: false }, { approved: false }, { analysis: { ...analysis, evidence: 'insufficient' } }, { analysis: { ...analysis, intervention: 'human' } }]) {
    const f = await fixture(t, options); await f.change(); assert.equal(f.sent, 0);
  }
});

test('self reply and already answered external comment cannot publish', async t => {
  for (const self of [true, false]) {
    const f = await fixture(t);
    const next = thread('外部问题');
    if (self) next.payload.comments[0].authorId = '99';
    else next.payload.comments.push({ id: '102', parent: '101', authorId: '99', body: '已回答' });
    await f.change(next); assert.equal(f.sent, 0);
    assert.match(f.drafts()[0].automaticError, self ? /自己的评论/ : /已经回复过/);
  }
});

test('an ambiguous POST result persists unknown and later updates never retry it', async t => {
  const f = await fixture(t, { sendError: new Error('connection reset after POST') });
  await f.change(); assert.equal(f.sent, 1); assert.equal(f.drafts()[0].status, 'unknown');
  await f.change(thread('新一轮')); assert.equal(f.sent, 1);
  await f.store.close(); await f.store.start(); assert.ok(f.drafts().some(draft => draft.status === 'unknown'));
});

test('revoked authorization or changed content while checking remote cannot send', async t => {
  const f = await fixture(t, { beforeSend: async service => { const source = service.source(f.source.id); await service.saveSource({ ...source, autoReply: false }, source.id); } });
  await f.change(); assert.equal(f.sent, 0); assert.equal(f.drafts()[0].status, 'stale');
  const g = await fixture(t); g.connector.getItem = async () => thread('再次变化');
  await g.change(); assert.equal(g.sent, 0); assert.equal(g.drafts()[0].status, 'stale');
});

test('auto draft requires explicit exact target; enabling authorization never drains old drafts', async t => {
  const f = await fixture(t, { target: '' }); const result = await f.change();
  assert.equal(f.sent, 0); assert.equal(result.organization.failed, 1); assert.match(result.organization.errors[0].message, /replyToCommentId/);
  const g = await fixture(t, { enabled: false }); await g.change();
  const old = g.drafts()[0]; assert.equal(old.status, 'ready');
  await g.service.saveSource({ ...g.service.source(g.source.id), autoReply: true }, g.source.id);
  await g.service.organize(g.source.id); assert.equal(g.sent, 0);
});

test('automatic policy rejects absent or rewritten identity disclosure independently of model approval', () => {
  const input = { source: { platform: 'bilibili', autoReply: true, enabled: true }, item: { kind: 'comment', body: '问题', payload: { root: '1', authorId: '2' } }, draft: { automatic: true, body: '插件回复：内容', replyToCommentId: '1' }, run: { kind: 'automatic', resultAdopted: true, result: analysis, decision: { resolved: { choice: 'draft', certain: true } } }, ownId: '3' };
  assert.match(automaticReplyProblem(input), /开头身份标识/);
  input.draft.body = `${AUTO_REPLY_PREFIX}\n内容`; assert.equal(automaticReplyProblem(input), null);
});

test('authorization and rule changes while queued are checked again immediately before the real transport POST', async t => {
  const { CookieTransport } = await import('../src/connectors/cookies.js');
  const { BilibiliConnector } = await import('../src/connectors/bilibili.js');
  const { writeFile } = await import('node:fs/promises');
  for (const update of [source => ({ ...source, autoReply: false }), source => ({ ...source, context: '新的来源规则' })]) {
    const f = await fixture(t); let release, entered, posts = 0;
    const gate = new Promise(resolve => { release = resolve; }), enqueued = new Promise(resolve => { entered = resolve; });
    const cookieFile = join(f.store.directory, 'fake-cookie.json');
    await writeFile(cookieFile, JSON.stringify({ platforms: { bilibili: ['SESSDATA', 'bili_jct'].map(name => ({ name, value: 'SYNTHETIC', domain: '.bilibili.com', path: '/' })) } }), { mode: 0o600 });
    const transport = new CookieTransport({ cookieFile, intervalMs: 0, request: async () => { posts++; throw new Error('must not send'); } });
    transport.tail = gate;
    const post = transport.postComment.bind(transport);
    transport.postComment = (...args) => { const result = post(...args); entered(); return result; };
    const publishing = new BilibiliConnector(transport); f.connector.publish = publishing.publish.bind(publishing);
    const processing = f.change(); await enqueued;
    await f.service.saveSource(update(f.service.source(f.source.id)), f.source.id);
    release(); await processing;
    assert.equal(posts, 0); assert.equal(f.drafts()[0].status, 'ready');
  }
});

test('reviewed learning defaults invalidate inherited drafts and reach new sources without changing source-specific overrides or authorization', async t => {
  const f = await fixture(t, { approved: false }); await f.change();
  const fixed = await f.service.saveSource({ platform: 'bilibili', target: 'BV2222222222', types: ['comment'], name: '独立偏好', workspaceId: 'ws', autoReply: false, settings: { replyStyle: '仅此来源' } });
  const item = f.item();
  f.service.saveFeedback(item.id, { text: '默认回复应先给答案再解释', expectedRevision: 0, itemVersion: item.version, analysisRevision: item.analysisRevision });
  f.service.executor.learn = async ({ batchId }) => {
    const workspace = await f.service.workspaces.resolve('ws');
    const sessionId = 'learn-defaults';
    await f.service.bindLearningSession({ batchId, sessionId, workspaceId: 'ws', cwd: workspace.path });
    const actor = { sessionId, actualCwd: workspace.path };
    assert.equal(f.service.readLearningFromSession(actor, { section: 'configuration', target: 'global', field: 'replyStyle' }).text, '简明、自然；不擅自代表用户作出承诺。');
    assert.equal(f.service.readLearningFromSession(actor, { section: 'configuration', target: 'source', field: 'settings.replyStyle' }).text, '简明、自然；不擅自代表用户作出承诺。');
    const cases = f.service.readLearningFromSession(actor, { section: 'cases' }).items;
    f.service.proposeLearningFromSession(actor, { operationKey: 'default', summary: '改默认回复风格', changes: [{ target: 'global', field: 'replyStyle', after: '先给答案再解释，不作承诺', caseIds: [cases[0].id] }] });
  };
  let batch = await f.service.startLearning({ sourceId: f.source.id });
  for (let count = 0; count < 100 && ['queued', 'running'].includes(batch.status); count++) { await new Promise(resolve => setTimeout(resolve, 1)); batch = f.service.learning(batch.id); }
  assert.equal(batch.status, 'pending'); assert.equal(f.service.source(f.source.id).effective.replyStyle.value, '简明、自然；不擅自代表用户作出承诺。');
  await f.service.applyLearning(batch.id, { proposalRevision: batch.proposal.revision, proposalHash: batch.proposal.hash });
  assert.equal(f.service.source(f.source.id).effective.replyStyle.value, '先给答案再解释，不作承诺');
  assert.equal(f.drafts()[0].status, 'stale'); assert.deepEqual(f.item().analysis, item.analysis);
  assert.equal(f.service.source(fixed.id).revision, fixed.revision); assert.equal(f.service.source(fixed.id).effective.replyStyle.value, '仅此来源');
  assert.equal(f.service.source(f.source.id).autoReply, true); assert.equal(f.service.source(fixed.id).autoReply, false);
  const next = await f.service.saveSource({ platform: 'bilibili', target: 'BV3333333333', types: ['comment'], name: '新来源', workspaceId: 'ws' });
  assert.equal(f.service.source(next.id).effective.replyStyle.value, '先给答案再解释，不作承诺'); assert.equal(next.autoReply, false);
});

test('collecting root author identity preserves the content version, baseline and existing analysis', async t => {
  const f = await fixture(t);
  const before = f.item();
  f.store.applyFetch(f.source.id, [{ ...thread('原文'), rootAuthorId: '10' }], {}, new Date().toISOString(), fingerprint);
  const after = f.item();
  assert.equal(after.rootAuthorId, '10'); assert.equal(after.version, before.version); assert.equal(after.analyzedVersion, before.analyzedVersion); assert.equal(after.attentionVersion, before.attentionVersion);
  await f.service.organize(f.source.id); assert.equal(f.roles.length, 0); assert.equal(f.sent, 0);
});
