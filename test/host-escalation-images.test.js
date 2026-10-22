import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { hostFixture } from './host-fixture.js';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { installAgentTools } from '../src/agent-tools.js';

const root = process.env.DMC_DSH_ROOT;
test('real DSH PTC escalation receives root/reply image attachments and restores the exact input after cold resume', { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, load, llm, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'host-image-')), store = await new Store(directory).start();
  let service, modelCalls = 0, jevCalls = 0, savedRefs, sessionId;
  try {
    await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: join(directory, 'attachments-home') });
    ctx.provide('decisionModels', { async ask(request) { jevCalls++; assert.equal(request.images, undefined); return { answers: { reply: { probabilities: { ignore: 1, draft: 0, human: 0 } } } }; } });
    const image = await sharp({ create: { width: 36, height: 24, channels: 3, background: 'red' } }).png().toBuffer();
    class Visual extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] }; }
      async *stream(request) {
        modelCalls++; if (modelCalls > 1) throw new Error(JSON.stringify(request.messages.at(-1)));
        const content = request.messages.flatMap(message => message.content), refs = content.filter(block => block.type === 'image').map(block => block.attachment);
        assert.equal(refs.length, 2);
        savedRefs = refs;
        for (const ref of refs) { const stored = await ctx.attachments.readImage(ref); assert.equal((await sharp(stored.data).metadata()).width, 36); }
        assert.match(JSON.stringify(content.filter(block => block.type === 'text')), /楼中楼 floor 图片 1/);
        const args = { kind: 'decision', operationKey: 'visual-choice', choice: 'human', certain: true, reason: '实际接收两张红色合成图片，需要人工查看。' };
        const ptc = request.tools.some(tool => tool.name === 'run_code');
        const block = { type: 'tool-call', id: llm.ToolCallId('visual-decision'), name: ptc ? 'run_code' : 'dmc_submit_result', arguments: ptc ? JSON.stringify({ code: `return await tools.dmc_submit_result(${JSON.stringify(args)});`, description: '保存图片升级判断' }) : JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    ctx.llm.registerAdapter(['visual-fixture'], new Visual());
    const owner = await f.executorOwner(() => service), executor = owner.executor;
    service = new ConsoleService({ store, executor, connectors: { bilibili: { status: () => ({ ready: true }), fetch: async () => ({ complete: true, items: [{ remoteId: 'root', kind: 'comment', title: '合成图片', body: '请查看评论图片', payload: { images: [{ url: 'https://i0.hdslb.com/bfs/new_dyn/root.png' }], comments: [{ id: 'floor', body: 'floor', images: [{ url: 'https://i0.hdslb.com/bfs/new_dyn/floor.png' }] }] } }] }) } }, workspaces: { resolve: id => ctx.workspaceRegistry.get(id) }, imageCache: { get: async () => ({ body: image, mime: 'image/png' }), updateSettings: async save => save(), close: async () => {} } });
    await installAgentTools(ctx, service);
    await service.configure({ writerProvider: 'visual-fixture', writerModel: 'vision-model' });
    const source = await service.saveSource({ workspaceId: registeredWorkspace.id, name: '图片隔离合成', platform: 'bilibili', target: 'BV1111111111', types: ['comment'] });
    await service.refresh(source.id, { organize: false });
    const result = await service.organize(source.id, { scope: 'history' }); assert.equal(result.completed, 1, JSON.stringify(result)); assert.equal(result.failed, 0);
    const item = service.items(source.id).items[0], run = service.runs(item.id).items[0];
    assert.equal(jevCalls, 1); assert.equal(modelCalls, 1); assert.equal(item.analysis.intervention, 'human'); assert.equal(run.sessions.length, 1); assert.equal(run.sessions[0].role, 'decision-escalation');
    sessionId = run.sessions[0].sessionId;
    await owner.dispose();
    const cold = await ctx.agents.resume({ resumeSessionId: sessionId });
    const events = cold.agent.session.snapshotEvents();
    assert.ok(JSON.stringify(events).includes(savedRefs[0].attachmentId));
    const history = JSON.stringify(events); assert.match(history, /imageInput/); assert.match(history, /楼中楼 floor/);
    for (const ref of savedRefs) await ctx.attachments.readImage(ref);
    await cold.dispose();
  } finally { await service?.close(); if (!service) await store.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
