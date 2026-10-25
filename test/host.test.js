import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile, symlink, mkdtemp, rm } from 'node:fs/promises';
import { installAgentTools, assertAgentWritable, assertStorageOutsideWorkspace } from '../src/agent-tools.js';
import { hostFixture } from './host-fixture.js';

const root = process.env.DMC_DSH_ROOT;
const analysis = { summary: '保存的分析', importance: 1, urgent: false, urgencyReason: null, reason: '原文证据', intervention: 'review', evidence: 'confirmed' };
const wireTool = (request, call) => request.tools.some(tool => tool.name === 'run_code')
  ? { name: 'run_code', arguments: JSON.stringify({ code: `return await tools.${call.name}(${JSON.stringify(call.arguments)});`, description: '查询或保存本轮结果' }) }
  : { name: call.name, arguments: JSON.stringify(call.arguments) };
const submission = { kind: 'analysis', operationKey: 'result', analysis, draftBody: '保存的草稿' };

test('stock host scopes actual tools, workspace permissions, AGENTS and durable result submission across cold resume', { skip: !root, timeout: 30_000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, sessions, workspace, registeredWorkspace, load } = f;
  const escapedRoot = await mkdtemp(join(resolve('.local'), 'host-escape-'));
  const bindings = new Map(), receipts = new Map(), writes = [], requests = [], counts = new Map(), ids = [];
  const service = {
    store: { settings: () => ({writerProvider:'offline',writerModel:'transport-failure'}) },
    storageDirectory:()=>resolve('.local'),
    bindSession(binding) { bindings.set(binding.sessionId, binding); },
    sessionBinding(id, cwd) { const b = bindings.get(id); if (b && cwd !== b.cwd) throw new Error('cwd mismatch'); return b; },
    readFromSession({ sessionId }) { assert.ok(bindings.has(sessionId)); return { version: 'v1', text: 'COLLECTED_COMMENT_ORIGINAL', complete: true }; },
    async submitFromSession({ sessionId, callId, assertWritable }, value) {
      assertWritable(); writes.push({ sessionId, callId, value });
      const result = value.kind === 'supervision' ? { approved: value.approved, reason: value.reason } : value.analysis;
      const receipt = { id: `receipt-${writes.length}`, sessionId, runId: bindings.get(sessionId).runId, kind: value.kind, result };
      receipts.set(sessionId, receipt); return receipt;
    },
    requireSubmission(id) { const result = receipts.get(id); if (!result) throw new Error('本轮没有通过工具保存结果'); return result; },
    endSession() {},
    sessionBackground(){return null;},
    item(){return {kind:"comment"};},
  };
  try {
    await installAgentTools(ctx, service);
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        requests.push(structuredClone(request));
        if (request.model === 'transport-failure') throw new llm.LlmError('offline connection reset', 'TRANSPORT');
        const count = (counts.get(request.model) ?? 0) + 1; counts.set(request.model, count);
        let tool;
        if (request.model === 'writer' && count === 1) tool = { name: 'dmc_read_item', arguments: { section: 'comment', commentId: 'comment-id', version: 'v1' } };
        else if (request.model === 'writer' && count === 2) {
          assert.match(request.messages.findLast(message => message.role === 'tool').content[0].text, /COLLECTED_COMMENT_ORIGINAL/);
          tool = { name: 'dmc_submit_result', arguments: submission };
        } else if (request.model === 'supervisor' && count === 1) tool = { name: 'dmc_submit_result', arguments: { kind: 'supervision', operationKey: 'verdict', approved: false, reason: '缺少依据' } };
        else if (['readonly', 'plan'].includes(request.model) && count === 1) tool = { name: 'dmc_submit_result', arguments: submission };
        else if (request.model === 'human' && count === 1) tool = { name: 'dmc_submit_result', arguments: { kind: 'draft', operationKey: 'human-draft', body: '人工讨论存稿' } };
        if (tool) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${requests.length}`, ...wireTool(request, tool) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"summary":"not a saved result"}' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    ctx.llm.registerAdapter(['offline'], new Offline());
    const executorOwner = await f.executorOwner(service), { executor } = executorOwner;
    const request = { runId: 'run-1', workspaceId: registeredWorkspace.id, input: { body: 'UNTRUSTED_SOURCE' }, instructions: 'ROLE_writer。使用保存工具。', provider: 'offline', model: 'writer', role: 'writer', title: 'writer', onSession: id => ids.push(id) };
    const result = await executor.runAgent(request); assert.deepEqual(result.result, analysis); assert.equal(writes.length, 1);
    assert.equal(writes[0].callId, 'call-2:ptc:1');
    const stored = await ctx.sessionQuery.readSession(ids[0]);
    assert.equal((await ctx.sessionPersistence.list()).find(row=>row.header.id===ids[0]).header.agentPreset, 'ptc');
    assert.ok(stored.events.some(e => e.type === 'tool/call')); assert.ok(stored.events.some(e => e.type === 'tool/result'));
    assert.ok(!stored.events.some(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'text')));
    const first = requests[0];
    assert.deepEqual(first.tools.map(tool => tool.name), ['run_code']);
    for (const name of ['bash', 'read', 'write', 'edit', 'dmc_read_item', 'dmc_submit_result']) assert.match(JSON.stringify(first.messages), new RegExp(name));
    for (const name of ['dmc_read_item', 'dmc_submit_result']) assert.ok(stored.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === name));
    assert.match(JSON.stringify(first.messages), /HOST_WORKSPACE_POLICY_SENTINEL/);
    assert.match(JSON.stringify(first.messages), /workspace-write/); assert.match(JSON.stringify(first.messages), /Approval policy: ask/);
    const supervisor = await executor.runAgent({ ...request, role: 'supervisor', model: 'supervisor', draftId: 'draft-1', instructions: 'ROLE_supervisor', input: { draft: 'SAVED_DRAFT' } });
    assert.equal(supervisor.result.approved, false); assert.equal(writes.length, 2);
    await assert.rejects(executor.runAgent({ ...request, model: 'no-submit' }), /通过工具保存/);
    let failedId;
    await assert.rejects(executor.runAgent({ ...request, model: 'transport-failure', onSession: id => { failedId = id; } }), e => e.sessionFailure?.code === 'TRANSPORT');
    const failed = await ctx.sessionQuery.readSession(failedId); assert.equal(failed.events.at(-1).data.reason.error.code, 'TRANSPORT');

    const humanId = await executor.conversation({ runId: 'human-run', source: { name: 'source', workspaceId: registeredWorkspace.id }, item: { title: 'Human', body: 'HUMAN_BACKGROUND' }, settings: { writerProvider: 'offline', writerModel: 'human' } });
    assert.equal(counts.get('human'), undefined);
    await executorOwner.dispose();
    const resumed = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(humanId), agentOptions: { provider: 'offline', model: 'human' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    assert.equal(ctx.agentPresets.composedPreset(resumed.agent.ctx), 'ptc');
    assert.ok(ctx.tools.schemas(resumed.agent).some(t => t.name === 'dmc_submit_result'));
    await ctx.agentPresets.select(resumed.agent, 'standard');
    const { setSandboxMode } = await load('dsh-sandbox-policy');
    setSandboxMode(resumed.agent.session, 'read-only'); await ctx.sessions.flush(resumed.agent.session); await resumed.dispose();
    const cold = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(humanId), agentOptions: { provider: 'offline', model: 'human' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    assert.equal(ctx.agentPresets.composedPreset(cold.agent.ctx), 'standard', 'cold resume respects the user selection over the new-session PTC default');
    assert.equal(ctx.sandboxPolicy.resolve({ session: cold.agent.session }).mode, 'read-only');
    assert.throws(() => assertAgentWritable(ctx, cold.agent), /只读/);
    const inside = await ctx.fs.resolve(join(workspace, 'notes.txt'));
    await assert.rejects(ctx.fs.writeText(inside, 'forbidden', undefined, undefined, ctx.sandboxPolicy.resolve({ session: cold.agent.session })), e => e.code === 'FS_SANDBOX_DENIED');
    setSandboxMode(cold.agent.session, 'workspace-write');
    await ctx.fs.writeText(inside, 'allowed', undefined, undefined, ctx.sandboxPolicy.resolve({ session: cold.agent.session })); assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'allowed');
    await symlink(escapedRoot, join(workspace, 'escape'));
    for (const path of [join(escapedRoot, 'NEVER-WRITE-HOST'), join(workspace, 'escape', 'NEVER-WRITE-HOST')]) await assert.rejects(ctx.fs.writeText(await ctx.fs.resolve(path), 'forbidden', undefined, undefined, ctx.sandboxPolicy.resolve({ session: cold.agent.session })), e => e.code === 'FS_SANDBOX_DENIED');
    const plan = ctx.agentPresets.serviceFor(cold.agent, 'planMode');
    assert.equal(cold.agent.ctx.get('planMode'), undefined); plan.set(cold.agent, true);
    assert.throws(() => assertAgentWritable(ctx, cold.agent), /计划模式/);
    const blockedTool = ctx.tools.get('dmc_submit_result', cold.agent), before = writes.length;
    await assert.rejects(blockedTool.execute({ kind: 'draft', operationKey: 'forbidden-plan', body: 'no' }, { agent: cold.agent, callId: 'plan-denial' }), /计划模式/);
    const alien = await ctx.agents.create({ sessionId: sessions.SessionId('ordinary-session'), meta: { cwd: workspace }, agentOptions: { provider: 'offline', model: 'human' } });
    assert.ok(ctx.tools.schemas(alien.agent).some(t => t.name === 'dmc_read_item'));
    assert.deepEqual(ctx.tools.schemas(alien.agent).find(t => t.name === 'dmc_submit_result').parameters.properties.kind.enum, ['draft']);
    await assert.rejects(blockedTool.execute({ kind: 'draft', operationKey: 'foreign', body: 'no' }, { agent: alien.agent, callId: 'foreign' }), /不匹配/);
    assert.throws(() => ctx.tools.get('dmc_read_item', cold.agent).execute({}, { agent: alien.agent }), /不匹配/);
    assert.equal(writes.length, before); await alien.dispose();
    plan.set(cold.agent, false);
    cold.agent.followup(llm.createUserMessage({ source: { kind: 'test', form: 'instructions' }, content: [{ type: 'text', text: 'Save a draft now' }] }));
    await cold.agent.whenIdle(); await ctx.sessions.flush(cold.agent.session);
    assert.equal(writes.at(-1).value.kind, 'draft'); assert.equal(counts.get('human'), 2, 'human save leaves room for a conversational response');
    await cold.dispose();
  } finally { await f.close(); await rm(escapedRoot, { recursive: true, force: true }); }
});

test('PTC host tools read collected comments and commit immutable drafts and independent supervision to SQLite', { skip: !root, timeout: 30_000 }, async () => {
  const { Store } = await import('../src/store.js'), { ConsoleService } = await import('../src/core.js');
  const f = await hostFixture(root), { ctx, llm, sessions, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'host-sqlite-')), store = await new Store(directory).start();
  let service, reopened, publicationCalls = 0;
  let descriptionText = '';
  const requests = [], counts = new Map(), commentId = '9223372036854775808', videoDescription = '模型可读视频简介📺';
  try {
    ctx.provide('decisionModels', { async ask() { return { answers: { reply: { probabilities: { ignore: 0, draft: 1, human: 0 } } } }; } });
    const executorOwner = await f.executorOwner(() => service), { executor } = executorOwner;
    const connector = {
      status: () => ({ ready: true, canPublish: false }),
      async fetch() { return { complete: true, items: [{ remoteId: 'root-comment', kind: 'comment', title: '实际入库原文', body: 'ROOT_ORIGINAL', payload: { video: { title: '测试视频', description: videoDescription }, comments: [{ id: commentId, author: 'fixture', body: 'EXACT_COLLECTED_REPLY_ORIGINAL' }] } }] }; },
      async publish() { publicationCalls++; throw new Error('must not publish'); },
    };
    service = new ConsoleService({ store, executor, connectors: { bilibili: connector }, workspaces: { resolve: id => ctx.workspaceRegistry.get(id) } });
    await installAgentTools(ctx, service);
    class OfflineDatabase extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        requests.push(structuredClone(request));
        const count = (counts.get(request.model) ?? 0) + 1; counts.set(request.model, count);
        let call;
        if (request.model === 'db-writer' && count === 1) call = { name: 'dmc_read_item', arguments: { section: 'comment', commentId } };
        else if (request.model === 'db-writer' && count === 2) {
          assert.match(JSON.stringify(request.messages), /EXACT_COLLECTED_REPLY_ORIGINAL/);
          call = { name: 'dmc_read_item', arguments: { section: 'item' } };
        } else if (request.model === 'db-writer' && count === 3) {
          const header = JSON.parse(request.messages.findLast(message => message.role === 'tool').content[0].text);
          assert.ok(header.payload.video.descriptionLength > 0);
          call = { name: 'dmc_read_item', arguments: { section: 'video-description', version: header.version, offset: 0, length: Math.min(4, header.payload.video.descriptionLength) } };
        } else if (request.model === 'db-writer' && count === 4) {
          const description = JSON.parse(request.messages.findLast(message => message.role === 'tool').content[0].text);
          assert.equal(description.complete, false);
          descriptionText = description.text;
          call = { name: 'dmc_read_item', arguments: { section: 'video-description', version: description.version, offset: description.nextOffset, length: 10 } };
        } else if (request.model === 'db-writer' && count === 5) {
          const description = JSON.parse(request.messages.findLast(message => message.role === 'tool').content[0].text);
          assert.equal(descriptionText + description.text, videoDescription); assert.equal(description.complete, true);
          call = { name: 'dmc_submit_result', arguments: submission };
        } else if (request.model === 'db-supervisor') {
          const pending = service.draft(service.drafts(service.items(source.id).items[0].id).items[0].id);
          assert.equal(pending.status, 'pending-supervision'); assert.equal(pending.body, '保存的草稿');
          call = { name: 'dmc_submit_result', arguments: { kind: 'supervision', operationKey: 'check', approved: true, reason: '事实充分' } };
        } else if (request.model === 'db-human-readonly' && count === 1) call = { name: 'dmc_read_item', arguments: { section: 'comment', commentId } };
        else if ((request.model === 'db-human-readonly' && count === 2) || (request.model.startsWith('db-human') && request.model !== 'db-human-readonly' && count === 1)) {
          if (request.model === 'db-human-readonly') assert.match(request.messages.findLast(message => message.role === 'tool').content[0].text, /EXACT_COLLECTED_REPLY_ORIGINAL/);
          call = { name: 'dmc_submit_result', arguments: { kind: 'draft', operationKey: 'human-save', body: '新人工稿，仍待监督' } };
        }
        if (call) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `db-call-${requests.length}`, ...wireTool(request, call) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '讨论完成，正式结果已由工具处理。' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    ctx.llm.registerAdapter(['offline-db'], new OfflineDatabase());
    await service.configure({ writerProvider: 'offline-db', writerModel: 'db-writer', supervisorProvider: 'offline-db', supervisorModel: 'db-supervisor', decisionConfidence: .8, decisionMargin: .2 });
    const source = await service.saveSource({ name: '真实宿主工具测试', workspaceId: registeredWorkspace.id, platform: 'bilibili', target: 'BV1111111111', types: ['comment'], stageContexts: { generation: { context: 'WRITER_CONTEXT_ONLY' }, supervision: { context: 'SUPERVISOR_CONTEXT_ONLY' } } });
    await service.refresh(source.id, { organize: false });
    const humanEntry = await service.openConversation(service.items(source.id).items[0].id);
    const report = await service.organize(source.id, { scope: 'history' }); assert.equal(report.failed, 0, JSON.stringify(report)); assert.equal(report.completed, 1);
    const item = service.items(source.id).items[0], run = service.runs(item.id).items[0];
    const draft = service.draft(service.drafts(item.id).items[0].id);
    assert.equal(item.analysis.summary, analysis.summary); assert.equal(draft.status, 'ready'); assert.equal(draft.approvedAt, undefined);
    assert.equal(run.sessions.length, 2); assert.equal(publicationCalls, 0);
    assert.equal(service.comments(item.id).items[0].id, commentId);
    assert.match(JSON.stringify(requests.find(r => r.model === 'db-writer').messages), /WRITER_CONTEXT_ONLY/);
    assert.doesNotMatch(JSON.stringify(requests.find(r => r.model === 'db-writer').messages), /SUPERVISOR_CONTEXT_ONLY/);
    assert.match(JSON.stringify(requests.find(r => r.model === 'db-supervisor').messages), /SUPERVISOR_CONTEXT_ONLY/);
    for (const link of run.sessions) {
      const log = await ctx.sessionQuery.readSession(link.sessionId);
      assert.ok(log.events.some(e => e.type === 'tool/result'));
      assert.ok(log.events.some(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'dmc_submit_result'));
      assert.equal((await ctx.sessionPersistence.list()).find(row => row.header.id === link.sessionId).header.agentPreset, 'ptc');
      assert.ok(!log.events.some(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'text')));
    }
    await service.configure({ writerProvider: 'offline-db', writerModel: 'db-human-readonly', supervisorProvider: 'offline-db', supervisorModel: 'db-supervisor' });
    assert.equal((await service.openConversation(item.id)).sessionId, run.sessions.find(link => link.role === 'writer').sessionId);
    const { sessionId } = humanEntry;
    await executorOwner.dispose();
    const { setSandboxMode } = await f.load('dsh-sandbox-policy');
    let human = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(sessionId), agentOptions: { provider: 'offline-db', model: 'db-human-readonly' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    const pendingBackground = agent => agent.inbox.nextStep.filter(message => message.source?.purpose === 'human-background');
    assert.equal(pendingBackground(human.agent).length, 1);
    assert.equal(counts.get('db-human-readonly'), undefined, 'cold attachment does not wake the model');
    await ctx.sessions.flush(human.agent.session); await human.dispose();
    human = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(sessionId), agentOptions: { provider: 'offline-db', model: 'db-human-readonly' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    assert.equal(pendingBackground(human.agent).length, 1, 'repeated cold attachment restores one pending background');
    const send = () => human.agent.followup(llm.createUserMessage({ source: { kind: 'test', form: 'instructions' }, content: [{ type: 'text', text: '保存人工稿' }] }));
    setSandboxMode(human.agent.session, 'read-only'); send(); await human.agent.whenIdle(); await ctx.sessions.flush(human.agent.session);
    const firstHumanRequest = requests.find(request => request.model === 'db-human-readonly');
    const backgroundIndex = firstHumanRequest.messages.findIndex(message => message.source?.purpose === 'human-background');
    const userIndex = firstHumanRequest.messages.findIndex(message => message.source?.kind === 'test');
    assert.equal(firstHumanRequest.messages[0].role, 'system'); assert.ok(backgroundIndex > 0 && userIndex > backgroundIndex,JSON.stringify(firstHumanRequest.messages.map(m=>({role:m.role,source:m.source,text:m.content?.[0]?.text?.slice(0,90)}))));
    assert.equal(firstHumanRequest.messages.filter(message => message.source?.purpose === 'human-background').length, 1);
    assert.equal(service.drafts(item.id).total, 1);
    assert.equal(ctx.agentPresets.composedPreset(human.agent.ctx), 'ptc');
    assert.ok(human.agent.session.snapshotEvents().some(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'dmc_read_item'));
    assert.ok(human.agent.session.snapshotEvents().some(e => e.type === 'tool/result' && e.data.message.isError));
    await human.dispose();
    human = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(sessionId), agentOptions: { provider: 'offline-db', model: 'db-human-plan' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    assert.equal(pendingBackground(human.agent).length, 0, 'accepted background is not injected again');
    assert.equal(ctx.sandboxPolicy.resolve({ session: human.agent.session }).mode, 'read-only');
    setSandboxMode(human.agent.session, 'workspace-write'); ctx.agentPresets.serviceFor(human.agent, 'planMode').set(human.agent, true);
    send(); await human.agent.whenIdle(); await ctx.sessions.flush(human.agent.session); assert.equal(service.drafts(item.id).total, 1); await human.dispose();
    human = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(sessionId), agentOptions: { provider: 'offline-db', model: 'db-human-save' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    assert.equal(ctx.agentPresets.serviceFor(human.agent, 'planMode').get(human.agent).active, true);
    ctx.agentPresets.serviceFor(human.agent, 'planMode').set(human.agent, false); send(); await human.agent.whenIdle(); await ctx.sessions.flush(human.agent.session);
    const saved = service.drafts(item.id).items.map(d=>service.draft(d.id)).find(d => d.body === '新人工稿，仍待监督'); assert.equal(saved.status, 'pending-supervision');
    assert.equal(service.drafts(item.id).total, 2); assert.equal(publicationCalls, 0); await human.dispose();
    const humanLog = await ctx.sessionQuery.readSession(sessionId);
    assert.equal(humanLog.events.filter(event => event.type === 'user/message' && event.data.source?.purpose === 'human-background').length, 1);
    await service.close(); service = undefined;
    reopened = await new Store(directory).start();
    assert.equal(reopened.draft(draft.id).status, 'ready'); assert.equal(reopened.draft(saved.id).status, 'pending-supervision'); assert.equal(reopened.draft(saved.id).body, saved.body);
  } finally { if (service) await service.close(); else if (!reopened) await store.close(); await reopened?.close(); await rm(directory,{recursive:true,force:true}); await f.close(); }
});


test('storage boundary canonicalizes workspace and storage symlinks and excludes standard temporary roots', async () => {
  const directory = await mkdtemp(join(resolve('.local'), 'storage-boundary-'));
  const { tmpdir } = await import('node:os');
  const temporary = await mkdtemp(join(tmpdir(), 'dmc-storage-boundary-'));
  try {
    await assertStorageOutsideWorkspace(directory, temporary);
    await assert.rejects(assertStorageOutsideWorkspace(directory, resolve('.local')), /存储目录位于 Agent 可写范围/);
    await assert.rejects(assertStorageOutsideWorkspace(directory, directory), /存储目录位于 Agent 可写范围/);
    await assert.rejects(assertStorageOutsideWorkspace(temporary, directory), /存储目录位于 Agent 可写范围/);
    await symlink(resolve('.local'), join(temporary, 'workspace-alias'));
    await assert.rejects(assertStorageOutsideWorkspace(directory, join(temporary, 'workspace-alias')), /存储目录位于 Agent 可写范围/);
    await symlink(temporary, join(directory, 'storage-alias'));
    await assert.rejects(assertStorageOutsideWorkspace(join(directory, 'storage-alias'), temporary), /存储目录位于 Agent 可写范围/);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true }); }
});
