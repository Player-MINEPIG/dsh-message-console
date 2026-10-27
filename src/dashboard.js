const activeDraft = draft => ['pending-supervision', 'ready', 'blocked', 'stale', 'sending', 'unknown'].includes(draft.status);
export const currentAnalysis = item => item.analysis && (item.analyzedVersion === undefined || item.analyzedVersion === item.version) ? item.analysis : null;
export const hasUrgency = item => Boolean(currentAnalysis(item)?.urgent && currentAnalysis(item)?.urgencyReason?.trim());
export const itemPriority = item => (currentAnalysis(item)?.importance ?? 0) * 10 + (hasUrgency(item) ? 3 : 0);
export function needsHandling(item, drafts = []) {
  if (item.attentionAcknowledged) return false;
  if (['pending', 'later'].includes(item.handling)) return true;
  if (drafts.some(draft => draft.itemId === item.id && activeDraft(draft))) return true;
  if (item.handling === 'done') return false;
  return Boolean(item.organizationError) || ['human', 'review'].includes(currentAnalysis(item)?.intervention);
}
export function itemStatus(item,drafts=[]) {
  return needsHandling(item,drafts)?'handling':item.readVersion!==item.version?'unread':'read';
}
