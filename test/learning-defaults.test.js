import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PARAMETERS, resolveSettings, valuesOf } from '../src/config.js';
import { applyLearningChanges, learningConfigurationFields, proposalChanges } from '../src/learning.js';

const source = (platform = 'bilibili', settings = {}) => ({ platform, types: platform === 'bilibili' ? ['comment'] : ['pr'], settings, context: '来源专属背景', materials: [] });
const batch = (settingsSnapshot = {}, sourceSnapshot = source()) => ({ cases: [{ id: 'c1' }], settingsSnapshot, sourceSnapshot });
const change = (target, field, after) => ({ target, field, after, caseIds: ['c1', 'c1'] });
const propose = (changes, snapshot = batch()) => proposalChanges({ operationKey: 'learning-1', summary: '复用回复偏好，保留来源知识', changes }, snapshot);

test('default learning updates are inherited by future and existing unoverridden sources', () => {
  const snapshot = batch({ language: '中文', replyStyle: '旧风格' });
  const changes = propose([change('global', 'language', 'English'), change('global', 'replyStyle', '先回答问题，再补充依据')], snapshot);
  assert.equal(changes[0].before, '中文');
  assert.deepEqual(changes[0].caseIds, ['c1']);
  const result = applyLearningChanges(snapshot.sourceSnapshot, snapshot.settingsSnapshot, changes);
  assert.equal(valuesOf(resolveSettings(result.settings, source())).language, 'English');
  assert.equal(valuesOf(resolveSettings(result.settings, snapshot.sourceSnapshot)).replyStyle, '先回答问题，再补充依据');
  assert.equal(valuesOf(resolveSettings(result.settings, source('bilibili', { language: '日本語' }))).language, '日本語');
  assert.deepEqual(result.source, snapshot.sourceSnapshot);
  assert.deepEqual(snapshot.settingsSnapshot, { language: '中文', replyStyle: '旧风格' });
});

test('source learning updates create explicit overrides and preserve defaults and other sources', () => {
  const snapshot = batch({ learningGuidance: '默认指导', language: '中文', replyStyle: '默认风格' });
  const changes = propose([change('source', 'settings.learningGuidance', '只参考本视频的说明'), change('source', 'settings.language', 'English'), change('source', 'settings.replyStyle', '简短口语')], snapshot);
  assert.equal(changes[0].before, null);
  const result = applyLearningChanges(snapshot.sourceSnapshot, snapshot.settingsSnapshot, changes);
  assert.deepEqual(result.settings, snapshot.settingsSnapshot);
  assert.equal(valuesOf(resolveSettings(result.settings, result.source)).learningGuidance, '只参考本视频的说明');
  assert.equal(valuesOf(resolveSettings(result.settings, source())).learningGuidance, '默认指导');
  assert.equal(valuesOf(resolveSettings(result.settings, source())).language, '中文');
  assert.equal(result.source.context, '来源专属背景');
  assert.deepEqual(snapshot.sourceSnapshot.settings, {});
});

test('source and default changes coexist and may preserve a source value while changing its default', () => {
  const snapshot = batch({ language: '中文' });
  const changes = propose([change('global', 'language', 'English'), change('source', 'settings.language', '中文')], snapshot);
  const result = applyLearningChanges(snapshot.sourceSnapshot, snapshot.settingsSnapshot, changes);
  assert.equal(valuesOf(resolveSettings(result.settings, result.source)).language, '中文');
  assert.equal(valuesOf(resolveSettings(result.settings, source())).language, 'English');
  assert.equal(changes[1].before, null);
});

test('default before uses built-in values and source before retains explicit values', () => {
  const defaults = propose([change('global', 'language', 'English'), change('global', 'replyStyle', '更简短')]);
  assert.equal(defaults[0].before, PARAMETERS.language.default);
  assert.equal(defaults[1].before, PARAMETERS.replyStyle.default);
  const custom = propose([change('source', 'settings.language', 'English')], batch({}, source('bilibili', { language: '日本語' })));
  assert.equal(custom[0].before, '日本語');
  assert.throws(() => propose([change('source', 'settings.language', PARAMETERS.language.default)]), /没有实际修改/);
  assert.throws(() => propose([change('source', 'settings.language', 'English')], batch({ language: 'English' })), /没有实际修改/);
  assert.throws(() => propose([change('global', 'language', PARAMETERS.language.default)]), /没有实际修改/);
});

