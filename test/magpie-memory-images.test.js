import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Context } from '@deepseek-ai/cordis';
import * as llm from '@deepseek-ai/dsh-llm';
import * as magpie from 'dsh-magpie-connect';
import { openMemoryImageModel } from '../src/memory-image-model.js';
import { ImageInputError } from '../src/escalation-images.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-magpie-images-'));
  const calls = [], errors = [], state = { directoryFailure: false };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer page-key');
      if (request.url === '/v2/models') {
        if (state.directoryStarted) { state.directoryStarted(); return; }
        response.writeHead(state.directoryFailure ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: ['vision', 'text'].map(id => ({ id, context_window: 128000, max_output_tokens: 2048, modalities: { input: id === 'vision' ? ['text', 'image'] : ['text'] }, native_endpoints: ['/chat/completions'] })) }));
        return;
      }
      assert.equal(request.url, '/v2/chat/completions');
      let raw = ''; for await (const chunk of request) raw += chunk;
      calls.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'synthetic', model: 'vision', choices: [{ index: 0, delta: { role: 'assistant', content: 'image received' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'synthetic', model: 'vision', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v2`;
  const settingsPath = join(directory, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ baseUrl, apiKey: 'page-key' }), { mode: 0o600 });
  const ctx = new Context();
  await ctx.plugin(llm.default);
  const catalog = new magpie.ModelCatalog({ baseUrl, apiKey: 'page-key' });
  await catalog.refreshOnce();
  const attachments = { readImageRequest() { throw new Error('persistent attachment service must not receive temporary images'); } };
  ctx.provide('attachments', attachments);
  ctx.llm.registerAdapter(['magpie-fixture'], new magpie.MagpieAdapter(catalog, { providerId: 'magpie-fixture', baseUrl, apiKey: 'page-key', maxRetries: 0, resolveAttachments: () => attachments }));
  const entry = {
    id: 'magpie-owner', options: { id: 'magpie-owner' },
    fiber: { config: { providerId: 'magpie-fixture', baseUrl: 'http://127.0.0.1:1/stale-patch', apiKey: 'stale-patch-key', dataDir: directory, maxRetries: 0 } },
    moduleNamespace: { ...magpie, apply() { throw new Error('must not restart the Magpie plugin'); } },
    parent: { tree: { async import(name) { assert.equal(name, '@deepseek-ai/dsh-llm'); return llm; } } },
  };
  const entries = [entry];
  ctx.provide('configEditor', { entries: () => entries });
  t.after(async () => { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { ctx, calls, errors, state, directory, settingsPath, attachments, entries };
}

async function image(width, background) {
  const data = await sharp({ create: { width, height: 20, channels: 3, background } }).jpeg().toBuffer();
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { data, label: `synthetic-${width}`, metadata: { sha256, bytes: data.length, width, height: 20 }, ref: { attachmentId: `sha256:${sha256}`, mediaType: 'image/jpeg', bytes: data.length, width, height: 20 } };
}

const request = text => ({ provider: 'magpie-fixture', model: 'vision', messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text }] }], tools: [] });
async function drain(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1))); return chunks; }

test('real Magpie adapter forwards independent memory images using saved endpoint overrides without changing history, files or active attachments', async t => {
  const f = await fixture(t), first = await image(30, 'red'), second = await image(40, 'blue');
  const original = request('FIRST'), before = structuredClone(original), providers = f.ctx.llm.listProviders();
  const saved = await readFile(f.settingsPath, 'utf8');
  assert.deepEqual(f.ctx.llm.listConfigurableProviders(), []);
  const a = await openMemoryImageModel(f.ctx, { provider: 'magpie-fixture', model: 'vision', images: [first] });
  const b = await openMemoryImageModel(f.ctx, { provider: 'magpie-fixture', model: 'vision', images: [second] });
  try {
    await Promise.all([drain(a.stream(original, 'input')), drain(b.stream(request('SECOND'), 'input')), drain(f.ctx.llm.stream(request('UNRELATED')))]);
    assert.equal(f.calls.length, 3);
    for (const [marker, expected] of [['FIRST', first], ['SECOND', second]]) {
      const body = f.calls.find(body => JSON.stringify(body.messages).includes(marker));
      const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
      const visual = blocks.filter(block => block.type === 'image_url');
      assert.equal(visual.length, 1);
      assert.equal(createHash('sha256').update(Buffer.from(visual[0].image_url.url.split(',')[1], 'base64')).digest('hex'), expected.metadata.sha256);
    }
    assert.equal(JSON.stringify(f.calls.find(body => JSON.stringify(body.messages).includes('UNRELATED'))).includes('data:image'), false);
    assert.deepEqual(original, before);
    assert.equal(JSON.stringify(original).includes(first.data.toString('base64')), false);
    assert.equal(a.summary().images[0].sha256, first.metadata.sha256);
    assert.deepEqual(f.ctx.llm.listProviders(), providers);
    assert.equal(f.ctx.attachments, f.attachments);
    assert.deepEqual(await readdir(f.directory), ['settings.json']);
    assert.equal(await readFile(f.settingsPath, 'utf8'), saved);
    assert.deepEqual(f.errors, []);
  } finally { await a.close(); await b.close(); }
  await drain(f.ctx.llm.stream(request('AFTER_CLOSE')));
});

test('Magpie memory routes reject ambiguous owners, unsupported models, unavailable directories and corrupt overrides before inference', async t => {
  const f = await fixture(t), picture = await image(30, 'red');
  const open = model => openMemoryImageModel(f.ctx, { provider: 'magpie-fixture', model, images: [picture] });
  f.entries.push({ ...f.entries[0], id: 'second-owner' });
  await assert.rejects(open('vision'), error => error instanceof ImageInputError && /多个生效配置/.test(error.message));
  f.entries.pop();
  await assert.rejects(open('text'), error => error instanceof ImageInputError && /未声明支持图片/.test(error.message));
  f.state.directoryFailure = true;
  await assert.rejects(open('vision'), error => error instanceof ImageInputError && /当前目录/.test(error.message));
  await writeFile(f.settingsPath, '{malformed');
  await assert.rejects(open('vision'), error => error instanceof ImageInputError && /生效配置/.test(error.message));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.errors, []);
});

test('cancelling Magpie directory discovery aborts the request without turning cancellation into an image failure', async t => {
  const f = await fixture(t), controller = new AbortController(), picture = await image(30, 'red');
  const started = new Promise(resolve => { f.state.directoryStarted = resolve; });
  const opening = openMemoryImageModel(f.ctx, { provider: 'magpie-fixture', model: 'vision', images: [picture], signal: controller.signal });
  await started;
  const reason = new Error('synthetic cancellation'); controller.abort(reason);
  await assert.rejects(opening, error => error === reason);
  assert.equal(f.calls.length, 0);
});
