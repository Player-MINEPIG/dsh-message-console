import { validateInputOrder } from './input-assembly.js';
import { normalizeTarget, validateMaterials, validateStageContexts } from './source-context.js';
export const PARAMETERS = {
  fetchHours: { scope: 'common', default: 6, type: 'number', min: 0.25, max: 168 },
  organizeHours: { scope: 'common', default: 6, type: 'number', min: 0.25, max: 168 },
  language: { scope: 'common', default: '中文', type: 'string' },
  learningGuidance: { scope: 'common', default: '', type: 'string' },
  decisionProfile: { scope: 'reply', default: '', type: 'string' },
  decisionConfidence: { scope: 'reply', default: 0.8, type: 'number', min: 0.5, max: 1 },
  decisionMargin: { scope: 'reply', default: 0.2, type: 'number', min: 0, max: 1 },
  writerProvider: { scope: 'analysis', default: '', type: 'string' },
  writerModel: { scope: 'analysis', default: '', type: 'string' },
  supervisorProvider: { scope: 'analysis', default: '', type: 'string' },
  supervisorModel: { scope: 'analysis', default: '', type: 'string' },
  replyStyle: { scope: 'reply', default: '简明、自然；不擅自代表用户作出承诺。', type: 'string' },
  reviewFocus: { scope: 'github', default: '有依据的正确性问题，标明位置与影响。', type: 'string' },
};

export function validateSettings(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('设置必须为对象');
  for (const [key, value] of Object.entries(input)) {
    const spec = PARAMETERS[key];
    if (!spec) throw new Error(`未知设置：${key}`);
    if (typeof value !== spec.type || (spec.type === 'number' && (!Number.isFinite(value) || value < spec.min || value > spec.max))) throw new Error(`设置值无效：${key}`);
    if (spec.type === 'string' && value.length > 10000) throw new Error(`设置过长：${key}`);
  }
  return structuredClone(input);
}
export function applies(spec, source) {
  return spec.scope === 'common' || spec.scope === source.platform ||
    (spec.scope === 'reply' && source.platform === 'bilibili') ||
    (spec.scope === 'analysis' && source.types.some(type => ['comment', 'issue', 'pr', 'release'].includes(type)));
}
export function resolveSettings(global, source) {
  return Object.fromEntries(Object.entries(PARAMETERS).filter(([, spec]) => applies(spec, source)).map(([key, spec]) => {
    const overridden = Object.hasOwn(source.settings, key);
    return [key, { value: overridden ? source.settings[key] : global[key] ?? spec.default, inherited: !overridden, origin: overridden ? 'source' : Object.hasOwn(global, key) ? 'global' : 'default' }];
  }));
}
export const valuesOf = resolved => Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, value.value]));

export function validateSource(input) {
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('请为来源选择已有工作区');
  const platform = input.platform;
  if (!['github', 'bilibili'].includes(platform)) throw new Error('暂不支持此平台');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('来源名称无效');
  const allowed = platform === 'github' ? ['issue', 'pr', 'release'] : ['comment'];
  if (!Array.isArray(input.types) || !input.types.length || input.types.some(type => !allowed.includes(type))) throw new Error('来源内容类型无效');
  const target = normalizeTarget(platform,input.target);
  for(const key of ['context','postHistoryInstruction']) if(input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length>20000)) throw new Error('来源上下文或post-history指令过长');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 1000)) throw new Error('来源简介最多1000字');
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 12 || input.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40))) throw new Error('来源标签最多12个，每个1至40字');
  const inputOrder = validateInputOrder(input.inputOrder);
  const materials=validateMaterials(input.materials);
  const settings = validateSettings(input.settings ?? {});
  const source = { stageContexts: validateStageContexts(input.stageContexts), inputOrder, description: input.description?.trim() ?? '', tags: [...new Set((input.tags ?? []).map(tag => tag.trim()))], context: input.context??'', postHistoryInstruction: input.postHistoryInstruction??'', materials, workspaceId: input.workspaceId, name: input.name.trim(), platform, target, types: [...new Set(input.types)], settings, enabled: input.enabled !== false, attentionRules: String(input.attentionRules ?? '').slice(0,10000) };
  for (const key of Object.keys(settings)) if (!applies(PARAMETERS[key], source)) throw new Error(`此来源不适用：${key}`);
  return source;
}
