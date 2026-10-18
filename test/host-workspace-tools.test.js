import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { hostFixture } from './host-fixture.js';
import { installAgentTools } from '../src/agent-tools.js';
import { createDshWorkspaces } from '../src/dsh.js';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';

const root = process.env.DMC_DSH_ROOT;
test('ordinary PTC workspace sessions discover, query and save multiple drafts across active attachment and cold resume', { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, sessions, workspace, llm, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'workspace-tools-')), store = await new Store(directory).start();
  const service = new ConsoleService({ store, executor: {}, connectors: { bilibili: { fetch: async () => ({ complete: true, items: [1, 2].map(n => ({ remoteId: `comment-${n}`, kind: 'comment', title: `评论${n}`, body: `ROOT-${n}`, payload: { comments: [{ id: `reply-${n}`, body: `REPLY-${n}`, author: 'fixture' }] } })) }) } }, workspaces: createDshWorkspaces(ctx) });
  const requests = [], executions = [], plans = [];
  let active, fresh, unregistered;
  const create = id => ctx.agents.create({ sessionId: sessions.SessionId(id), meta: { cwd: workspace, agentPreset: 'ptc' }, agentOptions: { provider: 'offline-workspace', model: id }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, 'ptc'); ctx.permissionPresets.set(agent.session, 'workspace-write'); } });
  try {
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        requests.push(structuredClone(request));
        const last = request.messages.at(-1);
        if (last?.role === 'tool') {
          executions.push(last.content[0].text);
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '离线验收完成' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } else {
          assert.deepEqual(request.tools.map(t => t.name), ['run_code']);
          const code = plans.shift(); assert.ok(code, 'every offline model request has a scripted tool action');
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${requests.length}`, name: 'run_code', arguments: JSON.stringify({ code, description: '离线验收看点什么查询与存稿' }) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        }
      }
    }
    ctx.llm.registerAdapter(['offline-workspace'], new Offline());
    active = await create('ordinary-active');
    assert.equal(store.sessionBinding(String(active.agent.session.id)), null);
    await installAgentTools(ctx, service);
    const send = async (handle, code) => {
      plans.push(code); handle.agent.followup(llm.createUserMessage({ source: { kind: 'offline-test', form: 'instructions' }, content: [{ type: 'text', text: '执行本轮已安排的离线工具验收' }] }));
      await handle.agent.whenIdle(); await ctx.sessions.flush(handle.agent.session);
      const result = executions.at(-1); assert.ok(result); return result;
    };
    assert.ok(ctx.tools.schemas(active.agent).some(t => t.name === 'dmc_read_item'));
    assert.deepEqual(JSON.parse(await send(active, 'return await tools.dmc_read_item({section:"sources"});')).sources, []);
    assert.match(JSON.stringify(requests[0].messages), /看点什么 \/ Message Console/);
    assert.match(JSON.stringify(requests[0].messages), /HOST_WORKSPACE_POLICY_SENTINEL/);
    const source = await service.saveSource({ workspaceId: registeredWorkspace.id, name: '本工作区视频', platform: 'bilibili', target: 'BV1111111111', types: ['comment'], stageContexts: { generation: { context: 'WORKSPACE_GENERATION' }, supervision: { context: 'SUPERVISOR_PRIVATE' } } });
    await service.refresh(source.id, { organize: false });
    const sources = JSON.parse(await send(active, 'return await tools.dmc_read_item({section:"sources"});'));
    assert.deepEqual(sources.sources.map(s => s.id), [source.id], 'existing active session discovers newly created source');
    const items = JSON.parse(await send(active, `return await tools.dmc_read_item({section:'items',sourceId:${JSON.stringify(source.id)}});`)).items;
    const header = JSON.parse(await send(active, `return await tools.dmc_read_item({itemId:${JSON.stringify(items[0].id)},section:'item'});`));
    assert.ok(header.contextVersion); assert.equal(header.analysis, null);
    assert.match(await send(active, `return await tools.dmc_read_item({itemId:${JSON.stringify(items[0].id)},section:'comment',commentId:'reply-1'});`), /REPLY-1/);
    const context = await send(active, `return await tools.dmc_read_item({sourceId:${JSON.stringify(source.id)},section:'context'});`);
    assert.match(context, /WORKSPACE_GENERATION/); assert.doesNotMatch(context, /SUPERVISOR_PRIVATE/);
    const save = (item, key, extra = {}) => ({ kind: 'draft', operationKey: key, itemId: item.id, version: item.version, contextVersion: header.contextVersion, body: `草稿-${key}`, ...extra });
    const callSave = value => `return await tools.dmc_submit_result(${JSON.stringify(value)});`;
    const firstInput = save(items[0], 'first'), first = JSON.parse(await send(active, callSave(firstInput)));
    assert.equal(first.draft.status, 'pending-supervision'); assert.equal(service.draft(first.draftId).itemId, items[0].id);
    const second = JSON.parse(await send(active, callSave(save(items[1], 'second'))));
    assert.equal(service.draft(second.draftId).itemId, items[1].id);
    assert.equal(store.sessionBinding('ordinary-active'), null, 'ordinary session does not become managed by saving');
    assert.equal(service.runs(items[0].id).items[0].sessions[0].sessionId, 'ordinary-active');
    assert.equal(service.runs(items[1].id).items[0].sessions[0].sessionId, 'ordinary-active');
    assert.equal(service.drafts(items[0].id).items[0].id, first.draftId, 'same paginated draft endpoint used by UI sees saved draft');
    assert.match(await send(active, callSave(save(items[1], 'first'))), /相同操作键/);
    assert.match(await send(active, callSave(save(items[1], 'bad-cas', { replacesDraftId: first.draftId, bodyHash: first.draft.bodyHash }))), /旧草稿/);
    assert.equal(service.runs(items[1].id).total, 1, 'failed replacement rolls back the new run');
    const { setSandboxMode } = await f.load('dsh-sandbox-policy');
    setSandboxMode(active.agent.session, 'read-only');
    assert.match(await send(active, callSave(save(items[0], 'readonly'))), /只读/);
    assert.match(await send(active, `return await tools.dmc_read_item({itemId:${JSON.stringify(items[0].id)},section:'body'});`), /ROOT-1/);
    setSandboxMode(active.agent.session, 'workspace-write'); ctx.agentPresets.serviceFor(active.agent, 'planMode').set(active.agent, true);
    assert.match(await send(active, callSave(save(items[0], 'plan'))), /计划模式/);
    ctx.agentPresets.serviceFor(active.agent, 'planMode').set(active.agent, false);
    assert.equal(service.drafts(items[0].id).total, 1);
    await active.dispose(); active = null;
    await store.close(); await store.start();
    active = await ctx.agents.resume({ resumeSessionId: sessions.SessionId('ordinary-active'), agentOptions: { provider: 'offline-workspace', model: 'cold' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    assert.equal(ctx.agentPresets.composedPreset(active.agent.ctx), 'ptc');
    const retry = JSON.parse(await send(active, callSave(firstInput))); assert.equal(retry.id, first.id); assert.equal(service.runs(items[0].id).total, 1);
    const replacement = JSON.parse(await send(active, callSave(save(items[0], 'replace', { replacesDraftId: first.draftId, bodyHash: first.draft.bodyHash }))));
    assert.equal(service.draft(first.draftId).status, 'superseded'); assert.equal(replacement.draft.status, 'pending-supervision');
    const persisted = await ctx.sessionQuery.readSession('ordinary-active');
    assert.ok(persisted.events.some(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'dmc_read_item'));
    assert.ok(persisted.events.some(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'dmc_submit_result'));
    assert.equal(persisted.events.some(e => e.type === 'user/message' && e.data.source?.purpose === 'human-background'), false);
    fresh = await create('ordinary-new');
    assert.deepEqual(JSON.parse(await send(fresh, 'return await tools.dmc_read_item({section:"sources"});')).sources.map(s => s.id), [source.id]);
    const otherPath = join(f.directory, 'other-workspace'); await mkdir(otherPath); const other = await ctx.workspaceRegistry.create(otherPath, 'Other workspace');
    const foreignSource = await service.saveSource({ workspaceId: other.id, name: '另一工作区视频', platform: 'bilibili', target: 'BV1111111112', types: ['comment'] }); await service.refresh(foreignSource.id, { organize: false });
    const foreignItem = service.items(foreignSource.id).items[0];
    assert.match(await send(fresh, `return await tools.dmc_read_item({itemId:${JSON.stringify(foreignItem.id)},section:'body'});`), /当前已有工作区/);
    assert.match(await send(fresh, callSave(save(foreignItem, 'foreign'))), /当前已有工作区/);
    const ordinarySchema = ctx.tools.schemas(fresh.agent).find(t => t.name === 'dmc_submit_result'); assert.deepEqual(ordinarySchema.parameters.properties.kind.enum, ['draft']);
    assert.equal(ctx.tools.schemas(fresh.agent).some(t => /publish/.test(t.name)), false);
    await service.saveSource({ ...service.source(source.id), workspaceId: other.id }, source.id);
    assert.deepEqual(JSON.parse(await send(active, 'return await tools.dmc_read_item({section:"sources"});')).sources, []);
    assert.match(await send(active, callSave(firstInput)), /当前已有工作区/, 'a receipt cannot be replayed after source leaves workspace');
    unregistered = await ctx.agents.create({ sessionId: sessions.SessionId('outside-workspaces'), meta: { cwd: '/', agentPreset: 'ptc' }, agentOptions: { provider: 'offline-workspace', model: 'outside' }, async setup(agentCtx) { await ctx.agentPresets.mount(agentCtx, 'ptc'); } });
    assert.deepEqual(JSON.parse(await send(unregistered, 'return await tools.dmc_read_item({section:"sources"});')).sources, []);
  } finally { await active?.dispose(); await fresh?.dispose(); await unregistered?.dispose(); await service.close(); await rm(directory, { recursive: true, force: true }); await f.close(); }
});
