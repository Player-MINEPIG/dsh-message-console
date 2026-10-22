import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostFixture } from './host-fixture.js';
import { installAgentTools } from '../src/agent-tools.js';
import { createDshExecutor, createDshWorkspaces } from '../src/dsh.js';
import { WorkflowExecutor } from '../src/executor.js';
import { prepareSource } from '../src/source-context.js';
import { assembleInput } from '../src/input-assembly.js';
import { validateSettings, resolveSettings, valuesOf } from '../src/config.js';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';

const root = process.env.DMC_DSH_ROOT;
const source = { id: 'source-a', workspaceId: 'workspace-a', name: '视频来源', platform: 'bilibili', types: ['comment'], settings: {}, context: 'SOURCE_BACKGROUND', materials: [] };
const guidance = 'CONFIRMED_COMMON_GUIDANCE';

test('confirmed guidance validates, inherits, changes context version and reaches all preview stages', async () => {
  assert.deepEqual(validateSettings({ learningGuidance: guidance }), { learningGuidance: guidance });
  assert.throws(() => validateSettings({ learningGuidance: 'x'.repeat(10001) }), /过长/);
  const settings = valuesOf(resolveSettings({ learningGuidance: guidance }, source));
  const before = await prepareSource(source, { path: '/unused' });
  const after = await prepareSource(source, { path: '/unused' }, settings);
  assert.notEqual(before.contextVersion, after.contextVersion);
  assert.equal(after.learningGuidance, guidance);
  for (const stage of ['decision', 'escalation', 'generation', 'supervision']) assert.equal(assembleInput(after, null, { stage }).learningGuidance, guidance);
  const override = valuesOf(resolveSettings({ learningGuidance: guidance }, { ...source, settings: { learningGuidance: '' } }));
  assert.equal(override.learningGuidance, '');
  assert.equal((await prepareSource(source, { path: '/unused' }, override)).contextVersion, before.contextVersion);
});

test('confirmed guidance enters trusted Jev, escalation, writer and supervisor instructions', async () => {
  let decision;
  const calls = [];
  const executor = new WorkflowExecutor({
    decision: async request => { decision = request; return { answers: { reply: { probabilities: { ignore: .4, draft: .5, human: .1 } } } }; },
    runAgent: async request => {
      calls.push(request);
      if (request.role === 'decision-escalation') return { result: { choice: 'draft', certain: true, reason: '已有依据' } };
      if (request.role === 'supervisor') return { result: { approved: true, reason: '有依据' } };
      return { result: { summary: '整理结果', importance: 1, reason: '依据原文', urgent: false, urgencyReason: null, intervention: 'review', evidence: 'confirmed' }, draftId: 'd', draft: { id: 'd', body: '回复正文' } };
    },
  });
  await executor.analyze({ source: { ...source, learningGuidance: guidance }, item: { kind: 'comment', body: 'UNTRUSTED_BODY' }, settings: { writerProvider: 'p', writerModel: 'm', decisionConfidence: .8, decisionMargin: .2 }, recordDecision: async () => {} });
  assert.match(decision.questions.reply.instructions, new RegExp(guidance));
  assert.doesNotMatch(decision.questions.reply.instructions, /UNTRUSTED_BODY/);
  assert.equal(JSON.parse(decision.state).learningGuidance, guidance);
  assert.deepEqual(calls.map(call => call.role), ['decision-escalation', 'writer', 'supervisor']);
  for (const call of calls) {
    assert.match(call.instructions, new RegExp(guidance));
    assert.equal(call.input.learningGuidance, guidance);
    assert.doesNotMatch(call.instructions, /UNTRUSTED_BODY/);
  }
});

test('learning uses the writer route and dedicated batch role, and cannot substitute assistant text for submission', async () => {
  let request;
  const executor = new WorkflowExecutor({ runAgent: async value => { request = value; return { proposal: { status: 'pending' } }; } });
  const result = await executor.learn({ batchId: 'batch-a', source, settings: { writerProvider: 'p', writerModel: 'm' } });
  assert.equal(result.proposal.status, 'pending');
  assert.equal(request.role, 'learning'); assert.equal(request.batchId, 'batch-a'); assert.equal(request.runId, undefined);
  assert.equal(request.workspaceId, source.workspaceId); assert.equal(request.provider, 'p'); assert.equal(request.model, 'm');
  assert.match(request.instructions, /dmc_propose_learning/);
  assert.match(request.instructions, /不能声称已学习/);
  await assert.rejects(executor.learn({ batchId: 'batch-a', source, settings: {} }), /模型路由/);
});

