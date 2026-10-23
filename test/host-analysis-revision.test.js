import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { prepareSource } from '../src/source-context.js';
import { installAgentTools } from '../src/agent-tools.js';
import { hostFixture } from './host-fixture.js';

const root = process.env.DMC_DSH_ROOT;
const analysis = { summary: '仍在排队', importance: 1, urgent: false, urgencyReason: null, reason: '等待报告', intervention: 'none', evidence: 'insufficient' };

test('cold original Agent revises an analysis through real PTC with permissions and durable tool history', { skip: !root, timeout: 30_000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, sessions, workspace, registeredWorkspace } = f;
  const directory = await mkdtemp(join(resolve('.local'), 'host-analysis-revision-')), store = await new Store(directory).start();
  const service = new ConsoleService({ store, executor: {}, connectors: { github: { fetch: async () => ({ complete: true, items: [{ remoteId: 'issue:1', kind: 'issue', title: '验证问题', body: '原问题', payload: {} }] }) } }, workspaces: { resolve: id => ctx.workspaceRegistry.get(id) } });
  const sessionId = 'analysis-revision-host', setup = async (agentCtx, agent) => { await ctx.agentPresets.mount(agentCtx, 'ptc'); ctx.permissionPresets.set(agent.session, 'workspace-write'); };
  let handle, calls = 0, revisionInput;
  try {
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        assert.deepEqual(request.tools.map(tool => tool.name), ['run_code']);
        calls++;
        let code;
        if (calls === 1) code = `return await tools.dmc_submit_result(${JSON.stringify({ kind: 'analysis', operationKey: 'initial', analysis })});`;
        else if (calls === 2) code = 'return await tools.dmc_read_item({section:"analysis"});';
        else if (calls === 3) {
          const current = JSON.parse(request.messages.findLast(message => message.role === 'tool').content[0].text);
          assert.equal(current.analysis.summary, analysis.summary);
          revisionInput = { operationKey: 'completion-report', analysis: { ...analysis, summary: '验证完成：已确认问题', evidence: 'confirmed' }, reason: '收到验证报告', evidenceRefs: ['report:offline-fixture'] };
          code = `return await tools.dmc_revise_analysis(${JSON.stringify(revisionInput)});`;
        } else throw new Error('Unexpected model request after result submission');
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `revision-call-${calls}`, name: 'run_code', arguments: JSON.stringify({ code, description: '验收分析修订' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    ctx.llm.registerAdapter(['offline-revision'], new Offline());
    const source = await service.saveSource({ workspaceId: registeredWorkspace.id, name: '修订验收', platform: 'github', target: 'example/repository', types: ['issue'] });
    await service.refresh(source.id, { organize: false });
    const item = service.items(source.id).items[0], prepared = await prepareSource(source, { path: workspace });
    const run = store.createRun({ id: 'original-run', itemId: item.id, sourceId: source.id, workspaceId: source.workspaceId, version: item.version, contextVersion: prepared.contextVersion, sourceContextVersion: source.contextVersion, sourceSnapshot: prepared, baseAnalysisRevision: item.analysisRevision, status: 'running', startedAt: new Date().toISOString() });
    service.bindSession({ sessionId, runId: run.id, role: 'investigate', workspaceId: source.workspaceId, cwd: workspace });
    await installAgentTools(ctx, service);
    handle = await ctx.agents.create({ sessionId: sessions.SessionId(sessionId), meta: { cwd: workspace, agentPreset: 'ptc' }, agentOptions: { provider: 'offline-revision', model: 'worker' }, setup });
    const send = async text => {
      handle.agent.followup(llm.createUserMessage({ source: { kind: 'offline-test', form: 'instructions' }, content: [{ type: 'text', text }] }));
      await handle.agent.whenIdle(); await ctx.sessions.flush(handle.agent.session);
      const events = handle.agent.session.snapshotEvents(), end = events.findLast(event => event.type === 'turn/end');
      assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(events.slice(-6)));
    };
    await send('保存最初分析');
    const originalReceipt = service.requireSubmission(sessionId);
    store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
    await handle.dispose(); await store.close(); await store.start();
    await service.saveSource({ ...service.source(source.id), context: '初次保存后更新的来源配置' }, source.id);
    handle = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(sessionId), agentOptions: { provider: 'offline-revision', model: 'worker' }, setup });
    assert.ok(ctx.tools.schemas(handle.agent).some(tool => tool.name === 'dmc_revise_analysis'));
    await send('报告已到达，读取当前分析并修订');
    assert.equal(calls, 3); assert.equal(service.item(item.id).analysisRevision, 2);
    assert.equal(service.item(item.id).analysis.summary, revisionInput.analysis.summary);
    assert.deepEqual(service.requireSubmission(sessionId), originalReceipt);
    assert.equal(store.run(service.runs(item.id, {}).items.find(row => row.kind === 'analysis-revision').id).sourceSnapshot.context, '初次保存后更新的来源配置');
    const log = await ctx.sessionQuery.readSession(sessionId);
    assert.ok(log.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'dmc_revise_analysis'));
    assert.equal(log.events.filter(event => event.type === 'turn/end').length, 2);
    const tool = ctx.tools.get('dmc_revise_analysis', handle.agent), exec = { agent: handle.agent, callId: 'blocked', concludeTurn() { throw new Error('must not conclude rejected submission'); } };
    const { setSandboxMode } = await f.load('dsh-sandbox-policy');
    setSandboxMode(handle.agent.session, 'read-only');
    await assert.rejects(tool.execute(revisionInput, exec), /只读/);
    setSandboxMode(handle.agent.session, 'workspace-write');
    const plan = ctx.agentPresets.serviceFor(handle.agent, 'planMode'); plan.set(handle.agent, true);
    await assert.rejects(tool.execute(revisionInput, exec), /计划模式/);
    plan.set(handle.agent, false);
    const ordinary = await ctx.agents.create({ sessionId: sessions.SessionId('ordinary-no-analysis-revision'), meta: { cwd: workspace }, agentOptions: { provider: 'offline-revision', model: 'worker' }, setup });
    assert.equal(ctx.tools.schemas(ordinary.agent).some(entry => entry.name === 'dmc_revise_analysis'), false);
    await assert.rejects(tool.execute(revisionInput, { ...exec, agent: ordinary.agent }), /不匹配/);
    await ordinary.dispose();
    assert.equal(service.runs(item.id, {}).total, 2);
  } finally { await handle?.dispose(); await f.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
