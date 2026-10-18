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
  let active = true, after = 0, inflight = null, stopWatch = () => {};
  const known = new Set();
  const pull = () => {
    if (!active) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      let changed = false;
      try {
        let hasMore;
        do {
          const result = await loadDirectory({ after, limit: 100 });
          if (!active) return;
          for (const change of result.changes) {
            if (change.eligible && !known.has(change.sessionId)) { known.add(change.sessionId); changed = true; }
            if (!change.eligible && known.delete(change.sessionId)) changed = true;
          }
          if (result.hasMore && result.next <= after) throw new Error('会话目录游标未前进');
          after = result.next;
          hasMore = result.hasMore;
        } while (active && hasMore);
      } catch (error) { if (active) onError(error); }
      finally {
        if (active && changed) { stopWatch(); stopWatch = watchSessionDirectory(sessions, [...known], onError); }
      }
    })().finally(() => { inflight = null; });
    return inflight;
  };
  const timer = pollMs > 0 ? setInterval(() => void pull(), pollMs) : null;
  timer?.unref?.();
  void pull();
  return { pull, dispose() { active = false; if (timer !== null) clearInterval(timer); stopWatch(); } };
}
