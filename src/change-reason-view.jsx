import React from 'react';
import { reasonText, conclusionLabel } from './change-reason.js';

export function ChangeReason({ organization, showComments = false }) {
  if (!organization?.reason) return null;
  const { reason, pending } = organization, comments = reason.comments, samples = comments?.samples ?? [];
  const total = (comments?.added ?? 0) + (comments?.edited ?? 0) + (comments?.removed ?? 0);
  const replies = reason.itemKind === 'comment' && total > 0;
  return <div className="dmc-change-reason">
    <p className="dmc-trigger-reason">{pending ? '待整理变化：' : '触发原因：'}{reasonText(reason)}{reason.inferred && '（根据历史版本还原）'}</p>
    {replies && <p className="dmc-muted">{reason.rootChanged ? '根评论也有变化。' : '根评论未变化。'}本轮整理对象包含楼中楼对话。</p>}
    {replies && organization.conclusion && reason.previousConclusion && <p className="dmc-conclusion-change">{reason.previousConclusion === organization.conclusion ? `整楼处理建议未变：${conclusionLabel(organization.conclusion)}` : `整楼处理建议：${conclusionLabel(reason.previousConclusion)} → ${conclusionLabel(organization.conclusion)}`}</p>}
    {showComments && replies && <div className="dmc-changed-comments">{samples.map(comment => <div className="dmc-changed-comment" key={comment.change + comment.id}>
      <small>楼中楼 · {{ added: '新增', edited: '修改', removed: '不再可见 · 此前采集的内容' }[comment.change]} · {comment.author || '作者未知'}</small>
      <p className="dmc-card-excerpt">{comment.excerpt || '（无文字内容）'}</p>
    </div>)}{total > samples.length && <p className="dmc-muted">共 {total} 条变化，展示前 {samples.length} 条；展开详情查看完整变化。</p>}</div>}
  </div>;
}
