import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { hostFixture } from './host-fixture.js';

const root = process.env.DMC_DSH_ROOT;

test('completed and failed work stays conversational until its owning plugin unloads', { skip: !root, timeout: 30000 }, async () => {
  const f = await hostFixture(root), { ctx, llm, sessions, registeredWorkspace } = f;
  const created = [], ended = [], removed = [], requests = [], attempts = new Map();
  let executor, owner, cold, missingSubmission = false;
  const service = {
    storageDirectory: () => resolve('.local'),
    bindSession() {}, bindLearningSession() {},
    endSession(id) { ended.push(id); },
    requireSubmission(id) { if (missingSubmission) throw new Error('缺少工具提交'); return { sessionId: id, result: { ok: true } }; },
    requireLearningSubmission(id) { return { sessionId: id, proposal: { status: 'pending' } }; },
  };
  try {
    ctx.on('session/disposed', session => removed.push(String(session.id)), { global: true });
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        requests.push(structuredClone(request));
        const count = (attempts.get(request.model) ?? 0) + 1; attempts.set(request.model, count);
        if (request.model === 'fails-once' && count === 1) throw new llm.LlmError('offline provider failure', 'TRANSPORT');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '继续解释此前工作' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['offline-lifecycle'], new Offline());
    owner = await f.executorOwner(service); executor = owner.executor;
    const request = { runId: 'run', role: 'writer', workspaceId: registeredWorkspace.id, provider: 'offline-lifecycle', model: 'success', input: { body: 'ORIGINAL_WORK_CONTEXT' }, instructions: '解释工作', title: '离线生命周期', onSession: id => created.push(id) };
    await executor.runAgent(request);
    await executor.runAgent({ ...request, role: 'learning', batchId: 'batch', model: 'learning' });
    await assert.rejects(executor.runAgent({ ...request, model: 'fails-once' }), error => error.sessionFailure?.code === 'TRANSPORT');
    missingSubmission = true;
    await assert.rejects(executor.runAgent({ ...request, model: 'no-submission' }), /缺少工具提交/);
    missingSubmission = false;
    assert.deepEqual(ended, created);
    const beforeHuman = requests.length;
    created.push(await executor.conversation({ runId: 'human', source: { workspaceId: registeredWorkspace.id, name: '来源' }, item: { title: '人工问题', body: 'ORIGINAL_HUMAN_CONTEXT' }, settings: { writerProvider: 'offline-lifecycle', writerModel: 'human' } }));
    assert.equal(requests.length, beforeHuman);
    assert.deepEqual(removed, [], 'automatic completion emits no terminal removal to an already-open UI');
    for (const id of created) {
      const agent = ctx.agents.get(sessions.SessionId(id));
      assert.ok(agent, `the original Agent for ${id} remains available`);
      const prefix = agent.session.snapshotEvents();
      agent.followup(llm.createUserMessage({ source: { kind: 'user', form: 'instructions' }, content: [{ type: 'text', text: 'FOLLOWUP_QUESTION' }] }));
      await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      assert.equal(ctx.agents.get(sessions.SessionId(id)), agent);
      const history = await ctx.sessionQuery.readSession(id);
      assert.deepEqual(history.events.slice(0, prefix.length), prefix);
      assert.ok(history.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('FOLLOWUP_QUESTION')));
      assert.equal(history.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
      assert.match(JSON.stringify(requests.at(-1).messages), id === created.at(-1) ? /ORIGINAL_HUMAN_CONTEXT/ : /ORIGINAL_WORK_CONTEXT/);
    }
    const failed = await ctx.sessionQuery.readSession(created[2]);
    assert.ok(failed.events.some(event => event.type === 'turn/end' && event.data.reason.error?.code === 'TRANSPORT'));
    assert.deepEqual(removed, []);
    await owner.dispose();
    assert.deepEqual(new Set(removed), new Set(created));
    for (const id of created) { assert.equal(ctx.agents.get(sessions.SessionId(id)), undefined); assert.equal(ctx.sessions.get(sessions.SessionId(id)), undefined); }
    cold = await ctx.agents.resume({ resumeSessionId: sessions.SessionId(created[0]), agentOptions: { provider: 'offline-lifecycle', model: 'cold' }, async setup(agentCtx) { await ctx.agentPresets.mount(agentCtx, 'ptc'); } });
    assert.match(JSON.stringify(cold.agent.session.snapshotEvents()), /FOLLOWUP_QUESTION/);
  } finally { await cold?.dispose(); await owner?.dispose(); await f.close(); }
});
