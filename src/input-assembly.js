import { containsImages } from './images.js';
export const INPUT_BLOCKS = {
  source: '来源信息 / 关注规则',
  context: '来源上下文',
  materials: '资料',
  content: '当前内容 / 讨论',
};
export const INPUT_STAGES = { decision: 'Jev 轻量决策', escalation: '低置信决策升级', generation: '生成 / 分析', supervision: '独立监督' };
export function validateInputStage(stage = 'generation') {
  if (!Object.hasOwn(INPUT_STAGES, stage)) throw new Error('调用阶段无效');
  return stage;
}
export function previewExtras(stage) {
  if (stage === 'escalation') return { decision: { status: '占位：实际执行时附加本轮 Jev 决策，不伪造概率或结果。' } };
  if (stage === 'supervision') return { draft: '占位：实际执行时附加本轮生成的草稿，不代表已有结果。' };
  return {};
}
export const DEFAULT_INPUT_ORDER = Object.keys(INPUT_BLOCKS);

export function validateInputOrder(order = DEFAULT_INPUT_ORDER) {
  if (!Array.isArray(order) || order.length !== DEFAULT_INPUT_ORDER.length || new Set(order).size !== order.length || order.some(key => !Object.hasOwn(INPUT_BLOCKS, key))) throw new Error('信息顺序必须恰好包含来源、上下文、资料、当前内容各一次');
  return [...order];
}

function materialInput(materials = []) {
  return materials.map(material => material.kind === 'file' ? { name: material.name, path: material.path, status: '尚未解析文件，请更新服务端预览' } : { name: material.name, text: material.text });
}
export function contentInput(item) {
  if (!item) return { status: '尚未选择实际内容项。执行时将装入当前内容及已采集讨论。' };
  if(item.kind==='private-message') {
    const all=item.payload?.comments??[], recent=all.slice(-100);
    let remaining=24000, truncated=0;
    const messages=recent.toReversed().map(row=>{
      const text=row.body.slice(0,Math.min(2000,remaining));
      if(text.length<row.body.length)truncated++;
      remaining-=text.length;
      return {id:row.id,author:row.author,direction:row.direction,createdAt:row.createdAt,messageType:row.messageType,withdrawn:row.withdrawn,body:text};
    }).reverse();
    return {id:item.id,kind:item.kind,title:item.title,version:item.version,contact:item.payload?.contact,collection:item.payload?.collection,visibilityLimit:item.payload?.visibilityLimit,modelScope:{storedMessages:all.length,messages:messages.length,firstId:messages[0]?.id,lastId:messages.at(-1)?.id,maxMessages:100,maxBodyCharacters:24000,maxPerMessage:2000,truncatedMessages:truncated,note:'仅评定此范围的重要性。范围外消息未输入模型；图片/卡片仅使用已有文字及占位，不能声称查看媒体。'},messages};
  }
  const content = Object.fromEntries(['id','sourceId','remoteId','kind','title','body','url','payload','rootAuthorId','version','changedAt'].filter(key => item[key] !== undefined).map(key => [key, item[key]]));
  if (item.previous) content.previous = Object.fromEntries(['title','body','version'].filter(key => item.previous[key] !== undefined).map(key => [key, item.previous[key]]));
  if (containsImages(item)) content.imageStatus = "包含图片。本数据块仅有链接与元数据；只有决策升级阶段会另附实际图片，以imageInput清单为准。其他阶段仅参考升级判断的reason，不得声称自己已看过图片。";
  return content;
}
export function assembleInput(source, item = null, { language, stage = 'generation' } = {}) {
  validateInputStage(stage);
  const scoped = source.resolvedStageContexts?.[stage] ?? source.stageContexts?.[stage] ?? {};
  const sharedMaterials = source.resolvedMaterials ?? materialInput(source.materials);
  const scopedMaterials = source.resolvedStageContexts?.[stage]?.materials ?? materialInput(scoped.materials);
  const values = {
    source: { name: source.name, platform: source.platform, target: source.target, description: source.description ?? '', tags: source.tags ?? [], rules: source.attentionRules ?? '', ...(source.platform === 'github' ? { ownLogin: source.metadata?.identity ?? null } : {}) },
    context: scoped.context ? { shared: source.context ?? '', [stage]: scoped.context } : source.context ?? '',
    materials: [...sharedMaterials, ...scopedMaterials.map(material => ({ ...material, scope: stage }))],
    content: contentInput(item),
  };
  return { stage, blocks: validateInputOrder(source.inputOrder).map(key => ({ key, label: INPUT_BLOCKS[key], value: values[key] })), ...(source.learningGuidance ? { learningGuidance: source.learningGuidance } : {}), ...(source.contextVersion ? { contextVersion: source.contextVersion } : {}), ...(language ? { language } : {}) };
}

export function serializeInput(input, extras = {}) {
  return JSON.stringify({ ...input, ...extras }, null, 2);
}
