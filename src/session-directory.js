/** Reconcile persisted identities with the host's shared live/cold catalog. */
export function watchSessionDirectory(sessions, sessionIds, onError = () => {}) {
  if (!sessions || !sessionIds.length) return () => {};
  let active = true, refreshing = false, missingKey = '', attempts = 0;
  const known = [...new Set(sessionIds)].sort();
  const check = () => {
    if (!active) return;
    const snapshot = sessions.list.getSnapshot();
    if (snapshot.phase === 'pending') return;
    const present = new Set(snapshot.ids);
    const missing = known.filter(id => !present.has(id)).join(',');
    if (!missing) { missingKey = ''; attempts = 0; return; }
    if (missing !== missingKey) { missingKey = missing; attempts = 0; }
    if (refreshing || attempts >= 2) return;
    refreshing = true; attempts++;
    Promise.resolve().then(() => sessions.refresh()).catch(error => {
      attempts = 2;
      if (active) onError(error);
    }).finally(() => {
      refreshing = false;
      // A removed frame arriving during a shared pull overrides its baseline.
      // One following pull recovers that cold row; absent identities never loop.
      if (active) check();
    });
  };
  const unsubscribe = sessions.list.subscribe(check);
  check();
  return () => { active = false; unsubscribe(); };
}

/** Keep recovery alive while another DSH main view owns the screen. */
export function syncSessionDirectory(sessions, loadDirectory, { pollMs = 5000, onError = () => {} } = {}) {
  let active = true, key = '', inflight = null, stopWatch = () => {};
  const pull = () => {
    if (!active) return Promise.resolve();
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => active ? loadDirectory() : null).then(result => {
      if (!active || !result) return;
      const { sessionIds } = result;
      const ids = [...new Set(sessionIds)].sort(), nextKey = ids.join(',');
      if (nextKey === key) return;
      key = nextKey; stopWatch();
      stopWatch = watchSessionDirectory(sessions, ids, onError);
    }).catch(error => { if (active) onError(error); }).finally(() => { inflight = null; });
    return inflight;
  };
  const timer = pollMs > 0 ? setInterval(() => void pull(), pollMs) : null;
  timer?.unref?.();
  void pull();
  return { pull, dispose() { active = false; if (timer !== null) clearInterval(timer); stopWatch(); } };
}
