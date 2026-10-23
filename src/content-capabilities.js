export const canDraft = kind => ['comment', 'issue', 'pr'].includes(kind);
export const isPrivateSource = source => source?.platform === 'bilibili' && source.types?.includes('private-message');
export function applies(spec, source) {
  return spec.scope === 'common' || spec.scope === source.platform ||
    (spec.scope === 'reply' && source.platform === 'bilibili' && !isPrivateSource(source)) ||
    (spec.scope === 'decision' && source.platform === 'bilibili') ||
    (spec.scope === 'analysis' && (source.types ?? []).some(type => ['comment', 'issue', 'pr', 'release'].includes(type)));
}
