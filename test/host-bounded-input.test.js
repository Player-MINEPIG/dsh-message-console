import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { ConsoleService, fingerprint } from '../src/core.js';
import { prepareSource } from '../src/source-context.js';
import { assembleInput } from '../src/input-assembly.js';
import { installAgentTools } from '../src/agent-tools.js';
import { hostFixture } from './host-fixture.js';

const root = process.env.DMC_DSH_ROOT;
for (const coldStart of [false, true]) test(`real DSH repairs oversized legacy PR inputs ${coldStart ? 'from cold storage' : 'in the live session'} before the assembly gate with native provenance`, { skip: !root, timeout: 60000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, sessions, workspace, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'host-bounded-input-'));
  const store = await new Store(directory).start();
  const service = new ConsoleService({ store, executor: {}, connectors: {}, workspaces: { resolve: id => ctx.workspaceRegistry.get(id) } });
  let owner, handle, cold, mode = 'seed', sequence = 0;
  const requests = [];
  try {
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 50000000 } }; }
      async *stream(request) {
        requests.push(request.messages);
        if (mode !== 'save') {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '合成原会话讨论保留' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        const submission = { kind: 'analysis', operationKey: 'bounded-result', analysis: { summary: '有界输入后保存', importance: 1, urgent: false, reason: '合成测试', intervention: 'review', evidence: 'confirmed' } };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `bounded-${++sequence}`, name: 'run_code', arguments: JSON.stringify({ code: `return await tools.dmc_submit_result(${JSON.stringify(submission)});`, description: '保存合成分析' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    ctx.llm.registerAdapter(['offline-bounded'], new Offline());
    const source = await service.saveSource({ workspaceId: registeredWorkspace.id, name: '有界输入合成', platform: 'github', target: 'example/repo', types: ['pr'] });
    const raw = { remoteId: 'pr:1', kind: 'pr', title: '合成大型 PR', body: 'NEW_CONTENT', payload: { files: [{ path: 'file.js', patch: 'original patch', additions: 1, deletions: 0 }] } };
    store.applyFetch(source.id, [raw], {}, new Date().toISOString(), fingerprint);
    const item = store.item(`${source.id}:pr:1`), prepared = await prepareSource(source, { path: workspace });
    const newRun = id => store.createRun({ id, itemId: item.id, sourceId: source.id, workspaceId: source.workspaceId, version: item.version, contextVersion: prepared.contextVersion, sourceContextVersion: source.contextVersion, sourceSnapshot: prepared, baseAnalysisRevision: store.item(item.id).analysisRevision, status: 'running', startedAt: new Date().toISOString() });
    const legacyRun = newRun('bounded-legacy'), id = sessions.SessionId('dmc-bounded-legacy');
    service.bindSession({ sessionId: id, runId: legacyRun.id, role: 'review', workspaceId: source.workspaceId, cwd: workspace });
    await installAgentTools(ctx, service);
    handle = await ctx.agents.create({ sessionId: id, meta: { cwd: workspace, agentPreset: 'ptc' }, agentOptions: { provider: 'offline-bounded', model: 'model' }, async setup(agentCtx, agent) { await ctx.agentPresets.mount(agentCtx, 'ptc'); ctx.permissionPresets.set(agent.session, 'workspace-write'); } });
    let agent = handle.agent;
    ctx.dshPromptAssembler.store.applySnapshot(id, { id: 'legacy-bounded-test', format: 'dsh-tavern-request-assembly', version: 1, name: '合成旧版装配', backend: 'native', rules: [{ id: 'system', kind: 'native-system', enabled: true }, { id: 'history', kind: 'history', enabled: true }, { id: 'input', kind: 'input', enabled: true }] });
    const send = async message => { agent.followup(message); await agent.whenIdle(); return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason; };
    const legacyIds = [];
    for (let index = 0; index < 3; index++) {
      const message = llm.createUserMessage({ source: { kind: 'dsh-message-console', form: 'instructions', runId: legacyRun.id }, content: [{ type: 'text', text: JSON.stringify({ role: 'review', input: { stage: 'generation', blocks: [{ key: 'content', value: { ...item, payload: { files: [{ path: `legacy-${index}.js`, patch: `LEGACY_PATCH_${index}:` + 'x'.repeat(3 * 1024 * 1024) }] } } }] } }) }] });
      legacyIds.push(message.id);
      assert.equal((await send(message)).kind, 'completed');
    }
    let requestHookCalls = 0;
    const stopProbe = agent.ctx.on('agent/request', async (_payload, next) => { requestHookCalls++; return next(); }, { prepend: true });
    const beforeFailure = requests.length;
    const failed = await send(llm.createUserMessage({ source: { kind: 'user', form: 'instructions' }, content: [{ type: 'text', text: '合成验证原历史上限' }] }));
    assert.match(failed.error.message, /Source output exceeds 8 MiB: history/);
    assert.equal(requests.length, beforeFailure);
    assert.equal(requestHookCalls, 0, 'agent/request is after the assembler gate');
    stopProbe();
    const originalEvents = agent.session.snapshotEvents();
    const originalMessages = originalEvents.filter(event => event.type === 'user/message' && legacyIds.includes(event.data.id));
    assert.equal(originalMessages.length, 3);
    store.updateRun(legacyRun.id, { status: 'failed', error: failed.error.message });
    if (coldStart) { await ctx.sessions.flush(agent.session); await handle.dispose(); handle = null; }
    owner = await f.executorOwner(service); service.executor = owner.executor;
    mode = 'save';
    const currentRun = newRun('bounded-current');
    const receipt = await owner.executor.runAgent({ runId: currentRun.id, role: 'review', workspaceId: source.workspaceId, provider: 'offline-bounded', model: 'model', input: assembleInput(prepared, item), instructions: '用工具保存合成分析', title: '合成有界输入' });
    agent = ctx.agents.get(id);
    assert.equal(receipt.sessionId, id);
    assert.equal(receipt.adopted, true);
    assert.deepEqual(agent.session.snapshotEvents().slice(0, originalEvents.length), originalEvents);
    const replacements = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.projection?.kind === 'github-summary-v1');
    assert.equal(replacements.length, 3);
    for (const event of replacements) {
      const original = originalMessages.find(original => original.data.id === event.data.id);
      assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: original.seq, endSeq: original.seq });
      assert.deepEqual(event.sourceEventSeqs, [original.seq]);
      assert.equal(event.data.source.projection.originalSeq, original.seq);
    }
    const delivered = JSON.stringify(requests.at(-1));
    assert.doesNotMatch(delivered, /LEGACY_PATCH_/);
    assert.match(delivered, /NEW_CONTENT/);
    assert.match(delivered, /合成原会话讨论保留/);
    assert.ok(Buffer.byteLength(delivered) < 200000);
    mode = 'human';
    assert.equal((await send(llm.createUserMessage({ source: { kind: 'user', form: 'instructions' }, content: [{ type: 'text', text: 'HUMAN_CONTINUES' }] }))).kind, 'completed');
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.projection).length, 3);
    await ctx.sessions.flush(agent.session);
    await handle?.dispose(); handle = null;
    await owner.dispose(); owner = await f.executorOwner(service); service.executor = owner.executor;
    cold = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'offline-bounded', model: 'model' }, async setup(agentCtx, resumed) { await ctx.agentPresets.mount(agentCtx, resumed.session.header.agentPreset); } });
    cold.agent.followup(llm.createUserMessage({ source: { kind: 'user', form: 'instructions' }, content: [{ type: 'text', text: 'COLD_HUMAN_CONTINUES' }] }));
    await cold.agent.whenIdle(); await ctx.sessions.flush(cold.agent.session);
    assert.equal(cold.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
    assert.deepEqual(cold.agent.session.snapshotEvents().slice(0, originalEvents.length), originalEvents);
    assert.equal(cold.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.projection).length, 3);
    assert.match(JSON.stringify(requests.at(-1)), /HUMAN_CONTINUES/);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /LEGACY_PATCH_/);
  } finally {
    await cold?.dispose(); await handle?.dispose(); await owner?.dispose(); await f.close(); await service.close(); await rm(directory, { recursive: true, force: true });
  }
});