test('real PTC learning tools preserve proposal receipts and session history without an apply tool', { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, sessions, registeredWorkspace, workspace } = f;
  const bindings = new Map(), receipts = new Map(), requests = [], actions = [];
  let writes = 0, sessionId;
  const proposal = { operationKey: 'confirmed-proposal', summary: '依据评价补充背景', changes: [{ target: 'source', field: 'context', after: 'PROPOSED_ONLY', caseIds: ['case-a'] }] };
  const bindingFor = (id, cwd) => {
    const binding = bindings.get(id);
    if (binding && cwd !== undefined && binding.cwd !== cwd) return null;
    return binding;
  };
  const service = {
    storageDirectory: () => resolve('.local'),
    bindLearningSession(binding) { assert.equal(binding.workspaceId, registeredWorkspace.id); assert.equal(binding.cwd, registeredWorkspace.path); bindings.set(binding.sessionId, { ...binding, role: 'learning', sourceId: source.id }); },
    sessionBinding: bindingFor,
    readLearningFromSession({ sessionId: id, actualCwd }, args) {
      assert.ok(bindingFor(id, actualCwd));
      if (args.section === 'batch') return { id: 'batch-a', caseCount: 1, source: { ...source, context: 'UNCHANGED_CONFIG' } };
      assert.equal(args.section, 'cases'); return { items: [{ id: 'case-a', text: '用户要求详细解释依据' }], page: 1, pageCount: 1 };
    },
    proposeLearningFromSession({ sessionId: id, actualCwd, callId, assertWritable }, submission) {
      assertWritable(); assert.ok(bindingFor(id, actualCwd)); assert.match(callId, /:ptc:/);
      const replay = receipts.get(id);
      if (replay) { assert.deepEqual(submission, proposal); return replay; }
      writes++;
      const receipt = { id: 'learning-receipt', sessionId: id, batchId: 'batch-a', proposal: { ...submission, revision: 1, status: 'pending' } };
      receipts.set(id, receipt); return receipt;
    },
    requireLearningSubmission(id) { const receipt = receipts.get(id); if (!receipt) throw new Error('尚未通过学习工具保存建议'); return receipt; },
    endSession() {},
  };
  let resumed, ordinary;
  try {
    await installAgentTools(ctx, service);
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        requests.push(structuredClone(request));
        const last = request.messages.at(-1);
        if (last?.role === 'tool') {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '已有结果；等待用户在插件确认' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } else {
          assert.deepEqual(request.tools.map(tool => tool.name), ['run_code']);
          const code = actions.shift(); assert.ok(code);
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${requests.length}`, name: 'run_code', arguments: JSON.stringify({ code, description: '学习工具离线验收' }) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        }
      }
    }
    ctx.llm.registerAdapter(['offline-learning'], new Offline());
    const executorOwner = await f.executorOwner(service), { executor } = executorOwner;
    actions.push(`const batch = await tools.dmc_read_learning({section:'batch'}); const cases = await tools.dmc_read_learning({section:'cases',page:1,pageSize:10}); return {batch,cases,hasApply:typeof tools.dmc_apply_learning !== 'undefined',proposal:await tools.dmc_propose_learning(${JSON.stringify(proposal)})};`);
    const receipt = await executor.learn({ batchId: 'batch-a', source: { ...source, workspaceId: registeredWorkspace.id }, settings: { writerProvider: 'offline-learning', writerModel: 'm' }, recordSession: id => { sessionId = id; } });
    assert.equal(receipt.id, 'learning-receipt'); assert.equal(receipt.proposal.status, 'pending'); assert.equal(writes, 1);
    assert.equal(bindings.get(sessionId).runId, undefined);
    assert.match(JSON.stringify(requests[0].messages), /HOST_WORKSPACE_POLICY_SENTINEL/);
    assert.match(JSON.stringify(requests[0].messages), /workspace-write/);
    assert.match(JSON.stringify(requests[0].messages), /Approval policy: ask/);
    const stored = await ctx.sessionQuery.readSession(sessionId);
    assert.ok(stored.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'dmc_read_learning'));
    assert.ok(stored.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'dmc_propose_learning'));
    assert.match(JSON.stringify(stored.events), /hasApply.*false/);
    assert.equal((await ctx.sessionPersistence.list()).find(row => row.header.id === sessionId).header.agentPreset, 'ptc');
    assert.ok(registeredWorkspace.sessionIds.includes(sessionId));
    const schemasFor = handle => ctx.tools.schemas(handle.agent).map(tool => tool.name);
    assert.ok(ctx.agents.get(sessions.SessionId(sessionId)), 'completed learning keeps its original Agent available for followup');
    const querySchema = ctx.tools.schemas(ctx.agents.get(sessions.SessionId(sessionId))).find(tool => tool.name === 'dmc_read_learning');
    assert.ok(querySchema.parameters.properties.field.enum.includes('learningGuidance'));
    assert.match(querySchema.parameters.properties.field.description, /target:"global"/);
    assert.match(querySchema.description, /source 的文字偏好使用 settings/);
    await executorOwner.dispose();
    resumed = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(sessionId), agentOptions: { provider: 'offline-learning', model: 'resume' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, ctx.sessionProjections.stateOf(agent.session, 'agentPreset')); } });
    assert.ok(schemasFor(resumed).includes('dmc_read_learning')); assert.ok(schemasFor(resumed).includes('dmc_propose_learning'));
    assert.equal(schemasFor(resumed).some(name => /dmc_(apply|submit_result|read_item)/.test(name)), false);
    const send = async code => {
      const before = resumed.agent.session.snapshotEvents().length;
      actions.push(code); resumed.agent.followup(llm.createUserMessage({ source: { kind: 'offline-test', form: 'instructions' }, content: [{ type: 'text', text: '执行离线验收' }] }));
      await resumed.agent.whenIdle(); await ctx.sessions.flush(resumed.agent.session);
      return JSON.stringify(resumed.agent.session.snapshotEvents().slice(before));
    };
    const { setSandboxMode } = await f.load('dsh-sandbox-policy');
    const call = `return await tools.dmc_propose_learning(${JSON.stringify(proposal)});`;
    setSandboxMode(resumed.agent.session, 'read-only'); assert.match(await send(call), /只读|read-only/);
    setSandboxMode(resumed.agent.session, 'workspace-write'); ctx.agentPresets.serviceFor(resumed.agent, 'planMode').set(resumed.agent, true);
    assert.match(await send(call), /计划模式/);
    ctx.agentPresets.serviceFor(resumed.agent, 'planMode').set(resumed.agent, false);
    await send(call); assert.equal(writes, 1, 'same proposal retry reuses the persisted receipt');
    assert.equal(service.readLearningFromSession({ sessionId, actualCwd: registeredWorkspace.path }, { section: 'batch' }).source.context, 'UNCHANGED_CONFIG');
    ordinary = await ctx.agents.create({ sessionId: sessions.SessionId('ordinary-learning-boundary'), meta: { cwd: workspace, agentPreset: 'ptc' }, agentOptions: { provider: 'offline-learning', model: 'ordinary' }, async setup(agentCtx) { await ctx.agentPresets.mount(agentCtx, 'ptc'); } });
    assert.equal(schemasFor(ordinary).some(name => /dmc_(read_learning|propose_learning)/.test(name)), false);
    assert.ok(schemasFor(ordinary).includes('dmc_read_item'));
  } finally { await resumed?.dispose(); await ordinary?.dispose(); await f.close(); }
});

test('real PTC persists a SQLite proposal, freezes original content and applies only after explicit confirmation', { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, sessions, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'learning-host-'));
  const store = await new Store(directory).start();
  const service = new ConsoleService({ store, executor: {}, workspaces: createDshWorkspaces(ctx), connectors: { bilibili: { fetch: async () => ({ complete: true, items: [{ remoteId: 'root-comment', kind: 'comment', title: '冻结案例', body: 'FROZEN_ORIGINAL_BODY', payload: { comments: [{ id: 'reply', author: 'fixture', body: 'FROZEN_REPLY' }] } }] }) } } });
  const requests = [];
  try {
    await installAgentTools(ctx, service);
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        requests.push(structuredClone(request));
        const code = `const batch=await tools.dmc_read_learning({section:'batch'}); const page=await tools.dmc_read_learning({section:'cases',page:1,pageSize:10}); const entry=page.items[0]; const raw=await tools.dmc_read_learning({section:'body',caseId:entry.id,offset:0,length:16000}); if(!raw.text.includes('FROZEN_ORIGINAL_BODY'))throw new Error('wrong original'); const config=await tools.dmc_read_learning({section:'configuration',target:'global',field:'learningGuidance'}); if(config.text!=='BEFORE_GUIDANCE')throw new Error('wrong guidance'); return await tools.dmc_propose_learning({operationKey:'sqlite-proposal',summary:'按评价调整通用指导并记住来源知识',changes:[{target:'global',field:'learningGuidance',after:'AFTER_GUIDANCE',caseIds:[entry.id]},{target:'source',field:'textMaterial',materialName:'已确认知识',after:'LEARNED_SOURCE_KNOWLEDGE',caseIds:[entry.id]}]});`;
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-db-${requests.length}`, name: 'run_code', arguments: JSON.stringify({ code, description: '冻结案例读取与持久化建议验收' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    ctx.llm.registerAdapter(['offline-learning-db'], new Offline());
    service.executor = createDshExecutor(ctx, { createUserMessage: llm.createUserMessage, SessionId: sessions.SessionId, service });
    await service.configure({ writerProvider: 'offline-learning-db', writerModel: 'm', learningGuidance: 'BEFORE_GUIDANCE' });
    const saved = await service.saveSource({ name: '学习来源', workspaceId: registeredWorkspace.id, platform: 'bilibili', target: 'BV1111111111', types: ['comment'], context: 'UNCHANGED_SOURCE_CONTEXT' });
    await service.refresh(saved.id, { organize: false });
    const item = service.items(saved.id).items[0];
    service.saveFeedback(item.id, { text: '说明重要性依据，并记住此视频的主题', expectedRevision: 0, itemVersion: item.version, analysisRevision: item.analysisRevision });
    const created = await service.startLearning({ sourceId: saved.id });
    const deadline = Date.now() + 10000;
    while (['queued', 'running'].includes(service.learning(created.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const batch = service.learning(created.id);
    assert.equal(batch.status, 'pending', JSON.stringify(batch));
    assert.equal(batch.proposal.changes.length, 2);
    assert.equal(service.feedback(item.id).learned, false);
    assert.equal(store.settings().learningGuidance, 'BEFORE_GUIDANCE');
    assert.equal(service.source(saved.id).materials.length, 0);
    assert.equal(store.sessionBinding(batch.sessionId).role, 'learning');
    assert.equal(store.sessionBinding(batch.sessionId).runId, undefined);
    assert.ok(service.sessionDirectory().changes.some(entry => entry.sessionId === batch.sessionId && entry.eligible));
    const persisted = await ctx.sessionQuery.readSession(batch.sessionId);
    assert.ok(persisted.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'dmc_read_learning'));
    assert.ok(persisted.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'dmc_propose_learning'));
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /FROZEN_ORIGINAL_BODY|LEARNED_SOURCE_KNOWLEDGE/);
    assert.equal(requests.length, 1, 'proposal tool concludes the real PTC turn');
    await store.close(); await store.start();
    assert.deepEqual(service.requireLearningSubmission(batch.sessionId).proposal, batch.proposal);
    assert.equal(service.learning(batch.id).status, 'pending');
    assert.equal(service.feedback(item.id).learned, false);
    const confirm = { proposalRevision: batch.proposal.revision, proposalHash: batch.proposal.hash };
    const applied = await service.applyLearning(batch.id, confirm);
    assert.equal(applied.learnedCount, 1);
    assert.equal(service.feedback(item.id).learned, true);
    assert.equal(store.settings().learningGuidance, 'AFTER_GUIDANCE');
    assert.equal(service.source(saved.id).materials[0].text, 'LEARNED_SOURCE_KNOWLEDGE');
    assert.deepEqual(await service.applyLearning(batch.id, confirm), applied);
    for (const stage of ['decision', 'escalation', 'generation', 'supervision']) {
      const preview = await service.previewInput({ source: service.source(saved.id), sourceId: saved.id, itemId: item.id, stage });
      assert.equal(preview.input.learningGuidance, 'AFTER_GUIDANCE');
      assert.match(preview.serialized, /LEARNED_SOURCE_KNOWLEDGE/);
    }
    const human = await service.openConversation(item.id);
    const background = await ctx.sessionQuery.readSession(human.sessionId);
    assert.match(JSON.stringify(background.events), /AFTER_GUIDANCE/);
    assert.equal(requests.length, 1, 'opening the human conversation does not wake a model');
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); await f.close(); }
});
