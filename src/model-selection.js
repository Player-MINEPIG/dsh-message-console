export function modelRoute(settings, supervisor = false) {
  if (!supervisor) return { provider: settings.writerProvider ?? '', model: settings.writerModel ?? '' };
  const provider = settings.supervisorProvider || settings.writerProvider || '';
  const model = settings.supervisorModel || (provider === settings.writerProvider ? settings.writerModel : '') || '';
  return { provider, model };
}
export function canInheritModel(defaults, settings, supervisor = false) {
  const key = supervisor ? 'supervisorModel' : 'writerModel';
  return !defaults[key] || modelRoute(defaults, supervisor).provider === modelRoute(settings, supervisor).provider;
}
export function changeProvider(values, providerKey, selection, { inherit = false, defaults = {} } = {}) {
  const next = { ...values }, modelKey = providerKey === 'writerProvider' ? 'writerModel' : 'supervisorModel';
  if (inherit) { delete next[providerKey]; delete next[modelKey]; }
  else { next[providerKey] = selection; next[modelKey] = ''; }
  if (providerKey === 'writerProvider' && modelRoute({ ...defaults, ...values }, true).provider !== modelRoute({ ...defaults, ...next }, true).provider) {
    if (inherit && modelRoute(defaults, true).provider === modelRoute({ ...defaults, ...next }, true).provider) delete next.supervisorModel;
    else next.supervisorModel = '';
  }
  return next;
}
