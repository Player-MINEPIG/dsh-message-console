const activeDraft = draft => ['ready', 'blocked', 'stale', 'sending', 'unknown'].includes(draft.status);
export const currentAnalysis = item => item.analysis && (item.analyzedVersion === undefined || item.analyzedVersion === item.version) ? item.analysis : null;
export const hasUrgency = item => Boolean(currentAnalysis(item)?.urgent && currentAnalysis(item)?.urgencyReason?.trim());
export const itemPriority = item => (currentAnalysis(item)?.importance ?? 0) * 10 + (hasUrgency(item) ? 3 : 0);
export function needsHandling(item, drafts = []) {
  if (['pending', 'later'].includes(item.handling)) return true;
  if (drafts.some(draft => draft.itemId === item.id && activeDraft(draft))) return true;
  if (item.handling === 'done') return false;
  return currentAnalysis(item)?.intervention === 'human';
}
export function summarizeItems(items, drafts = []) {
  const unique = [...new Map(items.map(item => [item.id, item])).values()];
  return {
    total: unique.length,
    unread: unique.filter(item => item.readVersion !== item.version).length,
    handling: unique.filter(item => needsHandling(item, drafts)).length,
    unreadUnorganized: unique.filter(item => item.readVersion !== item.version && !currentAnalysis(item)).length,
    analyzed: unique.filter(item => currentAnalysis(item)).length,
    importance: Math.max(0, ...unique.map(item => currentAnalysis(item)?.importance ?? 0)),
    urgent: unique.some(hasUrgency),
    priority: Math.max(0, ...unique.map(itemPriority)),
    changedAt: unique.map(item => item.changedAt).filter(Boolean).sort().at(-1) ?? '',
    summaries: unique.filter(item => item.readVersion !== item.version && currentAnalysis(item)?.summary && !['context-incomplete','decision-only'].includes(currentAnalysis(item).processing)).sort((a, b) => itemPriority(b) - itemPriority(a) || (b.changedAt ?? '').localeCompare(a.changedAt ?? '')).slice(0, 2).map(item => currentAnalysis(item).summary),
  };
}
export function compareSummaries(a, b, order = 'priority') {
  return (order === 'updated' ? b.changedAt.localeCompare(a.changedAt) : b.priority - a.priority || b.handling - a.handling || b.unread - a.unread) || b.changedAt.localeCompare(a.changedAt) || a.id.localeCompare(b.id);
}
export function sourceSummaries(state, order = 'priority') {
  return state.sources.map(source => ({ ...source, ...summarizeItems(state.items.filter(item => item.sourceId === source.id), state.drafts) })).sort((a, b) => compareSummaries(a, b, order));
}
export function platformSummaries(state) {
  return ['github', 'bilibili'].map(id => {
    const sources = state.sources.filter(source => source.platform === id), ids = new Set(sources.map(source => source.id));
    return { id, sources: sources.length, ...summarizeItems(state.items.filter(item => ids.has(item.sourceId)), state.drafts) };
  }).sort(compareSummaries);
}
