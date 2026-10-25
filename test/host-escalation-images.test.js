import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { hostFixture } from './host-fixture.js';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { ImageCache } from '../src/image-cache.js';
import { installAgentTools } from '../src/agent-tools.js';

const root = process.env.DMC_DSH_ROOT;
const files = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true }).catch(() => [])).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
function imageBlocks(value) {
  if (!value || typeof value !== 'object') return [];
  return [...(value.type === 'image' && value.attachment ? [value] : []), ...Object.values(value).flatMap(child => typeof child === 'object' ? imageBlocks(child) : [])];
}

for (const withEditor of [false, true, 'fallback']) test(`real DSH nested model owner uses ${withEditor === 'fallback' ? 'model fallback' : withEditor ? 'profile directory' : 'root loader'}; wire images never persist or leak to other requests`, { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, load, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'host-memory-image-')), store = await new Store(directory).start();
  let service, jevCalls = 0; const requests = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const visual = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'image_url');
      const textOnly = body.messages.some(message => message.content === 'UNRELATED_TEXT_REQUEST');
      if (textOnly) assert.equal(visual.length, 0);
      else {
        assert.equal(visual.length, 2);
        for (const image of visual) {
          assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
          const data = Buffer.from(image.image_url.url.split(',')[1], 'base64'); assert.equal((await sharp(data).metadata()).width, 36);
        }
      }
      if (body.model === 'retired-model') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'model retired', type: 'invalid_request_error' } })); return; }
      const args = { kind: 'decision', operationKey: 'visual-choice', choice: 'human', certain: true, reason: '已读取两张合成图片，交人工查看。' };
      const ptc = body.tools?.some(tool => tool.function.name === 'run_code');
      const delta = textOnly ? { role: 'assistant', content: 'text only' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'visual-decision', type: 'function', function: { name: ptc ? 'run_code' : 'dmc_submit_result', arguments: ptc ? JSON.stringify({ code: `return await tools.dmc_submit_result(${JSON.stringify(args)});`, description: '保存判断' }) : JSON.stringify(args) } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'test', model: 'vision-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'test', model: 'vision-model', choices: [{ index: 0, delta: {}, finish_reason: textOnly ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: join(directory, 'attachments-home') });
    const originalAttachments = ctx.attachments;
    const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment');
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DMC_IMAGE_TEST_KEY: 'synthetic-key' } }]));
    await ctx.loader.create({ id: 'include', name: '@deepseek-ai/cordis-plugin-loader', isolate: { loader: true }, config: { baseUrl: ctx.baseUrl } });
    const modelTree = ctx.loader.resolve('include').subtree;
    await modelTree.create({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'visual-fixture': { api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'DMC_IMAGE_TEST_KEY', models: ['vision-model', 'retired-model'].map(id => ({ id, name: id, input: ['text', 'image'] })) } } } });
    assert.throws(() => ctx.loader.resolve('llm-pi-ai'), /cannot resolve entry/);
    if (withEditor) {
      ctx.provide('profileContext', { patchPath: join(directory, 'unused.patch.yml') });
      await ctx.plugin((await load('dsh-config-editor')).default);
      assert.equal(ctx.configEditor.entries().some(entry => entry.options.id === 'llm-pi-ai'), true);
    }
    const providers = ctx.llm.listProviders();
    ctx.provide('decisionModels', { async ask(request) { jevCalls++; assert.equal(request.images, undefined); return { answers: { reply: { probabilities: { ignore: 1, draft: 0, human: 0 } } } }; } });
    const image = await sharp({ create: { width: 36, height: 24, channels: 3, background: 'red' } }).png().toBuffer();
    const cache = await new ImageCache(join(directory, 'images'), { settings: () => store.settings(), request: async () => new Response(image) }).start();
    const owner = await f.executorOwner(() => service);
    service = new ConsoleService({ store, executor: owner.executor, connectors: { bilibili: { status: () => ({ ready: true }), fetch: async () => ({ complete: true, items: [{ remoteId: 'root', kind: 'comment', title: '合成图片', body: '请查看评论图片', payload: { images: [{ url: 'https://i0.hdslb.com/bfs/new_dyn/root.png' }], comments: [{ id: 'floor', body: 'floor', images: [{ url: 'https://i0.hdslb.com/bfs/new_dyn/floor.png' }] }] } }] }) } }, workspaces: { resolve: id => ctx.workspaceRegistry.get(id) }, imageCache: cache });
    await installAgentTools(ctx, service);
    await service.configure({ writerProvider: 'visual-fixture', writerModel: 'vision-model' });
    const source = await service.saveSource({ workspaceId: registeredWorkspace.id, name: '图片隔离合成', platform: 'bilibili', target: 'BV1111111111', types: ['comment'], settings: withEditor === 'fallback' ? { writerModel: 'retired-model' } : {} });
    await service.refresh(source.id, { organize: false });
    const result = await service.organize(source.id, { scope: 'history' }); assert.equal(result.completed, 1, JSON.stringify(result)); assert.equal(result.failed, 0);
    const item = service.items(source.id).items[0], run = service.runs(item.id).items[0];
    assert.equal(jevCalls, 1); assert.equal(requests.length, withEditor === 'fallback' ? 2 : 1); assert.equal(item.analysis.intervention, 'human'); assert.equal(run.sessions.length, 1);
    const storedImages = service.decision(run.id).escalation.imageInput;
    assert.equal(storedImages.transport, 'memory'); assert.equal(storedImages.images.length, 2);
    const wire = requests.at(-1).messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'image_url');
    storedImages.images.forEach((metadata, index) => { const bytes = Buffer.from(wire[index].image_url.url.split(',')[1], 'base64'); assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(metadata.bytes, bytes.length); assert.equal(metadata.width, 36); assert.equal(metadata.attachment, undefined); assert.equal(metadata.data, undefined); });
    const id = run.sessions[0].sessionId;
    const history = await ctx.sessionQuery.readSession(id); assert.equal(imageBlocks(history).length, 0); assert.match(JSON.stringify(history), /imageInput/);
    assert.deepEqual(await files(join(directory, 'attachments-home')), []); assert.equal((await cache.stats()).files, 0); assert.equal((await files(join(directory, 'images'))).filter(path => path.endsWith('.img') || path.endsWith('.tmp')).length, 0);
    assert.equal(JSON.stringify(history).includes(image.toString('base64')), false);
    assert.deepEqual(ctx.llm.listProviders(), providers); assert.equal(ctx.attachments.root, originalAttachments.root);
    await owner.dispose();
    const cold = await ctx.agents.resume({ resumeSessionId: id }); assert.equal(imageBlocks(cold.agent.session.snapshotEvents()).length, 0); await cold.dispose();
    for await (const _chunk of ctx.llm.stream({ provider: 'visual-fixture', model: 'vision-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'UNRELATED_TEXT_REQUEST' }] }], tools: [] })) {}
    assert.equal(requests.length, withEditor === 'fallback' ? 3 : 2); assert.deepEqual(errors, []);
    for (const file of await files(join(f.directory, 'sessions'))) assert.equal((await readFile(file, 'utf8')).includes('data:image/jpeg;base64,'), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service?.close(); if (!service) await store.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
