export const AUTO_REPLY_PREFIX = '由「看点什么」插件自动回复：';
export const AUTO_REPLY_REVIEW_RULE = `自动回复必须以“${AUTO_REPLY_PREFIX}”开头，明确披露插件身份；缺少、改写或不在开头均不通过。只能依据已知事实和用户已确认规则回复，不得替用户决定立场或作出承诺。回复目标必须是本楼明确的外部评论，不能回复自己或重复回答同一评论。重要程度与是否需要人工判断分别评定。`;
export function disclosedReply(body) {
  return body.startsWith(AUTO_REPLY_PREFIX) ? body : `${AUTO_REPLY_PREFIX}\n${body}`;
}
export function replyTarget(item, targetId, ownId) {
  const root = String(item.payload?.root ?? '');
  if (!/^\d+$/.test(root) || typeof targetId !== 'string' || !/^\d+$/.test(targetId)) throw new Error('回复必须指定本楼明确的评论 ID');
  const target = targetId === root ? { id: root, authorId: item.rootAuthorId ?? item.payload?.authorId, body: item.body } : item.payload?.comments?.find(comment => comment.id === targetId);
  if (!target) throw new Error('回复目标不属于当前评论对话');
  if (ownId && !target.authorId) throw new Error('无法确认目标评论作者，需要人工查看');
  if (ownId && String(target.authorId ?? '') === ownId) throw new Error('不能自动回复当前登录账号自己的评论');
  return target;
}
export function automaticReplyProblem({ source, item, draft, run, ownId }) {
  if (source.platform !== 'bilibili' || item.kind !== 'comment' || source.autoReply !== true || !source.enabled) return '此来源未授权自动回复';
  if (run?.kind !== 'automatic' || run.decision?.resolved?.choice !== 'draft' || run.decision.resolved.certain !== true || run.resultAdopted !== true) return '本轮没有明确的自动回复决策';
  if (run.result?.intervention === 'human' || run.result?.evidence === 'insufficient') return '当前分析需要人工判断或缺少依据';
  if (!draft.automatic || !ownId) return '无法确认自动草稿或当前账号身份';
  if (!draft.body.startsWith(AUTO_REPLY_PREFIX)) return '自动回复缺少开头身份标识';
  if ((item.payload?.comments ?? []).some(comment => String(comment.authorId ?? '') === ownId && comment.parent === draft.replyToCommentId)) return '当前账号已经回复过该评论';
  try { replyTarget(item, draft.replyToCommentId, ownId); } catch (error) { return error.message; }
  return null;
}
