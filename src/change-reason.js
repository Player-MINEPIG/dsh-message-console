export const conclusion = analysis => {
  if (!analysis || analysis.decision?.probabilities && !analysis.decision?.choice) return null;
  if (['ignore', 'draft', 'human'].includes(analysis.decision?.choice)) return analysis.decision.choice;
  return { none: 'ignore', human: 'human', review: 'draft' }[analysis.intervention] ?? null;
};
export const conclusionLabel = value => ({ ignore: '无需回复', draft: '准备回复', human: '需你判断' }[value] ?? '未记录');

export function reasonText(reason) {
  if (!reason) return '旧记录未保存触发原因';
  const retry = reason.retry ? '上轮未完成，重试；' : '';
  if (reason.kind === 'initial') return retry + '首次整理已有内容';
  if (reason.kind === 'new') return retry + '首次整理新内容';
  if (reason.kind === 'unknown') return '旧记录缺少可核对的版本，无法还原触发原因';
  if (reason.kind === 'same-version') return '同版本再次整理；旧记录未保存具体原因';
  const parts = [];
  if (reason.rootImagesChanged) parts.push('根评论图片变化');
  if ((reason.rootTextChanged || reason.rootChanged && !reason.rootImagesChanged)) parts.push(reason.itemKind === 'comment' ? '根评论内容变化' : '标题或正文变化');
  if (reason.contextChanged) parts.push('讨论背景或平台信息变化');
  const label = reason.itemKind === 'private-message' ? '私信消息' : reason.itemKind === 'comment' ? '楼中楼' : '讨论评论';
  if (reason.comments?.added) parts.push(`${label}新增 ${reason.comments.added} 条`);
  if (reason.comments?.edited) parts.push(`${label}修改 ${reason.comments.edited} 条`);
  if (reason.comments?.removed) parts.push(`${label}不再可见 ${reason.comments.removed} 条`);
  if (reason.comments?.imageChanges) parts.push(`${label}图片变化涉及 ${reason.comments.imageChanges} 条`);
  if (!parts.length) parts.push('采集内容版本变化');
  return retry + parts.join('；');
}