test('learning allows only bounded text preferences and enforces source applicability', () => {
  for (const field of ['fetchHours', 'writerModel', 'writerProvider', 'autoPublish', 'cookie', '__proto__', 'context']) {
    assert.throws(() => propose([change('global', field, 'malicious')]), /不允许/);
    assert.throws(() => applyLearningChanges(source(), {}, [change('source', `settings.${field}`, 'malicious')]), /不允许/);
  }
  for (const field of learningConfigurationFields.global) {
    assert.throws(() => propose([change('global', field, 'x'.repeat(10001))]), /过长/);
    assert.throws(() => propose([change('global', field, 1)]), /无效/);
    const applicable = batch({}, source(field === 'reviewFocus' ? 'github' : 'bilibili'));
    assert.throws(() => propose([change('source', `settings.${field}`, 'x'.repeat(10001))], applicable), /过长/);
    assert.throws(() => applyLearningChanges(applicable.sourceSnapshot, {}, [change('source', `settings.${field}`, false)]), /无效/);
  }
  assert.throws(() => propose([change('source', 'settings.reviewFocus', '检查兼容性')]), /不适用/);
  assert.throws(() => propose([change('source', 'settings.replyStyle', '简短')], batch({}, source('github'))), /不适用/);
  const github = batch({}, source('github'));
  const result = applyLearningChanges(github.sourceSnapshot, {}, propose([change('source', 'settings.reviewFocus', '检查兼容性')], github));
  assert.equal(result.source.settings.reviewFocus, '检查兼容性');
  const global = applyLearningChanges(source(), {}, propose([change('global', 'reviewFocus', '检查兼容性')]));
  assert.equal(valuesOf(resolveSettings(global.settings, source('github'))).reviewFocus, '检查兼容性');
  assert.equal(valuesOf(resolveSettings(global.settings, source())).reviewFocus, undefined);
});

test('legacy learning changes preserve materials, case validation and duplicate-field protection', () => {
  const snapshot = batch({}, { ...source(), stageContexts: { decision: { context: '旧背景', materials: [] } } });
  const changes = propose([change('source', 'context', '新背景'), change('source', 'stageContexts.decision.context', '新决策背景'), { ...change('source', 'textMaterial', '本视频的知识'), materialName: '视频说明' }], snapshot);
  const result = applyLearningChanges(snapshot.sourceSnapshot, {}, changes);
  assert.equal(result.source.context, '新背景');
  assert.equal(result.source.stageContexts.decision.context, '新决策背景');
  assert.deepEqual(result.source.materials, [{ kind: 'text', name: '视频说明', text: '本视频的知识' }]);
  assert.throws(() => propose([change('global', 'language', 'English'), change('global', 'language', '日本語')]), /重复/);
  assert.throws(() => propose([{ ...change('global', 'language', 'English'), caseIds: ['unknown'] }]), /无效/);
});

const directory = await mkdtemp(join(process.cwd(), '.local/learning-default-ui-'));
await build({ stdin: { contents: "export { FeedbackDiff, LearningBatch } from './src/feedback-view.jsx';", resolveDir: process.cwd() }, outfile: join(directory, 'ui.mjs'), bundle: true, format: 'esm', platform: 'node', packages: 'external' });
const { FeedbackDiff, LearningBatch } = await import(join(directory, 'ui.mjs'));
test.after(() => rm(directory, { recursive: true, force: true }));
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test('learning diff distinguishes default propagation from source-specific overrides', () => {
  const defaults = render(FeedbackDiff, { index: 0, change: { ...change('global', 'replyStyle', '<script>短句</script>'), before: '旧风格' } });
  assert.match(defaults, /默认配置 · 回复风格/);
  assert.match(defaults, /新来源可继承/);
  assert.match(defaults, /现有仍继承该字段的来源也会跟随/);
  assert.match(defaults, /来源专属知识应保留在当前来源/);
  assert.match(defaults, /&lt;script&gt;/);
  const specific = render(FeedbackDiff, { index: 1, change: { ...change('source', 'settings.replyStyle', '简短'), before: null } });
  assert.match(specific, /当前来源 · 回复风格/);
  assert.match(specific, /仅当前来源，不修改默认配置或其他来源/);
  assert.match(specific, /继承默认配置，尚未单独设置/);
});

test('mixed-scope proposals retain explicit approval and explain inheritance at confirmation', () => {
  const changes = propose([change('global', 'learningGuidance', '通用指导'), change('source', 'context', '本来源知识')]);
  const html = render(LearningBatch, { batch: { id: 'batch1', status: 'pending', cases: [], proposal: { status: 'pending', revision: 1, hash: 'h', changes } }, action() {}, openSession() {} });
  assert.match(html, /确认并应用修改/);
  assert.match(html, /默认配置 · 学习指导/);
  assert.match(html, /当前来源 · 共用背景/);
  assert.match(html, /已单独设置的来源保持自己的配置/);
});
