import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { escalationImages, ImageInputError } from '../src/escalation-images.js';
import { WorkflowExecutor } from '../src/executor.js';

const photo = { url: 'https://i0.hdslb.com/bfs/new_dyn/test.png' };
const item = { id: 's:i', version: 'v', kind: 'comment', payload: { images: [photo], comments: [{ id: 'floor', images: [photo] }] } };
const base = { item, source: { name: 'fixture', workspaceId: 'ws' }, settings: { writerProvider: 'p', writerModel: 'm', decisionConfidence: .8, decisionMargin: .2 }, recordDecision: async () => {} };
const choice = probabilities => ({ answers: { reply: { probabilities } } });

test('image escalation labels and attaches every root/reply image from the exact stored version; bytes are bounded JPEGs', async () => {
  const data = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: 'red' } }).png().toBuffer(), queries = [];
  const result = await escalationImages({ llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } }, { imageForModel: async (id, query) => { queries.push({ id, query }); return { body: data }; } }, { item, provider: 'p', model: 'm' });
  assert.equal(result.images.length, 2);
  for (const image of result.images) { const meta = await sharp(image.data).metadata(); assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, 2048); assert.equal(meta.height, 1024); }
  assert.equal(queries.length, 2); assert.equal(queries[0].query.version, 'v'); assert.equal(queries[1].query.commentId, 'floor'); assert.equal(queries[1].query.variant, undefined);
  assert.equal(result.manifest[0].attachment, undefined); assert.equal(result.manifest[0].data, undefined); assert.equal(result.manifest[0].width, 2048);
  assert.equal(result.manifest[1].commentId, 'floor'); assert.equal(result.manifest[1].sha256.length, 64);
});

test('text-only/unknown models, excessive image counts and missing images stop before any partial attachment save', async () => {
  let downloads = 0, saves = 0;
  const service = { imageForModel: async () => { downloads++; throw new Error('原图已失效'); } };
  const ctx = { llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }, get: () => ({ saveImages: async () => { saves++; } }) };
  const request = { item, provider: 'p', model: 'm' };
  await assert.rejects(escalationImages(ctx, service, request), /未声明支持图片/); assert.equal(downloads, 0);
  ctx.llm.resolveModelInfo = async () => ({}); await assert.rejects(escalationImages(ctx, service, request), /未声明支持图片/);
  ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['image'] });
  await assert.rejects(escalationImages(ctx, service, request), /根评论图片 1.*原图已失效/); assert.equal(saves, 0);
  await assert.rejects(escalationImages(ctx, service, { ...request, item: { payload: { images: Array(21).fill(photo) } } }), /超过20/);
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(escalationImages(ctx, service, { ...request, signal: abort.signal }), /cancelled/);
});

test('Jev stays textual; even confident text decisions escalate images, then generation receives visual reasoning without image blocks', async () => {
  const roles = []; let prepared = 0;
  const executor = new WorkflowExecutor({
    decision: async request => { assert.equal(request.images, undefined); assert.match(request.state, /只有决策升级/); return choice({ ignore: 1, draft: 0, human: 0 }); },
    prepareImages: async () => { prepared++; return { manifest: [{ label: 'root' }], images: [{ data: Buffer.from('pixels') }] }; },
    runAgent: async request => {
      roles.push(request.role);
      if (request.role === 'decision-escalation') { assert.ok(Buffer.isBuffer(request.transientImages[0].data)); assert.equal(request.input.imageInput.status, 'transient'); return { result: { choice: 'draft', certain: true, reason: '图片显示产品问题' } }; }
      assert.equal(request.transientImages, undefined); assert.equal(request.input.decision.reason, '图片显示产品问题');
      return { result: { summary: '建议回复', reason: '升级确认', importance: 1, urgent: false, evidence: 'inferred', intervention: 'review' } };
    },
  });
  await executor.analyze(base); assert.deepEqual(roles, ['decision-escalation', 'writer']); assert.equal(prepared, 1);
});

test('image preparation failure becomes explicit human decision after preserving the real Jev call; incomplete contexts still call no models', async () => {
  let jev = 0, agents = 0, records = 0;
  const executor = new WorkflowExecutor({ decision: async () => { jev++; return choice({ ignore: 1, draft: 0, human: 0 }); }, prepareImages: async () => { throw new ImageInputError('图片下载失败'); }, runAgent: async () => { agents++; } });
  const result = await executor.analyze({ ...base, recordDecision: async () => { records++; } });
  assert.equal(result.intervention, 'human'); assert.equal(result.evidence, 'insufficient'); assert.match(result.reason, /图片下载失败/); assert.equal(jev, 1); assert.equal(records, 1); assert.equal(agents, 0);
  const incomplete = await executor.analyze({ ...base, item: { ...item, payload: { ...item.payload, contextComplete: false } } });
  assert.equal(incomplete.processing, 'context-incomplete'); assert.equal(jev, 1);
});
