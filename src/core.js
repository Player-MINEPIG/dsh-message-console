import { assembleInput, serializeInput, validateInputStage, previewExtras } from './input-assembly.js';
import { itemPriority } from './dashboard.js';
import { prepareSource, postHistoryText } from './source-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { validateSource, validateSettings, resolveSettings, valuesOf, PARAMETERS } from './config.js';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nowISO = clock => new Date(clock()).toISOString();
const itemKey = (sourceId, remoteId) => `${sourceId}:${remoteId}`;
const required = (value, label) => { if (!value) throw new Error(`${label}不存在`); return value; };
const errorText = error => String(error?.publicMessage ?? error?.message ?? error).slice(0, 1000);
const audit = (state, event, detail, at) => state.audit.push({ id: randomUUID(), at, event, ...detail });

export class ConsoleService {
  #jobs = new Map(); #aborts = new Set(); #timer; #closed = false;
  constructor({ store, connectors, executor, workspaces, clock = Date.now }) { Object.assign(this, { store, connectors, executor, workspaces, clock }); }
  view() {
    const state = this.store.read();
    const sources = Object.values(state.sources).map(source => ({ ...source, effective: resolveSettings(state.settings, source), connection: this.connectors[source.platform]?.status?.() ?? { ready: false, reason: '连接器不可用' } }));
    const items = Object.values(state.items).sort((a,b) =>
      itemPriority(b) - itemPriority(a) || b.changedAt.localeCompare(a.changedAt));
    return { ...state, sources, items, drafts: Object.values(state.drafts), runs: Object.values(state.runs), parameters: PARAMETERS, busy: [...this.#jobs.keys()] };
  }
  sessionDirectory() {
    const state = this.store.read();
    const running = new Set(Object.values(state.runs).filter(run => run.status === 'running').flatMap(run => (run.sessions ?? []).map(session => session.sessionId)));
    return { sessionIds: [...new Set(Object.values(state.items).flatMap(item => (item.sessions ?? []).map(session => session.sessionId)).filter(id => !running.has(id)))].sort() };
  }
  async catalog() { return this.executor.catalog?.() ?? { providers: [], decisionProfiles: [], defaultDecisionProfile: '', providerError: '模型目录不可用', decisionError: 'Jev目录不可用' }; }
  async models(provider) { if (!this.executor.models) throw new Error('宿主模型目录不可用'); return this.executor.models(provider); }
  async configure(settings) { const valid = validateSettings(settings); await this.store.change(state => { state.settings = valid; }); }
  async saveSource(input, id) {
    const valid = validateSource(input);
    const prepared = await prepareSource(valid,await this.workspaces.resolve(valid.workspaceId));
    return this.store.change(state => {
      const old = id ? required(state.sources[id], '来源') : null;
      if (old && (old.platform !== valid.platform || old.target !== valid.target || JSON.stringify(old.types) !== JSON.stringify(valid.types))) throw new Error('更换平台、目标或类型请新建来源，以建立独立基线。');
      const source = { ...old, ...valid, id: id ?? randomUUID(), initialized: old?.initialized ?? false, createdAt: old?.createdAt ?? nowISO(this.clock) };
      if (old && old.contextVersion !== prepared.contextVersion) {
        for(const draft of Object.values(state.drafts)) if(draft.sourceId===source.id && ['ready','blocked'].includes(draft.status)) draft.status='stale';
        for (const item of Object.values(state.items)) if (item.sourceId === source.id && item.analysis) item.analyzedVersion = null;
      }
      source.contextVersion = prepared.contextVersion;
      state.sources[source.id] = source;
      audit(state, 'source.saved', { sourceId: source.id }, nowISO(this.clock));
      return source;
    });
  }
  async previewInput({ source: input, sourceId, itemId, stage = 'generation' }) {
    validateInputStage(stage);
    const valid = validateSource(input);
    const state = this.store.read();
    if (sourceId) {
      const existing = required(state.sources[sourceId], '来源');
      if (existing.platform !== valid.platform || existing.target !== valid.target || JSON.stringify(existing.types) !== JSON.stringify(valid.types)) throw new Error('预览来源目标不匹配');
    }
    const item = itemId ? required(state.items[itemId], '内容项') : null;
    if (item && (!sourceId || item.sourceId !== sourceId)) throw new Error('只能预览此来源的内容项');
    const prepared = await prepareSource(valid, await this.workspaces.resolve(valid.workspaceId));
    const inputData = { ...assembleInput(prepared, item, { language: valuesOf(resolveSettings(state.settings, valid)).language, stage }), ...previewExtras(stage) };
    return { input: inputData, serialized: serializeInput(inputData), postHistory: postHistoryText(prepared), itemId: item?.id ?? null };
  }
  async markRead(id, version) {
    await this.store.change(state => {
      const item = required(state.items[id], '内容项');
      if (version && item.version !== version) throw new Error('内容已更新，请刷新后再标记');
      item.readVersion = item.version;
    });
  }
  async setHandling(id, handling) {
    if (!['none', 'pending', 'later', 'done'].includes(handling)) throw new Error('处理状态无效');
    await this.store.change(state => { required(state.items[id], '内容项').handling = handling; });
  }
  #job(key, work, { busyMessage } = {}) {
    if (this.#closed) return Promise.reject(new Error('插件已停止'));
    if (this.#jobs.has(key)) return busyMessage ? Promise.reject(new Error(busyMessage)) : this.#jobs.get(key);
    const promise = Promise.resolve().then(work).finally(() => this.#jobs.delete(key));
    this.#jobs.set(key, promise); return promise;
  }
  refresh(sourceId, { organize = true } = {}) {
    return this.#job(`source:${sourceId}`, async () => {
      const source = required(this.store.read().sources[sourceId], '来源');
      const connector = required(this.connectors[source.platform], '连接器');
      const now = nowISO(this.clock);
      let fetched = false, fetchError;
      if (!source.retryAt || this.clock() >= Date.parse(source.retryAt)) {
        const controller = new AbortController(); this.#aborts.add(controller);
        try {
          const batch = await connector.fetch(source, { signal: controller.signal });
          if (!batch.complete || !Array.isArray(batch.items)) throw new Error('抓取不完整，本轮不推进基线');
          const seen = new Set();
          for (const entry of batch.items) {
            if (!entry.remoteId || !entry.title || !source.types.includes(entry.kind) || seen.has(entry.remoteId)) throw new Error('连接器返回内容无效或ID重复');
            seen.add(entry.remoteId);
          }
          await this.store.change(state => {
            const current = required(state.sources[sourceId], '来源');
            for (const entry of batch.items) {
              const id = itemKey(sourceId, entry.remoteId);
              const version = fingerprint({ title: entry.title, body: entry.body, payload: entry.payload });
              const old = state.items[id];
              if (old?.version === version) continue;
              state.items[id] = { ...old, ...entry, id, sourceId, version, readVersion: old?.readVersion ?? (!current.initialized ? version : null), analyzedVersion: old?.analyzedVersion ?? (!current.initialized ? version : null), previous: old ? { title: old.title, body: old.body, version: old.version } : null, changedAt: now, handling: old?.handling ?? 'none', sessions: old?.sessions ?? [], analysis: old?.analysis ?? null };
              for (const draft of Object.values(state.drafts)) {
                if (draft.itemId === id && ['ready', 'blocked'].includes(draft.status)) draft.status = 'stale';
              }
            }
            current.metadata = batch.metadata??null; current.initialized = true; current.fetchedAt = now; current.fetchError = null; current.retryAt = null;
          });
          fetched = true;
        } catch (error) {
          fetchError = errorText(error);
          await this.store.change(state => { const current = state.sources[sourceId]; current.fetchError = fetchError; current.retryAt = new Date(this.clock() + (error.retryMs ?? 60_000)).toISOString(); });
        } finally { this.#aborts.delete(controller); }
      } else fetchError = `等待连接器冷却至 ${source.retryAt}`;
      const organization = organize ? await this.#organize(sourceId, { scope: 'changes' }) : null;
      return { fetched, error: fetchError ?? null, organization };
    }, { busyMessage: '此来源正在刷新或整理，请完成后再试。' });
  }
  organize(sourceId, { scope = 'changes' } = {}) {
    if (!['changes', 'history'].includes(scope)) throw new Error('整理范围无效');
    return this.#job(`source:${sourceId}`, () => this.#organize(sourceId, { scope }), { busyMessage: '此来源正在刷新或整理，请完成后再试。' });
  }
  async #organize(sourceId, { scope }) {
    const snapshot = this.store.read();
    const source = required(snapshot.sources[sourceId], '来源');
    const settings = valuesOf(resolveSettings(snapshot.settings, source));
    let prepared, preparationError;
    try { prepared = await prepareSource(source, await this.workspaces.resolve(source.workspaceId)); } catch (error) { preparationError = error; }
    const items = Object.values(snapshot.items).filter(item => item.sourceId === sourceId);
    const candidates = items.filter(item => item.analyzedVersion !== item.version || prepared && item.analysis && item.analyzedContextVersion !== prepared.contextVersion || scope === 'history' && !item.analysis);
    const summary = { sourceId, scope, contextVersion: prepared?.contextVersion ?? source.contextVersion, startedAt: nowISO(this.clock), total: items.length, candidates: candidates.length, completed: 0, failed: 0, skipped: 0, errors: [] };
    for (const item of candidates) {
      if (this.#closed) break;
      const runId = randomUUID(); const controller = new AbortController(); this.#aborts.add(controller);
      await this.store.change(state => { state.runs[runId] = { id: runId, itemId: item.id, version: item.version, status: 'running', startedAt: nowISO(this.clock), decision: null, sessions: [] }; });
      const record = async (role, sessionId) => {
        await this.store.change(state => {
          const link = { role, sessionId, workspaceId: source.workspaceId, at: nowISO(this.clock) };
          state.runs[runId].sessions.push(link);
          if (!state.items[item.id].sessions.some(session => session.sessionId === sessionId)) state.items[item.id].sessions.push(link);
        });
      };
      try {
        if (preparationError) throw preparationError;
        await this.store.change(state=>{
          state.runs[runId].contextVersion=prepared.contextVersion;
          for (const draft of Object.values(state.drafts)) if (draft.itemId === item.id && ['ready','blocked'].includes(draft.status) && draft.contextVersion !== prepared.contextVersion) draft.status = 'stale';
          if (state.items[item.id].analysis && state.items[item.id].analyzedContextVersion !== prepared.contextVersion) state.items[item.id].analyzedVersion = null;
        });
        const result = await this.executor.analyze({ source:prepared, item, settings, signal: controller.signal, recordSession: record,
          recordDecision: decision => this.store.change(state => { state.runs[runId].decision = decision; }) });
        if (!result || typeof result.summary !== 'string' || !Number.isInteger(result.importance) || result.importance < 0 || result.importance > 3) throw new Error('分析输出结构无效');
        const applied = await this.store.change(state => {
          const current = state.items[item.id];
          const run = state.runs[runId]; run.finishedAt = nowISO(this.clock);
          if (current.version !== item.version || state.sources[sourceId].contextVersion !== source.contextVersion || state.sources[sourceId].workspaceId !== source.workspaceId) { run.status = 'stale'; return false; }
          run.status = 'completed'; run.processing = result.processing ?? null; current.analysis = result; current.analyzedVersion = item.version; current.analyzedContextVersion = prepared.contextVersion;
          if (current.handling === 'none' && result.intervention === 'human') current.handling = 'pending';
          if (result.draft?.body) {
            const draft = { contextVersion: prepared.contextVersion, id: randomUUID(), itemId: item.id, sourceId, version: item.version, body: result.draft.body, kind: item.kind === 'pr' ? 'review' : 'reply', supervision: result.draft.supervision, status: result.draft.supervision?.approved === true ? 'ready' : 'blocked', createdAt: nowISO(this.clock), runId };
            state.drafts[draft.id] = draft;
          }
          return true;
        });
        if (applied) summary.completed++;
      } catch (error) {
        summary.failed++;
        summary.errors.push({ itemId: item.id, title: item.title, message: errorText(error), ...(error.sessionFailure ? { sessionId: error.sessionFailure.sessionId } : {}) });
        await this.store.change(state => { const run = state.runs[runId]; run.status = controller.signal.aborted ? 'interrupted' : 'failed'; run.error = errorText(error); if (error.sessionFailure) run.failure = error.sessionFailure; run.finishedAt = nowISO(this.clock); });
      } finally { this.#aborts.delete(controller); }
    }
    summary.skipped = summary.total - summary.completed - summary.failed;
    summary.finishedAt = nowISO(this.clock);
    summary.status = summary.failed ? summary.completed ? 'partial' : 'failed' : summary.completed ? 'completed' : 'skipped';
    summary.reason = null;
    if (!summary.candidates) {
      if (!items.length) summary.reason = '还没有已采集的内容，请先刷新来源。';
      else if (scope === 'changes' && items.some(item => !item.analysis)) summary.reason = '没有待整理的新变化。首次基线仅在手动整理已有数据时处理。';
      else summary.reason = '当前内容及来源背景均已整理，无需重复运行。';
    } else if (summary.completed + summary.failed < summary.candidates) summary.reason = '部分候选项在整理期间已变化或插件已停止，本轮跳过，可稍后重试。';
    await this.store.change(state => { state.sources[sourceId].organizedAt = summary.finishedAt; state.sources[sourceId].lastOrganization = summary; });
    return summary;
  }
  async openConversation(itemId) {
    return this.#job(`conversation:${itemId}`, async () => {
      const state = this.store.read();
      const item = required(state.items[itemId], '内容项');
      const source = required(state.sources[item.sourceId], '来源');
      const prepared = await prepareSource(source,await this.workspaces.resolve(source.workspaceId));
      const existing = item.sessions.find(session => session.role === 'human' && session.version === item.version && session.workspaceId === source.workspaceId && session.contextVersion === prepared.contextVersion);
      if (existing) return { sessionId: existing.sessionId };
      const sessionId = await this.executor.conversation({ item, source:prepared, settings: valuesOf(resolveSettings(state.settings, source)) });
      await this.store.change(state => { state.items[itemId].sessions.push({ role: 'human', contextVersion: prepared.contextVersion, sessionId, workspaceId: source.workspaceId, version: item.version, at: nowISO(this.clock) }); });
      return { sessionId };
    });
  }

  async dismissDraft(id) {
    await this.store.change(state => { const draft = required(state.drafts[id], '草稿'); if (!['ready', 'blocked', 'stale'].includes(draft.status)) throw new Error('当前状态不能暂不发布'); draft.status = 'dismissed'; });
  }
  async approveAndPublish(id, { version, bodyHash }) {
    return this.#job(`publish:${id}`, async () => {
      const state = this.store.read(); const draft = required(state.drafts[id], '草稿'); const item = state.items[draft.itemId]; const source = state.sources[draft.sourceId];
      const prepared = await prepareSource(source,await this.workspaces.resolve(source.workspaceId));
      if (draft.contextVersion !== prepared.contextVersion) throw new Error('来源资料已变化，请重新整理并审核');
      if (draft.status !== 'ready' || !draft.supervision?.approved) throw new Error('此草稿未通过监督或不处于待审核状态');
      if (Object.values(state.drafts).some(other => other.itemId === item.id && other.id !== id && ['sending','unknown'].includes(other.status))) throw new Error('此内容项有发送结果尚未确认，请先核实远端，避免重复发布');
      if (item.version !== draft.version || version !== draft.version || bodyHash !== fingerprint(draft.body)) throw new Error('内容或草稿已变化，请重新审核');
      const connector = this.connectors[source.platform];
      if (!connector?.publish || connector.status?.().canPublish !== true) throw new Error('尚未连接可发布的已授权账号');
      // Fetch current remote state before consuming this exact approval.
      const remote = await connector.getItem(source, item);
      if (!remote || fingerprint({ title: remote.title, body: remote.body, payload: remote.payload }) !== item.version) {
        await this.store.change(state => { state.drafts[id].status = 'stale'; });
        throw new Error('原始内容有新变化，请刷新并重新分析后审核');
      }
      await this.store.change(state => {
        const latest = state.drafts[id];
        if (latest.status !== 'ready' || state.items[latest.itemId].version !== latest.version) throw new Error('草稿状态已变化');
        if (Object.values(state.drafts).some(other => other.itemId === latest.itemId && other.id !== id && ['sending','unknown'].includes(other.status))) throw new Error('此内容项有发送结果尚未确认');
        latest.status = 'sending'; latest.approvedAt = nowISO(this.clock);
        audit(state, 'publication.approved', { draftId: id, version, bodyHash }, latest.approvedAt);
      });
      try {
        const receipt = await connector.publish(source, item, draft, { actionId: id });
        if (!receipt?.remoteId) throw new Error('发布缺少可核验回执');
        await this.store.change(state => { const current = state.drafts[id]; current.status = 'sent'; current.receipt = receipt; current.sentAt = nowISO(this.clock); audit(state, 'publication.sent', { draftId: id, remoteId: receipt.remoteId }, current.sentAt); });
        return receipt;
      } catch (error) {
        await this.store.change(state => { const current = state.drafts[id]; current.status = error.definitelyNotSent ? 'ready' : 'unknown'; current.error = errorText(error); audit(state, 'publication.uncertain', { draftId: id }, nowISO(this.clock)); });
        throw error;
      }
    });
  }
  startScheduler() {
    this.#timer = setInterval(() => void this.tick().catch(() => {}), 60_000); this.#timer.unref?.();
  }
  async tick() {
    const state = this.store.read();
    for (const source of Object.values(state.sources).filter(source => source.enabled)) {
      const settings = valuesOf(resolveSettings(state.settings, source));
      if (source.retryAt && Date.parse(source.retryAt) > this.clock()) continue;
      const organize = !source.organizedAt || this.clock() - Date.parse(source.organizedAt) >= settings.organizeHours * 3_600_000;
      if (!source.fetchedAt || this.clock() - Date.parse(source.fetchedAt) >= settings.fetchHours * 3_600_000) await this.refresh(source.id, { organize });
      else if (organize) await this.organize(source.id, { scope: 'changes' });
    }
  }
  async close() {
    this.#closed = true; clearInterval(this.#timer); for (const controller of this.#aborts) controller.abort();
    await Promise.allSettled(this.#jobs.values()); await this.store.close();
  }
}
