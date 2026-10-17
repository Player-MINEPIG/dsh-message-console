import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import * as llm from '@deepseek-ai/dsh-llm';
import * as jev from 'dsh-jev-plugin';
import jevPackage from 'dsh-jev-plugin/package.json' with { type: 'json' };
import { createDshExecutor } from '../src/dsh.js';
import { ConsoleService, fingerprint } from '../src/core.js';
import { Store } from '../src/store.js';

const choice = probabilities => ({ answers: { reply: { type: 'choice', choice: Object.keys(probabilities).sort((a,b) => probabilities[b]-probabilities[a])[0], probabilities, confidence: 1 } } });
const decisive = { ignore: .02, draft: .95, human: .03 };
const ambiguous = { ignore: .4, draft: .5, human: .1 };
const scenarios = [
  { id: 'ignore', payload: choice({ ignore: .95, draft: .03, human: .02 }), roles: [], intervention: 'none' },
  { id: 'human', payload: choice({ ignore: .02, draft: .03, human: .95 }), roles: [], intervention: 'human' },
  { id: 'uncertain', payload: choice(ambiguous), certain: false, roles: ['decision-escalation'], intervention: 'human' },
  { id: 'resolved', payload: choice(ambiguous), certain: true, roles: ['decision-escalation','writer','supervisor'], draft: 'ready' },
  { id: 'draft', payload: choice(decisive), roles: ['writer','supervisor'], draft: 'ready' },
  { id: 'blocked', payload: choice(decisive), roles: ['writer','supervisor'], draft: 'blocked' },
  { id: 'missing-probabilities', payload: { answers: { reply: { type: 'choice', choice: 'draft' } } }, roles: [], error: /probabilities/ },
  { id: 'upstream-error', roles: [], error: { native: /native 响应不完整/, custom: /HTTP 401/ } },
];

