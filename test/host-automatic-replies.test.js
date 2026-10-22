import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hostFixture } from './host-fixture.js';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { installAgentTools } from '../src/agent-tools.js';
import { CookieTransport } from '../src/connectors/cookies.js';
import { BilibiliConnector } from '../src/connectors/bilibili.js';
import { AUTO_REPLY_PREFIX } from '../src/publication.js';
const root = process.env.DMC_DSH_ROOT;

test('real DSH PTC writer and supervisor tools send the disclosed exact floor reply through the Cookie POST adapter', { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'host-auto-')), store = await new Store(directory).start();
  let service, changed = false, posts = 0;
  const requests = [];
  try {
    const cookieFile = join(directory, 'fake-cookie.json');
    await writeFile(cookieFile, JSON.stringify({ platforms: { bilibili: ['SESSDATA', 'bili_jct'].map(name => ({ name, value: 'SYNTHETIC', domain: '.bilibili.com', path: '/' })) } }), { mode: 0o600 });
    const transport = new CookieTransport({ cookieFile, intervalMs: 0, request: async (url, init) => {
      assert.equal(url, 'https://api.bilibili.com/x/v2/reply/add'); assert.equal(init.method, 'POST');
      const body = new URLSearchParams(init.body); assert.equal(body.get('parent'), '101'); assert.equal(body.get('root'), '100');
      assert.ok(body.get('message').startsWith(AUTO_REPLY_PREFIX)); posts++;
      return Response.json({ code: 0, data: { rpid_str: '999', reply: { rpid_str: '999', root_str: '100', parent_str: '101', mid: 99 } } });
    } });
    transport.identities.bilibili = { id: '99', name: '合成账号' };
    const connector = new BilibiliConnector(transport);
    connector.fetch = async () => ({ complete: true, items: [{ remoteId: 'comment:123:100', rootAuthorId: '10', kind: 'comment', title: '合成问题', body: '根评论', payload: { aid: '123', bvid: 'BV1111111111', root: '100', comments: [{ id: '101', parent: '100', authorId: '11', body: changed ? '合成新问题' : '旧问题' }] } }] });
    ctx.provide('decisionModels', { async ask() { return { answers: { reply: { probabilities: { ignore: 0, draft: 1, human: 0 } }, importance: { probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } } } }; } });
    const owner = await f.executorOwner(() => service);
    service = new ConsoleService({ store, executor: owner.executor, connectors: { bilibili: connector }, workspaces: { resolve: id => ctx.workspaceRegistry.get(id) } });
    await installAgentTools(ctx, service);
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        requests.push(structuredClone(request));
        assert.deepEqual(request.tools.map(tool => tool.name), ['run_code']);
        let submission;
        if (request.model === 'writer') submission = { kind: 'analysis', operationKey: 'write', analysis: { summary: '合成回答', importance: 1, urgent: false, urgencyReason: null, reason: '合成事实明确', intervention: 'review', evidence: 'confirmed' }, draftBody: '已有事实是42。', replyToCommentId: '101' };
        else {
          assert.equal(request.model, 'supervisor');
          assert.match(JSON.stringify(request.messages), new RegExp(AUTO_REPLY_PREFIX));
          assert.match(JSON.stringify(request.messages), /replyToCommentId/);
          assert.match(JSON.stringify(request.messages.filter(message => message.role === 'system')), /缺少、改写或不在开头均不通过/);
          submission = { kind: 'supervision', operationKey: 'review', approved: true, reason: '合成标识、事实及目标已核对' };
        }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `auto-${requests.length}`, name: 'run_code', arguments: JSON.stringify({ code: `return await tools.dmc_submit_result(${JSON.stringify(submission)});`, description: '隔离合成自动回复验收' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    ctx.llm.registerAdapter(['offline-auto'], new Offline());
    const source = await service.saveSource({ name: '合成自动回复', workspaceId: registeredWorkspace.id, platform: 'bilibili', target: 'BV1111111111', types: ['comment'], autoReply: true, settings: { writerProvider: 'offline-auto', writerModel: 'writer', supervisorProvider: 'offline-auto', supervisorModel: 'supervisor' } });
    await service.refresh(source.id); assert.equal(posts, 0);
    changed = true; const report = await service.refresh(source.id); assert.equal(report.organization.failed, 0, JSON.stringify(report));
    assert.equal(posts, 1); assert.deepEqual(requests.map(request => request.model), ['writer', 'supervisor']);
    const item = service.items(source.id).items[0], draft = service.drafts(item.id).items[0];
    assert.equal(draft.status, 'sent'); assert.equal(draft.publicationMode, 'automatic'); assert.equal(draft.replyToCommentId, '101');
    const run = store.run(service.runs(item.id).items[0].id);
    assert.deepEqual(run.sessions.map(link => link.role), ['writer', 'supervisor']);
    for (const link of run.sessions) {
      await ctx.sessions.flush(ctx.sessions.get(link.sessionId));
      const snapshot = ctx.sessions.get(link.sessionId).snapshotEvents();
      assert.ok(snapshot.some(event => event.type === 'tool/ptc-dispatch'), 'real persisted tool dispatch');
    }
  } finally { await service?.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
