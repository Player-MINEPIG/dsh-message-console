import { createHash } from 'node:crypto';
import { validateMaterials, validateStageContexts } from './source-context.js';
import { PARAMETERS, applies, validateSettings } from './config.js';

export const learningHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const learningConfigurationFields = Object.freeze({
  source: Object.freeze(['context', 'attentionRules', ...['decision', 'escalation', 'generation', 'supervision'].map(stage => `stageContexts.${stage}.context`), 'textMaterial', ...['learningGuidance', 'language', 'replyStyle', 'reviewFocus'].map(key => `settings.${key}`)]),
  global: Object.freeze(['learningGuidance', 'language', 'replyStyle', 'reviewFocus']),
});
const fields = Object.fromEntries(Object.entries(learningConfigurationFields).map(([target, keys]) => [target, new Set(keys)]));
function validateChange(change, source) {
  if (!change || !fields[change.target]?.has(change.field)) throw new Error('此字段不允许通过学习修改');
  if (typeof change.after !== 'string' || change.after.length > (change.field === 'textMaterial' ? 100000 : change.field === 'attentionRules' || change.target === 'global' || change.field.startsWith('settings.') ? 10000 : 20000)) throw new Error('建议文字无效或过长');
  if (change.field !== 'textMaterial' && change.materialName !== undefined) throw new Error('只有文本知识可以指定资料名称');
  if (change.target === 'source' && change.field.startsWith('settings.')) {
    const key = change.field.slice('settings.'.length);
    if (!applies(PARAMETERS[key], source)) throw new Error(`此来源不适用：${key}`);
  }
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateFeedback(input) {
  if (!object(input) || typeof input.text !== 'string' || input.text.length > 10000 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.itemVersion !== 'string' || !Number.isSafeInteger(input.analysisRevision) || input.analysisRevision < 0) throw new Error('评价需要正文、评价版本和内容/分析版本，最多10000字');
  return { ...input, text: input.text.trim() };
}
export function proposalChanges(submission, batch) {
  if (!object(submission) || typeof submission.operationKey !== 'string' || !submission.operationKey.trim() || submission.operationKey.length > 160 || typeof submission.summary !== 'string' || !submission.summary.trim() || submission.summary.length > 10000 || !Array.isArray(submission.changes) || submission.changes.length > 24 || JSON.stringify(submission).length > 200000) throw new Error('学习建议需要操作键、说明和最多24项修改');
  const caseIds = new Set(batch.cases.map(entry => entry.id)), seen = new Set();
  const changes = submission.changes.map(change => {
    if (!object(change) || Object.keys(change).some(key => !['target', 'field', 'after', 'caseIds', 'materialName'].includes(key)) || !['source', 'global'].includes(change.target) || typeof change.after !== 'string' || !Array.isArray(change.caseIds) || !change.caseIds.length || change.caseIds.some(id => !caseIds.has(id))) throw new Error('建议修改或对应案例无效');
    validateChange(change, batch.sourceSnapshot);
    if (change.field === 'textMaterial' && typeof change.materialName === 'string') change = { ...change, materialName: change.materialName.trim() };
    let before;
    if (change.field === 'textMaterial') {
      if (typeof change.materialName !== 'string' || !change.materialName.trim() || change.materialName.length > 120 || !change.after.trim()) throw new Error('文本知识需要名称与正文');
      const matches = (batch.sourceSnapshot.materials ?? []).filter(material => material.name === change.materialName);
      if (matches.length > 1 || matches.some(material => material.kind !== 'text')) throw new Error('不能覆盖文件资料或重名资料');
      before = matches[0]?.text ?? null;
    } else if (change.target === 'global') before = batch.settingsSnapshot[change.field] ?? PARAMETERS[change.field].default;
    else if (change.field.startsWith('settings.')) before = batch.sourceSnapshot.settings?.[change.field.slice('settings.'.length)] ?? null;
    else if (change.field.startsWith('stageContexts.')) before = batch.sourceSnapshot.stageContexts?.[change.field.split('.')[1]]?.context ?? '';
    else before = batch.sourceSnapshot[change.field] ?? '';
    const key = `${change.target}:${change.field}:${change.materialName ?? ''}`;
    if (seen.has(key)) throw new Error('同一字段不能重复修改');
    seen.add(key);
    const effectiveBefore = change.field.startsWith('settings.') && before === null ? batch.settingsSnapshot[change.field.slice('settings.'.length)] ?? PARAMETERS[change.field.slice('settings.'.length)].default : before;
    const defaultChange = change.field.startsWith('settings.') && before === null ? submission.changes.find(entry => entry?.target === 'global' && entry.field === change.field.slice('settings.'.length)) : null;
    if (effectiveBefore === change.after && (!defaultChange || defaultChange.after === change.after)) throw new Error('建议没有实际修改');
    return { ...change, caseIds: [...new Set(change.caseIds)], before };
  });
  applyLearningChanges(batch.sourceSnapshot, batch.settingsSnapshot, changes);
  return changes;
}
export function applyLearningChanges(source, settings, changes) {
  const nextSource = structuredClone(source), nextSettings = structuredClone(settings);
  for (const change of changes) {
    validateChange(change, nextSource);
    if (change.target === 'global') nextSettings[change.field] = change.after;
    else if (change.field.startsWith('settings.')) {
      nextSource.settings ??= {};
      nextSource.settings[change.field.slice('settings.'.length)] = change.after;
    } else if (change.field === 'textMaterial') {
      const materials = nextSource.materials ??= [], index = materials.findIndex(material => material.name === change.materialName);
      const value = { kind: 'text', name: change.materialName, text: change.after };
      if (index < 0) materials.push(value); else materials[index] = value;
    } else if (change.field.startsWith('stageContexts.')) {
      const stage = change.field.split('.')[1];
      nextSource.stageContexts ??= {};
      nextSource.stageContexts[stage] = { ...nextSource.stageContexts[stage], context: change.after };
    } else nextSource[change.field] = change.after;
  }
  validateSettings(nextSettings);
  validateSettings(nextSource.settings ?? {});
  validateMaterials(nextSource.materials);
  validateStageContexts(nextSource.stageContexts);
  return { source: nextSource, settings: nextSettings };
}