test('pinned Jev 0.3.6 native and custom services drive workflows and durable review records', { timeout: 20_000 }, async t => {
  assert.equal(jevPackage.version, '0.3.6');
  const ctx = new Context(), directory = await mkdtemp(join(tmpdir(), 'dmc-jev-workflow-'));
  let scenario, nativeRequest, customRequest, nativeCalls = 0, customCalls = 0;
  try {
    await ctx.plugin(llm.default);
    class Offline extends llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id }; }
      async *stream(request) {
        nativeCalls++; nativeRequest = request;
        if (scenario.id === 'upstream-error') throw new llm.LlmError('合成上游连接失败', 'TRANSPORT');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(scenario.payload) } };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['offline'], new Offline());
    ctx.provide('credentials', { async resolve(key) { assert.equal(key, 'DMC_JEV_FIXTURE_KEY'); return { value: 'synthetic-key' }; } });
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://jev.invalid/v1/systemone');
      assert.equal(init.headers.authorization, 'Bearer synthetic-key');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      customCalls++; customRequest = JSON.parse(init.body);
      return scenario.id === 'upstream-error'
        ? new Response('synthetic rejection', { status: 401 })
        : new Response(JSON.stringify({ ...scenario.payload, model: 'custom-model', usage: { input_tokens: 21, output_tokens: 11 } }));
    });
    await ctx.plugin(jev, {
      enabled: true, provider: 'ordinary-profile', dataDir: join(directory, 'jev'),
      profiles: [
        { id: 'ordinary-profile', name: '普通模型', provider: 'native', nativeProvider: 'offline', model: 'native-model' },
        { id: 'custom-profile', name: '自定义决策', provider: 'custom', baseUrl: 'https://jev.invalid/v1/systemone', model: 'custom-model', credential: 'DMC_JEV_FIXTURE_KEY' },
      ],
    });
    for (const backend of ['native', 'custom']) await t.test(backend, async t => {
      const store = await new Store(join(directory, backend)).start();
      let published = 0;
      const workspaces = { async resolve(id) { assert.equal(id, 'fixture-workspace'); return { id }; } };
      const executor = createDshExecutor(ctx, { createUserMessage: value => value, SessionId: value => value, workspaces });
      const connector = {
        status: () => ({ ready: true, canPublish: true }),
        async fetch() { return { complete: true, items: [{ remoteId: 'comment:1', kind: 'comment', title: '合成评论', body: '仅供离线测试的中文问题', payload: { comments: [] } }] }; },
        async getItem() { return (await this.fetch()).items[0]; },
        async publish() { published++; return { remoteId: 'synthetic-publication' }; },
      };
      const service = new ConsoleService({ store, connectors: { bilibili: connector }, executor, workspaces });
      try {
        const profile = backend === 'native' ? 'ordinary-profile' : 'custom-profile';
        await service.configure({ decisionProfile: profile, writerProvider: 'offline', writerModel: 'writer-model', decisionConfidence: .8, decisionMargin: .2 });
        assert.deepEqual((await executor.catalog()).decisionProfiles.map(value => value.id), ['ordinary-profile', 'custom-profile']);
        for (const current of scenarios) await t.test(current.id, async () => {
          scenario = current;
          const roles = [], beforeNative = nativeCalls, beforeCustom = customCalls;
          executor.runAgent = async input => {
            roles.push(input.role);
            assert.equal(input.workspaceId, 'fixture-workspace');
            await input.onSession(`synthetic-${backend}-${current.id}-${input.role}`);
            if (input.role === 'decision-escalation') {
              assert.deepEqual(input.input.decision.probabilities, ambiguous);
              assert.equal(input.input.decision.confidence, .5, 'routing uses probabilities rather than answer.confidence');
              return { choice: 'draft', certain: current.certain, reason: '合成升级判断' };
            }
            if (input.role === 'supervisor') return { approved: current.id !== 'blocked', reason: '合成独立监督' };
            return { summary: '合成回复摘要', importance: 1, urgent: false, urgencyReason: null, reason: '合成事实', intervention: 'review', evidence: 'inferred', body: '合成待审核回复' };
          };
          const source = await service.saveSource({ workspaceId: 'fixture-workspace', name: `${backend}-${current.id}`, platform: 'bilibili', target: 'BV1111111111', types: ['comment'], postHistoryInstruction: '中文可信规则', stageContexts: { decision: { context: 'JEV_ONLY_CONTEXT' }, generation: { context: 'GENERATION_ONLY_CONTEXT' } } });
          await service.refresh(source.id, { organize: false });
          const report = await service.organize(source.id, { scope: 'history' });
          const state = service.view(), item = state.items.find(value => value.sourceId === source.id), run = state.runs.find(value => value.itemId === item.id);
          assert.equal(ctx.decisionModels.activeCount, 0);
          assert.equal(nativeCalls - beforeNative, backend === 'native' ? 1 : 0);
          assert.equal(customCalls - beforeCustom, backend === 'custom' ? 1 : 0);
          assert.deepEqual(roles, current.roles);
          assert.deepEqual(run.sessions.map(value => value.role), roles);
          assert.equal(run.decision.input.provider, profile);
          assert.match(run.decision.input.state, /JEV_ONLY_CONTEXT/);
          assert.doesNotMatch(run.decision.input.state, /GENERATION_ONLY_CONTEXT/);
          assert.match(run.decision.input.questions.reply.instructions, /中文可信规则/);
          const request = backend === 'native' ? JSON.parse(nativeRequest.messages[0].content[0].text) : customRequest;
          assert.equal(request.state, run.decision.input.state);
          assert.deepEqual(request.questions, run.decision.input.questions);
          if (backend === 'native') {
            assert.equal(nativeRequest.provider, 'offline'); assert.equal(nativeRequest.model, 'native-model');
            assert.deepEqual(nativeRequest.tools, []);
            assert.match(nativeRequest.system, /自报的估计值/);
          }
          if (current.error) {
            const expectedError = current.error[backend] ?? current.error;
            assert.equal(report.failed, 1); assert.equal(run.status, 'failed');
            assert.match(run.decision.error, expectedError); assert.match(run.error, expectedError);
            assert.equal(run.decision.output, undefined); assert.equal(item.analysis, null);
          } else {
            assert.equal(report.completed, 1); assert.equal(run.status, 'completed');
            assert.deepEqual(run.decision.output.answers, current.payload.answers);
            assert.equal(run.decision.output.provider, profile);
            assert.equal(run.decision.output.model, `${backend}-model`);
            assert.deepEqual(run.decision.output.usage, backend === 'native' ? { input_tokens: 20, output_tokens: 10 } : { input_tokens: 21, output_tokens: 11 });
            if (current.intervention) assert.equal(item.analysis.intervention, current.intervention);
          }
          const draft = state.drafts.find(value => value.itemId === item.id);
          assert.equal(draft?.status, current.draft);
          if (draft) {
            assert.equal(draft.approvedAt, undefined);
            await assert.rejects(service.approveAndPublish(draft.id, { version: draft.version, bodyHash: fingerprint('unapproved-body') }), /重新审核|未通过监督/);
          }
          assert.equal(published, 0, 'supervision cannot authorize publication');
          const persisted = JSON.parse(await readFile(join(directory, backend, 'state.json'), 'utf8'));
          assert.deepEqual(persisted.runs[run.id].decision, run.decision);
        });
      } finally { await service.close(); }
    });
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
