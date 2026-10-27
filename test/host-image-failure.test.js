import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { hostFixture } from './host-fixture.js';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { ImageCache } from '../src/image-cache.js';
import { installAgentTools } from '../src/agent-tools.js';

const root = process.env.DMC_DSH_ROOT;
test('real host wrapped image bridge failure becomes actionable analysis without repeated organization', { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'dmc-image-failure-')), store = await new Store(directory).start();
  let service, owner, calls = 0;
  try {
    class UnsupportedBridge extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'], context: { contextWindow: 200000 } }; }
      async *stream() { calls++; throw new Error('image route must fail before model dispatch'); }
    }
    ctx.llm.registerAdapter(['unsupported-bridge'], new UnsupportedBridge());
    ctx.provide('decisionModels', { async ask() { return { answers: { reply: { probabilities: { ignore: 1, draft: 0, human: 0 } } } }; } });
    const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: 'red' } }).png().toBuffer();
    const cache = await new ImageCache(join(directory, 'images'), { settings: () => store.settings(), request: async () => new Response(image) }).start();
    owner = await f.executorOwner(() => service);
    service = new ConsoleService({ store, executor: owner.executor, imageCache: cache, workspaces: { resolve: id => ctx.workspaceRegistry.get(id) }, connectors: { bilibili: { fetch: async () => ({ complete: true, items: [{ remoteId: 'root', kind: 'comment', title: 'synthetic image', body: 'image', payload: { images: [{ url: 'https://i0.hdslb.com/bfs/test/image.png', width: 12, height: 12 }], comments: [] } }] }) } } });
    await installAgentTools(ctx, service);
    await service.configure({ writerProvider: 'unsupported-bridge', writerModel: 'vision' });
    const source = await service.saveSource({ workspaceId: registeredWorkspace.id, name: 'image test', platform: 'bilibili', target: 'BV1111111111', types: ['comment'] });
    await service.refresh(source.id, { organize: false });
    const result = await service.organize(source.id, { scope: 'history' });
    assert.equal(result.failed, 0, JSON.stringify(result)); assert.equal(result.completed, 1);
    const item = service.items(source.id).items[0];
    assert.equal(item.analysis.intervention, 'human'); assert.equal(item.needsHandling, true);
    assert.match(item.analysis.reason, /内存图片转发/); assert.equal(calls, 0);
    const runs = service.runs(item.id).total;
    await service.organize(source.id, { scope: 'history' });
    assert.equal(service.runs(item.id).total, runs); assert.equal(calls, 0);
  } finally {
    await owner?.dispose(); await service?.close(); if (!service) await store.close();
    await f.close(); await rm(directory, { recursive: true, force: true });
  }
});
