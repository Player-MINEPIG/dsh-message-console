import { canDraft, isPrivateSource } from './content-capabilities.js';
import { learningHash, validateFeedback, applyLearningChanges, learningConfigurationFields } from "./learning.js";
import { assembleInput, serializeInput, validateInputStage, previewExtras } from "./input-assembly.js";
import { prepareSource, postHistoryText } from "./source-context.js";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { validateSource, validateSettings, resolveSettings, valuesOf, PARAMETERS, processingSettingsOf } from "./config.js";
import { suggestionTarget, metadataSuggestions } from "./source-suggestions.js";
import { conclusion } from './change-reason.js';
import { automaticReplyProblem, replyTarget } from "./publication.js";
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nowISO = (clock) => new Date(clock()).toISOString();
const required = (value, label) => {
  if (!value) throw new Error(`${label}不存在`);
  return value;
};
const errorText = (error) => String(error?.publicMessage ?? error?.message ?? error).slice(0, 1e3);
const connectorIdentity = connector => connector?.status?.().identity?.id ?? null;
const roles = ["writer", "review", "investigate", "decision-escalation", "supervisor", "human"];
const analysisRoles = ["writer", "review", "investigate"];
const manualSettings = (global,source) => ({...valuesOf(resolveSettings(global,source)),...(isPrivateSource(source)?{writerProvider:global.writerProvider??PARAMETERS.writerProvider.default,writerModel:global.writerModel??PARAMETERS.writerModel.default}:{})});
function validateAnalysis(a) {
  if (!a || typeof a.summary !== "string" || typeof a.reason !== "string" || !Number.isInteger(a.importance) || a.importance < 0 || a.importance > 3 || typeof a.urgent !== "boolean" || !["none", "human", "review"].includes(a.intervention) || !["confirmed", "inferred", "insufficient"].includes(a.evidence) || a.urgencyReason != null && typeof a.urgencyReason !== "string" || a.urgent && !a.urgencyReason?.trim()) throw new Error("分析结果不符合约定结构");
}
class ConsoleService {
  #jobs = /* @__PURE__ */ new Map();
  #aborts = /* @__PURE__ */ new Set();
  #timer;
  #closed = false;
  constructor({ store, connectors, executor, workspaces, imageCache, clock = Date.now }) {
    Object.assign(this, { store, connectors, executor, workspaces, imageCache, clock });
  }
  image(id, query) {
    return required(this.imageCache, '图片缓存').get(this.store.image(id, query), query.variant ?? 'thumbnail');
  }
  imageForModel(id, query, signal) {
    return required(this.imageCache, '图片缓存').readTransient(this.store.image(id, query), signal);
  }
  imageCacheStatus() { return required(this.imageCache, '图片缓存').stats(); }
  clearImageCache() { return required(this.imageCache, '图片缓存').clear(); }
  storageDirectory() {
    return this.store.directory;
  }
  #sourceView(source) {
    const connection=this.connectors[source.platform]?.status?.() ?? { ready: false, reason: "连接器不可用" };
    return { ...source, effective: resolveSettings(this.store.settings(), source), connection: isPrivateSource(source) ? {...connection,canPublish:false,reason:connection.ready?"Chrome Cookie · 私信只读采集":connection.reason} : connection };
  }
  overview(query = {}) {
    const sources = this.store.overviewSources().map((source) => {
      const result = this.#sourceView(source);
      for (const key of ["context", "materials", "stageContexts", "postHistoryInstruction", "inputOrder", "attentionRules"]) delete result[key];
      return result;
    });
    const platforms = ["github", "bilibili"].map((id) => {
      const rows = sources.filter((s) => s.platform === id);
      return { id, sources: rows.length, total: rows.reduce((n, s) => n + s.total, 0), unread: rows.reduce((n, s) => n + s.unread, 0), handling: rows.reduce((n, s) => n + s.handling, 0), analyzed: rows.reduce((n, s) => n + s.analyzed, 0), unreadUnorganized: rows.reduce((n, s) => n + s.unreadUnorganized, 0), importance: Math.max(0, ...rows.map((s) => s.importance)), urgent: rows.some((s) => s.urgent), priority: Math.max(0, ...rows.map((s) => s.priority)), changedAt: rows.map((s) => s.changedAt).sort().at(-1) ?? "", summaries: rows.flatMap((s) => s.summaries).slice(0, 2) };
    }).sort((a, b) => b.priority - a.priority || b.handling - a.handling || b.unread - a.unread || b.changedAt.localeCompare(a.changedAt));
    const sorted = sources.filter((s) => !query.platform || query.platform === "all" || s.platform === query.platform).sort((a, b) => (query.order === "updated" ? b.changedAt.localeCompare(a.changedAt) : b.priority - a.priority || b.handling - a.handling || b.unread - a.unread) || b.changedAt.localeCompare(a.changedAt) || a.id.localeCompare(b.id));
    return { settings: this.store.settings(), parameters: PARAMETERS, busy: [...this.#jobs.keys()], sources: sorted, platforms, revision: this.store.revision() };
  }
  source(id) {
    return this.#sourceView(required(this.store.source(id), "来源"));
  }
  items(id, query) {
    return this.store.items(id, { showClosed: false, ...query });
  }
  item(id, version) {
    return this.store.header(id, version);
  }
  content(id, args) {
    return this.store.content(id, args);
  }
  comments(id, version, query) {
    return this.store.comments(id, version, query);
  }
  changedComments(id, query) {
    return this.store.changedComments(id, query);
  }
  runs(id, query) {
    return this.store.runs(id, query);
  }
  drafts(id, query) {
    return this.store.drafts(id, query);
  }
  draft(id) {
    return required(this.store.draft(id), "草稿");
  }
  versions(id, query) {
    return this.store.versions(id, query);
  }
  decision(id) {
    return this.store.decision(id);
  }
  sessionDirectory(query) {
    return this.store.sessionDirectory(query);
  }
  async catalog() {
    return this.executor.catalog?.() ?? { providers: [], decisionProfiles: [], defaultDecisionProfile: "", providerError: "模型目录不可用", decisionError: "Jev目录不可用" };
  }
  async models(provider) {
    if (!this.executor.models) throw new Error("宿主模型目录不可用");
    return this.executor.models(provider);
  }
  async suggestSource(input) {
    const source = suggestionTarget(input), connector = this.connectors[source.platform];
    if (!connector?.metadata) throw new Error("此平台尚未配置元信息读取连接，请先导入Cookie；默认指令仍可使用");
    const metadata = await connector.metadata(source);
    return { source, fields: metadataSuggestions(metadata, source), access: metadata.access, note: metadata.note ?? "", fallbackReason: metadata.fallbackReason ?? null };
  }
  async configure(settings) {
    const valid = validateSettings(settings);
    if (this.imageCache) await this.imageCache.updateSettings(() => this.store.configure(valid));
    else this.store.configure(valid);
  }
  async saveSource(input, id) {
    const valid = validateSource(input), prepared = await this.#prepare(valid), old = id ? required(this.store.source(id), "来源") : null;
    if (old && (old.platform !== valid.platform || old.target !== valid.target || JSON.stringify(old.types) !== JSON.stringify(valid.types))) throw new Error("更换平台、目标或类型请新建来源，以建立独立基线。");
    if(isPrivateSource(valid)) {
      const identity=await required(this.connectors.bilibili,'B站连接器').identity();
      if(old?.accountId && old.accountId!==identity.id)throw new Error('B站登录账号与私信来源绑定账号不一致，请恢复原账号Cookie');
      valid.accountId=old?.accountId??identity.id;
    }
    return this.store.saveSource({ ...old, ...valid, id: id ?? randomUUID(), initialized: old?.initialized ?? false, createdAt: old?.createdAt ?? nowISO(this.clock), contextVersion: prepared.contextVersion, ...input.revision !== void 0 ? { expectedRevision: input.revision } : {} });
  }
  async previewInput({ source: input, sourceId, itemId, stage = "generation" }) {
    validateInputStage(stage);
    const valid = validateSource(input);
    if (sourceId) {
      const existing = required(this.store.source(sourceId), "来源");
      if (existing.platform !== valid.platform || existing.target !== valid.target || JSON.stringify(existing.types) !== JSON.stringify(valid.types)) throw new Error("预览来源目标不匹配");
    }
    const item = itemId ? required(this.store.item(itemId), "内容项") : null;
    if (item && (!sourceId || item.sourceId !== sourceId)) throw new Error("只能预览此来源的内容项");
    const prepared = await this.#prepare(valid), inputData = { ...assembleInput(prepared, item, { language: valuesOf(resolveSettings(this.store.settings(), valid)).language, stage }), ...previewExtras(stage) };
    return { input: inputData, serialized: serializeInput(inputData), postHistory: postHistoryText(prepared), itemId: item?.id ?? null };
  }
  async #prepare(source, workspace, settings = this.store.settings()) {
    const learningGuidance = valuesOf(resolveSettings(settings, source)).learningGuidance ?? "";
    const processingSettings = processingSettingsOf(settings, source);
    return prepareSource({ ...source, learningGuidance }, workspace ?? await this.workspaces.resolve(source.workspaceId), { learningGuidance, processingSettings });
  }
  #bulkScope(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["sourceId", "platform"].includes(key))) throw new Error("批量操作范围无效");
    const { sourceId, platform } = input;
    if (sourceId !== void 0 && (typeof sourceId !== "string" || !sourceId)) throw new Error("来源ID无效");
    if (platform !== void 0 && !["github", "bilibili"].includes(platform)) throw new Error("平台无效");
    if (sourceId !== void 0 && platform !== void 0) throw new Error("来源与平台范围不能同时指定");
    return [sourceId, platform];
  }
  markAllRead(scope) { return this.store.markAllRead(...this.#bulkScope(scope)); }
  markAllHandled(scope) { return this.store.markAllHandled(...this.#bulkScope(scope)); }
  feedback(itemId) { return this.store.feedback(itemId); }
  saveFeedback(itemId, input) { return this.store.saveFeedback(itemId, validateFeedback(input), nowISO(this.clock)); }
  learningList(query = {}) { return this.store.learningList(query.sourceId, query); }
  learning(id) {
    const batch = required(this.store.learning(id), "学习批次");
    const { sourceSnapshot, preparedSource, settingsSnapshot, effectiveSettings, ...view } = batch;
    return view;
  }
  async startLearning({ sourceId } = {}) {
    const source = required(this.store.source(sourceId), "来源"), settings = this.store.settings(), prepared = await this.#prepare(source, void 0, settings);
    const batch = this.store.createLearning({ id: randomUUID(), sourceId, workspaceId: source.workspaceId, sourceSnapshot: source, preparedSource: prepared, settingsSnapshot: settings, effectiveSettings: manualSettings(settings, source), baseSourceRevision: source.revision, baseSettingsHash: learningHash(settings), baseContextVersion: prepared.contextVersion, createdAt: nowISO(this.clock) });
    if (batch.status === "queued") this.#launchLearning(batch.id);
    return this.learning(batch.id);
  }
  #launchLearning(id) {
    const promise = this.#job(`learning:${id}`, async () => {
      const batch = required(this.store.learning(id), "学习批次"), controller = new AbortController();
      this.#aborts.add(controller);
      try {
        this.store.updateLearning(id, { status: "running", error: null });
        if (!this.executor.learn) throw new Error("宿主评价学习会话不可用");
        await this.executor.learn({ batchId: id, source: batch.preparedSource, settings: batch.effectiveSettings, signal: controller.signal, recordSession: sessionId => { const current = this.store.learning(id); if (current.sessionId !== String(sessionId)) throw new Error("学习会话未绑定批次"); } });
        const current = this.store.learning(id);
        if (!["pending", "no-suggestions", "applied", "rejected"].includes(current.status)) throw new Error("会话结束但未通过工具保存学习建议");
      } catch (error) {
        const current = this.store.learning(id);
        if (!["pending", "no-suggestions", "applied", "rejected"].includes(current.status)) this.store.updateLearning(id, { status: controller.signal.aborted ? "interrupted" : "failed", error: errorText(error), ...error.sessionFailure ? { failure: error.sessionFailure } : {} });
      } finally { this.#aborts.delete(controller); }
    });
    promise.catch(() => {});
  }
  retryLearning(id) {
    const batch = required(this.store.learning(id), "学习批次");
    if (!["failed", "interrupted", "no-suggestions"].includes(batch.status)) throw new Error("此批次当前不能重试");
    const source = required(this.store.source(batch.sourceId), "来源");
    if (source.workspaceId !== batch.workspaceId) throw new Error("来源工作区已变化，请重新创建批次");
    this.store.updateLearning(id, { status: "queued", error: null });
    this.#launchLearning(id);
    return this.learning(id);
  }
  async bindLearningSession(input) {
    const batch = required(this.store.learning(input.batchId), "学习批次"), source = required(this.store.source(batch.sourceId), "来源"), workspace = await this.workspaces.resolve(batch.workspaceId);
    if (source.workspaceId !== batch.workspaceId || input.workspaceId !== batch.workspaceId || resolve(input.cwd ?? "") !== resolve(workspace.path)) throw new Error("学习会话工作区不匹配");
    return this.store.bindLearningSession({ ...input, cwd: workspace.path });
  }
  #learningBinding(actor) {
    const binding = this.#binding(actor.sessionId, actor.actualCwd);
    if (binding.role !== "learning") throw new Error("仅学习会话可查询或保存学习建议");
    const batch = required(this.store.learning(binding.batchId), "学习批次"), source = required(this.store.source(batch.sourceId), "来源");
    if (source.workspaceId !== binding.workspaceId || batch.sessionId !== binding.sessionId) throw new Error("学习会话绑定已失效，请使用当前批次会话");
    return { binding, batch };
  }
  readLearningFromSession(actor, args = {}) {
    const { batch } = this.#learningBinding(actor), section = args.section ?? "batch";
    const configuration = {
      fields: learningConfigurationFields,
      examples: [
        { section: "configuration", target: "global", field: "learningGuidance" },
        { section: "configuration", target: "source", field: "attentionRules" },
        { section: "configuration", target: "source", field: "stageContexts.generation.context" },
        { section: "configuration", target: "source", field: "textMaterial", materialName: "资料名称" },
      ],
    };
    if (section === "batch") return { id: batch.id, sourceId: batch.sourceId, workspaceId: batch.workspaceId, caseCount: batch.caseCount, remainingCount: batch.remainingCount, scopeNote: "source 只修改当前来源；global 修改默认配置，新来源和仍继承该字段的现有来源跟随。授权、模型和凭据不允许通过学习修改。", source: { id: batch.sourceId, name: batch.sourceSnapshot.name, platform: batch.sourceSnapshot.platform, target: batch.sourceSnapshot.target, materials: (batch.sourceSnapshot.materials ?? []).map(({ name, kind }) => ({ name, kind })) }, ...configuration, proposal: batch.proposal ? { revision: batch.proposal.revision, hash: batch.proposal.hash, status: batch.proposal.status } : null };
    if (["configuration", "context", "materials"].includes(section)) {
      let text;
      if (section === "configuration") {
        if (args.target !== undefined && !Object.hasOwn(learningConfigurationFields, args.target)) throw new Error("配置查询目标无效；target 仅允许 source 或 global，global 为默认文字配置");
        if (args.field === undefined) return args.target === undefined ? configuration : { target: args.target, fields: learningConfigurationFields[args.target], examples: configuration.examples.filter(example => example.target === args.target) };
        if (!learningConfigurationFields[args.target]?.includes(args.field)) throw new Error(`配置查询字段或目标无效；source 允许 ${learningConfigurationFields.source.join(", ")}；global 允许 ${learningConfigurationFields.global.join(", ")}，例如 {section:"configuration",target:"global",field:"learningGuidance"}`);
        if (args.target === "global") text = batch.settingsSnapshot[args.field] ?? PARAMETERS[args.field]?.default ?? "";
        else if (args.field.startsWith("settings.")) text = batch.sourceSnapshot.settings?.[args.field.slice(9)] ?? batch.effectiveSettings?.[args.field.slice(9)] ?? PARAMETERS[args.field.slice(9)]?.default ?? "";
        else if (["context", "attentionRules"].includes(args.field)) text = batch.sourceSnapshot[args.field] ?? "";
        else if (/^stageContexts\.(decision|escalation|generation|supervision)\.context$/.test(args.field ?? "")) text = batch.sourceSnapshot.stageContexts?.[args.field.split(".")[1]]?.context ?? "";
        else if (args.field === "textMaterial") text = (batch.sourceSnapshot.materials ?? []).find(material => material.kind === "text" && material.name === args.materialName)?.text ?? "";
      } else {
        if (args.stage !== undefined && !["decision", "escalation", "generation", "supervision"].includes(args.stage)) throw new Error("资料阶段无效");
        const context = args.stage ? batch.preparedSource.resolvedStageContexts?.[args.stage] : { context: batch.preparedSource.context, materials: batch.preparedSource.resolvedMaterials };
        if (section === "context") text = context?.context ?? "";
        else if (!args.materialName) return { materials: (context?.materials ?? []).map(({ name, sha256 }) => ({ name, sha256 })) };
        else text = required((context?.materials ?? []).find(material => material.name === args.materialName), "冻结资料").text;
      }
      return this.#learningChunk(text, args);
    }
    if (section === "proposal") return batch.proposal;
    if (section === "cases") {
      const page = Number(args.page ?? 1), pageSize = Number(args.pageSize ?? 10);
      if (!Number.isSafeInteger(page) || page < 1 || ![10, 20, 50].includes(pageSize)) throw new Error("分页参数无效");
      return { items: batch.cases.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: batch.cases.length, pageCount: Math.max(1, Math.ceil(batch.cases.length / pageSize)) };
    }
    const entry = required(batch.cases.find(entry => entry.id === args.caseId), "批次案例");
    if (section === "case") return entry;
    if (section === "decision") {
      return this.#learningChunk(JSON.stringify(this.store.learningDecision(batch.id, entry.id)), args);
    }
    if (section === "comments") return this.store.comments(entry.itemId, entry.itemVersion, args);
    if (["body", "comment", "diff", "video-description"].includes(section)) return this.store.content(entry.itemId, { ...args, version: entry.itemVersion });
    throw new Error("学习查询区段无效");
  }
  #learningChunk(text, args) {
    const offset = Number(args.offset ?? 0), length = Number(args.length ?? 16000);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 32000) throw new Error("查询分块参数无效");
    const content = Array.from(text), next = offset + length;
    return { text: content.slice(offset, next).join(""), total: content.length, nextOffset: next < content.length ? next : null, complete: next >= content.length };
  }
  proposeLearningFromSession(actor, submission) {
    const { binding } = this.#learningBinding(actor);
    actor.assertWritable?.();
    return this.store.proposeLearning(binding, submission, actor.callId, nowISO(this.clock));
  }
  learningBackground(sessionId) {
    const binding = this.sessionBinding(sessionId);
    return binding?.role === "learning" ? this.readLearningFromSession({ sessionId }, { section: "batch" }) : null;
  }
  requireLearningSubmission(sessionId) { return required(this.store.learningSubmission(sessionId), "本批学习工具提交结果"); }
  async applyLearning(id, input) {
    const batch = required(this.store.learning(id), "学习批次"), proposal = required(batch.proposal, "学习建议");
    if (proposal.status === "applied") return this.store.applyLearning(id, input, {}, nowISO(this.clock));
    const current = required(this.store.source(batch.sourceId), "来源"), settings = this.store.settings();
    if (current.revision !== batch.baseSourceRevision || learningHash(settings) !== batch.baseSettingsHash) throw new Error("来源或全局配置已变化，请重新整理建议");
    const prepared = await this.#prepare(current);
    if (prepared.contextVersion !== batch.baseContextVersion) throw new Error("来源资料已变化，请重新整理建议");
    const next = applyLearningChanges(current, settings, proposal.changes), validSource = validateSource(next.source), validSettings = validateSettings(next.settings), nextPrepared = await this.#prepare(validSource, void 0, validSettings);
    const source = { ...validSource, contextVersion: nextPrepared.contextVersion };
    return this.store.applyLearning(id, input, { source, settings: validSettings }, nowISO(this.clock));
  }
  rejectLearning(id, input) { return this.store.rejectLearning(id, input, nowISO(this.clock)); }
  async markRead(id, version) {
    this.store.markRead(id, version);
  }
  async setHandling(id, handling) {
    if (!["none", "pending", "later", "done"].includes(handling)) throw new Error("处理状态无效");
    this.store.handling(id, handling);
  }
  #job(key, work, { busyMessage } = {}) {
    if (this.#closed) return Promise.reject(new Error("插件已停止"));
    if (this.#jobs.has(key)) return busyMessage ? Promise.reject(new Error(busyMessage)) : this.#jobs.get(key);
    const promise = Promise.resolve().then(work).finally(() => this.#jobs.delete(key));
    this.#jobs.set(key, promise);
    return promise;
  }
  refresh(sourceId, { organize = true, trigger = 'manual' } = {}) {
    if (!['manual', 'scheduled'].includes(trigger)) throw new Error('整理触发来源无效');
    return this.#job(`source:${sourceId}`, async () => {
      const source = required(this.store.source(sourceId), "来源"), connector = required(this.connectors[source.platform], "连接器"), now = nowISO(this.clock);
      let fetched = false, fetchError;
      if (!source.retryAt || this.clock() >= Date.parse(source.retryAt)) {
        const controller = new AbortController();
        this.#aborts.add(controller);
        try {
          const batch = await connector.fetch(source, { signal: controller.signal, readPreviousItem: remoteId => this.store.item(`${source.id}:${remoteId}`) });
          if (!batch.complete || !Array.isArray(batch.items)) throw new Error("抓取不完整，本轮不推进基线");
          const seen = /* @__PURE__ */ new Set();
          for (const entry of batch.items) {
            if (!entry.remoteId || !entry.title || !source.types.includes(entry.kind) || seen.has(entry.remoteId)) throw new Error("连接器返回内容无效或ID重复");
            seen.add(entry.remoteId);
          }
          this.store.applyFetch(sourceId, batch.items, batch.metadata, now, fingerprint);
          fetched = true;
        } catch (error) {
          fetchError = errorText(error);
          this.store.updateSource(sourceId, { fetchError, retryAt: new Date(this.clock() + (error.retryMs ?? 6e4)).toISOString() });
        } finally {
          this.#aborts.delete(controller);
        }
      } else fetchError = `等待连接器冷却至 ${source.retryAt}`;
      const organization = organize ? await this.#organize(sourceId, { scope: "changes", trigger }) : null;
      return { fetched, error: fetchError ?? null, organization };
    }, { busyMessage: "此来源正在刷新或整理，请完成后再试。" });
  }
  organize(sourceId, { scope = "changes", trigger = 'manual' } = {}) {
    if (!["changes", "history"].includes(scope)) throw new Error("整理范围无效");
    if (!['manual', 'scheduled'].includes(trigger)) throw new Error('整理触发来源无效');
    return this.#job(`source:${sourceId}`, () => this.#organize(sourceId, { scope, trigger }), { busyMessage: "此来源正在刷新或整理，请完成后再试。" });
  }
  #runRecord(source, item, prepared, kind = "automatic") {
    return {
      id: randomUUID(),
      sourceId: source.id,
      itemId: item.id,
      version: item.version,
      contextVersion: prepared?.contextVersion ?? source.contextVersion,
      sourceContextVersion: source.contextVersion,
      workspaceId: source.workspaceId,
      baseAnalysisRevision: item.analysisRevision ?? 0,
      inputSnapshot: { changedAt: item.changedAt, previous: item.previous },
      settingsSnapshot: valuesOf(resolveSettings(this.store.settings(), source)),
      status: kind === "human" ? "open" : "running",
      kind,
      startedAt: nowISO(this.clock),
      sourceSnapshot: prepared ?? null
    };
  }
  #newRun(source, item, prepared, kind = "automatic") {
    return this.store.createRun(this.#runRecord(source, item, prepared, kind));
  }
  async #organize(sourceId, { scope, trigger }) {
    const source = required(this.store.source(sourceId), "来源"), settings = valuesOf(resolveSettings(this.store.settings(), source));
    let prepared, preparationError;
    try {
      prepared = await this.#prepare(source);
    } catch (error) {
      preparationError = error;
    }
    const { total, refs, unanalysed, excludedClosed } = this.store.candidates(sourceId, scope, { includeClosed: source.platform !== "github" || settings.includeClosed }), summary = { sourceId, scope, trigger, contextVersion: prepared?.contextVersion ?? source.contextVersion, startedAt: nowISO(this.clock), total, excludedClosed, candidates: refs.length, completed: 0, failed: 0, skipped: 0, errors: [] };
    for (const ref of refs) {
      if (this.#closed) break;
      const item = required(this.store.item(ref.id), "内容项");
      if (item.version !== ref.version) continue;
      const triggerReason = { ...this.store.organizationReason(item.id, { initial: scope === 'history' && !item.analysis, checkRetry: true }), previousConclusion: item.kind === 'comment' ? conclusion(item.analysis) : null };
      const run = this.store.createRun({ ...this.#runRecord(source, item, prepared), trigger, triggerReason }), controller = new AbortController();
      this.#aborts.add(controller);
      try {
        if (preparationError) throw preparationError;
        const result = await this.executor.analyze({ runId: run.id, source: { ...prepared, replyAccountId: connectorIdentity(this.connectors[source.platform]) }, item, settings, signal: controller.signal, recordSession: async (role, sessionId) => {
          if (!this.store.sessionBinding(sessionId)) {
            const workspace = await this.workspaces.resolve(source.workspaceId);
            this.bindSession({ sessionId, runId: run.id, role, workspaceId: source.workspaceId, cwd: workspace.path });
          }
        }, recordDecision: async (decision) => this.store.updateRun(run.id, { decision }) });
        if (!result || typeof result.summary !== "string" || !Number.isInteger(result.importance) || result.importance < 0 || result.importance > 3) throw new Error("分析输出结构无效");
        let applied;
        if (result.committed) {
          const current = this.store.run(run.id);
          applied = current.resultAdopted === true;
        } else {
          if (result.draft) throw new Error("草稿必须通过真实会话工具保存");
          const latestSource = required(this.store.source(sourceId), "来源");
          const latestContext = await this.#prepare(latestSource);
          applied = latestContext.contextVersion === run.contextVersion ? this.store.adoptResult(run.id, result) : false;
          if (!applied) this.store.updateRun(run.id, { result, resultAdopted: false });
        }
        this.store.updateRun(run.id, { status: applied ? "completed" : "stale", processing: result.processing ?? null, finishedAt: nowISO(this.clock) });
        if (applied) {
          summary.completed++;
          if (result.draftId) await this.#autoPublish(result.draftId, controller.signal);
        }
      } catch (error) {
        summary.failed++;
        if (summary.errors.length < 50) summary.errors.push({ itemId: item.id, title: item.title, message: errorText(error), ...error.sessionFailure ? { sessionId: error.sessionFailure.sessionId } : {} });
        this.store.updateRun(run.id, { status: controller.signal.aborted ? "interrupted" : "failed", error: errorText(error), ...error.sessionFailure ? { failure: error.sessionFailure } : {}, finishedAt: nowISO(this.clock) });
      } finally {
        this.#aborts.delete(controller);
      }
    }
    summary.skipped = total - summary.completed - summary.failed;
    summary.finishedAt = nowISO(this.clock);
    summary.status = summary.failed ? summary.completed ? "partial" : "failed" : summary.completed ? "completed" : "skipped";
    summary.reason = null;
    if (!refs.length) summary.reason = excludedClosed ? `默认跳过了 ${excludedClosed} 个已关闭或已合并内容，保留原文与处理历史。可在 GitHub 整理范围中启用。` : !total ? "还没有已采集的内容，请先刷新来源。" : scope === "changes" && unanalysed ? "没有待整理的新变化。首次基线仅在手动整理已有数据时处理。" : "当前内容均已整理，无需重复运行。新指导用于后续内容。";
    else if (summary.completed + summary.failed < refs.length) summary.reason = "部分候选项在整理期间已变化或插件已停止，本轮跳过，可稍后重试。";
    summary.errorsTruncated = summary.failed > summary.errors.length;
    this.store.updateSource(sourceId, { organizedAt: summary.finishedAt, lastOrganization: summary });
    return summary;
  }
  async openConversation(itemId) {
    return this.#job(`conversation:${itemId}`, async () => {
      const item = required(this.store.item(itemId), "内容项"), source = required(this.store.source(item.sourceId), "来源"), prepared = await this.#prepare(source), existing = this.store.humanSession(itemId, source.workspaceId, item.version, prepared.contextVersion);
      if (existing) return { sessionId: existing.sessionId };
      const run = this.#newRun(source, item, prepared, "human");
      try {
        const sessionId = await this.executor.conversation({ runId: run.id, item, source: prepared, settings: manualSettings(this.store.settings(), source) });
        return { sessionId };
      } catch (error) {
        this.store.updateRun(run.id, { status: "failed", error: errorText(error) });
        throw error;
      }
    });
  }
  bindSession(input, options) {
    if (!roles.includes(input.role)) throw new Error("会话角色无效");
    const run = required(this.store.run(input.runId), "运行记录"), source = required(this.store.source(run.sourceId), "来源");
    if (input.workspaceId !== run.workspaceId || source.workspaceId !== input.workspaceId || typeof input.cwd !== "string" || !input.cwd) throw new Error("会话工作区不匹配");
    let extra = {};
    if (input.role === "supervisor") {
      if(!canDraft(this.store.header(run.itemId).kind))throw new Error("此内容类型不支持监督");
      const draft = required(this.store.draft(input.draftId), "草稿");
      if (draft.runId !== run.id) throw new Error("监督草稿归属不匹配");
      extra = { bodyHash: draft.bodyHash };
    }
    return this.store.bindSession({ ...input, ...extra },options);
  }
  analysisSessions(runId, role) {
    return analysisRoles.includes(role) ? this.store.analysisSessions(runId,role) : [];
  }
  analysisRoundContext(runId) {
    const run = required(this.store.run(runId),"运行记录"), item = required(this.store.header(run.itemId),"内容项");
    return { runId,version:run.version,contextVersion:run.contextVersion,analysisRevision:item.analysisRevision,analysis:item.analysis,history:this.store.runs(item.id,{pageSize:10}).items.filter(entry=>entry.id!==runId).map(entry=>({runId:entry.id,version:entry.version,status:entry.status,sessions:entry.sessions})) };
  }
  restoreSessionBinding(sessionId, runId, previous) { return this.store.restoreSessionBinding(sessionId,runId,previous); }
  sessionBinding(sessionId, actualCwd) {
    const binding = this.store.sessionBinding(String(sessionId));
    if (!binding || binding.legacy || (!binding.runId && binding.role !== "learning")) return null;
    if (actualCwd !== void 0 && resolve(actualCwd) !== resolve(binding.cwd)) return null;
    return binding;
  }
  #binding(sessionId, actualCwd, runId) {
    const binding = required(this.sessionBinding(sessionId, actualCwd),"受管会话绑定");
    if (runId !== undefined && binding.runId !== runId) throw new Error("会话分析轮次已变化，请重新读取当前轮次");
    return binding;
  }
  async readFromSession({ sessionId, actualCwd, runId: expectedRunId }, args = {}) {
    if (!this.store.sessionBinding(String(sessionId))) return this.#readFromWorkspace({ sessionId, actualCwd }, args);
    const binding = this.#binding(sessionId, actualCwd, expectedRunId);
    if (binding.role === "learning") throw new Error("学习会话请使用专用学习查询工具");
    const run = required(this.store.run(binding.runId), "运行记录"), itemId = args.itemId ?? run.itemId, section = args.section ?? "item";
    if (section === "items") return this.store.items(binding.sourceId, args);
    if (section === "analysis") {
      if (itemId !== run.itemId || args.version && args.version !== run.version) throw new Error("分析修订查询仅限本会话绑定内容");
      const item = required(this.store.header(run.itemId), "内容项"), source = required(this.store.source(run.sourceId), "来源");
      if (source.workspaceId !== binding.workspaceId) throw new Error("来源工作区已变化，请从当前内容新开会话");
      const prepared = await this.#prepare(source);
      this.#assertWorkspaceSource(source);
      this.store.assertSessionBinding(binding);
      return { itemId: item.id, version: item.version, contextVersion: prepared.contextVersion, analysisRevision: item.analysisRevision, analysis: item.analysis, sessionVersion: run.version, sessionContextVersion: run.contextVersion };
    }
    const item = required(this.store.header(itemId, args.version ?? (itemId === run.itemId ? run.version : void 0)), "内容项");
    if (item.sourceId !== binding.sourceId) throw new Error("只能查询此会话来源的内容");
    const version = item.version;
    if (section === "item") return item;
    if (section === "comments") return this.store.comments(itemId, version, args);
    if (["body", "comment", "diff", "video-description"].includes(section)) return this.store.content(itemId, { ...args, version });
    if (["context", "materials"].includes(section)) {
      const source = run.sourceSnapshot;
      if (!source) return { available: false, reason: "旧运行未保存来源快照" };
      const stage = binding.role === "supervisor" ? "supervision" : binding.role === "decision-escalation" ? "escalation" : "generation";
      const input = assembleInput(source, null, { stage });
      return { version: run.contextVersion, ...input.blocks.find((block) => block.key === section) };
    }
    throw new Error("查询区段无效");
  }
  async submitFromSession({ sessionId, callId, actualCwd, assertWritable, runId: expectedRunId }, submission) {
    if (!this.store.sessionBinding(String(sessionId))) return this.#submitFromWorkspace({ sessionId, callId, actualCwd, assertWritable }, submission);
    const binding = this.#binding(sessionId, actualCwd, expectedRunId);
    if (binding.role === "learning") throw new Error("学习会话不能保存内容稿件或分析结果");
    const run = required(this.store.run(binding.runId), "运行记录");
    if (!submission || typeof submission.operationKey !== "string" || !submission.operationKey.trim() || submission.operationKey.length > 160) throw new Error("提交需要有效操作键");
    const allowed = binding.role === "supervisor" ? "supervision" : binding.role === "decision-escalation" ? "decision" : binding.role === "human" ? "draft" : "analysis";
    if (submission.kind !== allowed) throw new Error("会话角色无权提交此结果");
    const kind=this.store.header(run.itemId).kind;
    if(!canDraft(kind)&&(submission.kind==='draft'||submission.kind==='supervision'||submission.draftBody!=null))throw new Error('此内容类型不支持拟稿或监督');
    if (submission.kind === "analysis") {
      validateAnalysis(submission.analysis);
      if (submission.draftBody !== void 0 && submission.draftBody !== null && typeof submission.draftBody !== "string") throw new Error("草稿正文无效");
    }
    if (submission.kind === "draft" && (typeof submission.body !== "string" || !submission.body.trim())) throw new Error("草稿正文不能为空");
    if (submission.kind === "decision" && (!["ignore", "draft", "human"].includes(submission.choice) || typeof submission.certain !== "boolean" || typeof submission.reason !== "string")) throw new Error("升级判断格式无效");
    if (submission.kind === "decision" && submission.importance !== undefined && (!Number.isInteger(submission.importance) || submission.importance < 0 || submission.importance > 3)) throw new Error("升级重要程度无效");
    if (submission.kind === "supervision" && (typeof submission.approved !== "boolean" || typeof submission.reason !== "string" || !submission.reason.trim())) throw new Error("监督结果无效");
    if (submission.replyToCommentId !== undefined) {
      const item = this.store.item(run.itemId);
      if (item.kind !== "comment") throw new Error("仅评论可指定回复目标");
      replyTarget(item, submission.replyToCommentId);
    }
    if (submission.kind === "analysis" && submission.draftBody?.trim() && this.store.source(run.sourceId)?.autoReply === true && this.store.item(run.itemId)?.kind === "comment" && !submission.replyToCommentId) throw new Error("自动回复草稿需要 replyToCommentId 指定目标评论");
    if (JSON.stringify(submission).length > 2e5) throw new Error("提交结果过大");
    assertWritable?.();
    const replay = this.store.replaySubmission(binding.sessionId, submission,binding.runId);
    if (replay) return replay;
    const source = required(this.store.source(run.sourceId), "来源");
    if (source.workspaceId !== binding.workspaceId) throw new Error("来源工作区已变化，请从当前内容新开会话");
    const prepared = await this.#prepare(source);
    assertWritable?.();
    const receipt = this.store.submit(binding, callId, submission, prepared.contextVersion, nowISO(this.clock));
    return receipt;
  }
  async reviseAnalysisFromSession({ sessionId, callId, actualCwd, assertWritable, runId: expectedRunId }, input) {
    const binding = this.#binding(sessionId, actualCwd, expectedRunId);
    if (!analysisRoles.includes(binding.role)) throw new Error("此会话角色无权修订分析");
    const allowed = ["operationKey", "version", "contextVersion", "expectedAnalysisRevision", "analysis", "reason", "evidenceRefs"];
    if (!input || Object.keys(input).some(key => !allowed.includes(key))) throw new Error("分析修订参数无效");
    for (const key of ["operationKey", "reason"]) if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`分析修订需要有效 ${key}`);
    if (input.operationKey.length > 160 || JSON.stringify(input).length > 2e5) throw new Error("修订结果过大或操作键过长");
    if (input.evidenceRefs !== undefined && (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 20 || input.evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 1000))) throw new Error("修订证据引用无效");
    validateAnalysis(input.analysis);
    assertWritable?.();
    const original = required(this.store.run(binding.runId), "运行记录");
    const submission = { ...input, kind: "analysis-revision" }, replay = this.store.replaySubmission(binding.sessionId, submission,binding.runId);
    if (replay) return replay;
    let source, prepared;
    do {
      source = required(this.store.source(binding.sourceId), "来源");
      prepared = await this.#prepare(source);
    } while (source.revision !== this.store.source(binding.sourceId)?.revision);
    const item = required(this.store.header(binding.itemId), "内容项"), at = nowISO(this.clock);
    const run = { ...this.#runRecord(source, item, prepared, "analysis-revision"), originSession: { sessionId: binding.sessionId, role: binding.role, workspaceId: binding.workspaceId, at }, revision: { originRunId: original.id, reason: input.reason, evidenceRefs: input.evidenceRefs ?? [] } };
    assertWritable?.();
    return this.store.reviseAnalysis(binding, callId, submission, run, at);
  }
  async #workspaceScope({ sessionId, actualCwd }) {
    if (this.store.sessionBinding(String(sessionId))) throw new Error("受管会话必须使用原角色绑定");
    const cwd = typeof actualCwd === "string" ? await realpath(actualCwd).catch(() => null) : null;
    if (!cwd) return new Set();
    const matches = [];
    for (const candidate of await this.workspaces.list?.() ?? []) {
      if (candidate.status && candidate.status !== "ok") continue;
      const path = await realpath(candidate.path).catch(() => null);
      if (path === cwd) matches.push({ ...candidate, path });
    }
    return new Set(matches.map(workspace => workspace.id));
  }
  async #workspaceSource(actor, sourceId) {
    if (typeof sourceId !== "string" || !sourceId) throw new Error("请指定 sourceId，先用 section=sources 查询本工作区来源");
    const workspaceIds = await this.#workspaceScope(actor);
    const source = this.store.source(sourceId);
    if (!source || !workspaceIds.has(source.workspaceId)) throw new Error("只能查询或存稿当前已有工作区绑定来源的内容");
    const workspace = await this.workspaces.resolve(source.workspaceId);
    if (await realpath(workspace.path) !== await realpath(actor.actualCwd)) throw new Error("来源工作区已变化");
    this.#assertWorkspaceSource(source);
    return { source, workspace };
  }
  #assertWorkspaceSource(source) {
    const current = this.store.source(source.id);
    if (!current || current.workspaceId !== source.workspaceId || current.revision !== source.revision) throw new Error("来源工作区或资料已变化，请重新查询");
  }
  async #readFromWorkspace(actor, args) {
    const section = args.section ?? "sources";
    if (section === "sources") {
      const workspaceIds = await this.#workspaceScope(actor);
      const sources = this.store.sources().filter(source => workspaceIds.has(source.workspaceId));
      const page = Number(args.page ?? 1), pageSize = Number(args.pageSize ?? 10);
      if (!Number.isSafeInteger(page) || page < 1 || ![10, 20, 50].includes(pageSize)) throw new Error("分页参数无效");
      return { sources: sources.slice((page - 1) * pageSize, page * pageSize).map(({ id, name, platform, target, workspaceId }) => ({ id, name, platform, target, workspaceId })), page, pageSize, total: sources.length, pageCount: Math.max(1, Math.ceil(sources.length / pageSize)) };
    }
    const item = args.itemId ? required(this.store.header(args.itemId, args.version), "内容项") : null;
    const { source, workspace } = await this.#workspaceSource(actor, item?.sourceId ?? args.sourceId);
    this.#assertWorkspaceSource(source);
    if (args.sourceId && args.sourceId !== source.id) throw new Error("内容项与来源不匹配");
    if (section === "items") return this.store.items(source.id, args);
    if (!item && !["context", "materials"].includes(section)) throw new Error("请指定 itemId，先用 section=items 查询本来源内容 ID");
    if (section === "item" || ["context", "materials"].includes(section)) {
      const prepared = await this.#prepare(source, workspace);
      this.#assertWorkspaceSource(source);
      if (section === "item") return { ...item, contextVersion: prepared.contextVersion };
      const input = assembleInput(prepared, null, { stage: "generation" });
      return { version: prepared.contextVersion, contextVersion: prepared.contextVersion, ...input.blocks.find(block => block.key === section) };
    }
    if (section === "comments") return this.store.comments(item.id, item.version, args);
    if (["body", "comment", "diff", "video-description"].includes(section)) return this.store.content(item.id, { ...args, version: item.version });
    throw new Error("查询区段无效");
  }
  async #submitFromWorkspace(actor, submission) {
    if (submission?.kind !== "draft") throw new Error("普通工作区会话仅可保存草稿");
    for (const key of ["operationKey", "itemId", "version", "contextVersion", "body"]) if (typeof submission[key] !== "string" || !submission[key].trim()) throw new Error(`存稿需要有效 ${key}`);
    if (submission.operationKey.length > 160 || JSON.stringify(submission).length > 2e5) throw new Error("提交结果过大或操作键过长");
    actor.assertWritable?.();
    const currentItem = required(this.store.header(submission.itemId), "内容项");
    if(!canDraft(currentItem.kind))throw new Error("此内容类型不支持拟稿");
    const { source, workspace } = await this.#workspaceSource(actor, currentItem.sourceId);
    this.#assertWorkspaceSource(source);
    const replay = this.store.replaySubmission(String(actor.sessionId), submission);
    if (replay) return replay;
    const prepared = await this.#prepare(source, workspace);
    this.#assertWorkspaceSource(source);
    if (currentItem.version !== submission.version || prepared.contextVersion !== submission.contextVersion) throw new Error("内容或来源资料已变化，请重新读取后存稿");
    const item = required(this.store.item(currentItem.id), "内容项");
    if (item.version !== submission.version) throw new Error("内容已变化，请重新读取后存稿");
    const run = { ...this.#runRecord(source, item, prepared, "human"), originSession: { sessionId: String(actor.sessionId), role: "human", workspaceId: source.workspaceId, at: nowISO(this.clock) } };
    actor.assertWritable?.();
    return this.store.submitWorkspaceDraft(run, { sessionId: String(actor.sessionId), workspaceId: source.workspaceId, role: "human", runId: run.id }, actor.callId, submission, prepared.contextVersion, nowISO(this.clock));
  }
  #runItem(run) {
    const item = this.store.item(run.itemId, run.version);
    return item && run.inputSnapshot ? { ...item, changedAt: run.inputSnapshot.changedAt, previous: run.inputSnapshot.previous } : item;
  }
  sessionBackground(sessionId) {
    const binding = this.sessionBinding(String(sessionId));
    if (!binding || binding.role !== "human") return null;
    const run = this.store.run(binding.runId);
    if (!run?.sourceSnapshot) return null;
    const item = this.#runItem(run);
    if (!item) return null;
    const settings = run.settingsSnapshot ?? valuesOf(resolveSettings(this.store.settings(), run.sourceSnapshot));
    return { input: assembleInput(run.sourceSnapshot, item, { language: settings.language, stage: "generation" }) };
  }
  endSession(sessionId) {
    this.store.endSession(String(sessionId));
  }
  requireSubmission(sessionId, runId) {
    return required(this.store.receipt(String(sessionId),runId), "本阶段工具提交结果");
  }
  async superviseDraft(id, { bodyHash } = {}) {
    return this.#job(`supervise:${id}`, async () => {
      const draft = required(this.store.draft(id), "草稿");
      if(!canDraft(this.store.header(draft.itemId).kind))throw new Error("此内容类型不支持监督");
      if (draft.bodyHash !== bodyHash || !["pending-supervision", "blocked"].includes(draft.status)) throw new Error("草稿已变化或不等待监督");
      const item = required(this.#runItem(required(this.store.run(draft.runId), "运行记录")), "内容项"), source = required(this.store.source(draft.sourceId), "来源"), prepared = await this.#prepare(source);
      if (prepared.contextVersion !== draft.contextVersion || this.store.header(item.id).version !== draft.version) {
        this.store.updateDraft(id, { status: "stale" });
        throw new Error("草稿输入已变化，请重新整理");
      }
      if (!this.executor.supervise) throw new Error("独立监督执行器不可用");
      const controller = new AbortController();
      this.#aborts.add(controller);
      try {
        return await this.executor.supervise({ runId: draft.runId, draft, source: prepared, item, settings: valuesOf(resolveSettings(this.store.settings(), source)), signal: controller.signal });
      } catch (error) {
        this.store.updateDraft(id, { error: errorText(error) });
        throw error;
      } finally {
        this.#aborts.delete(controller);
      }
    });
  }
  async dismissDraft(id) {
    const draft = required(this.store.draft(id), "草稿");
    if (!["pending-supervision", "ready", "blocked", "stale"].includes(draft.status)) throw new Error("当前状态不能暂不发布");
    this.store.updateDraft(id, { status: "dismissed" });
  }
  async #autoPublish(id, signal) {
    const draft = this.store.draft(id);
    if (!draft || draft.status !== "ready") return;
    const item = this.store.item(draft.itemId), source = this.store.source(draft.sourceId), run = this.store.run(draft.runId);
    const problem = automaticReplyProblem({ source, item, draft, run, ownId: this.connectors[source.platform]?.status?.().identity?.id });
    if (problem) { this.store.updateDraft(id, { automaticError: problem }); return; }
    try { await this.#publish(id, { version: draft.version, bodyHash: draft.bodyHash }, { automatic: true, signal }); }
    catch (error) { this.store.updateDraft(id, { automaticError: errorText(error) }); }
  }
  approveAndPublish(id, expected) { return this.#publish(id, expected); }
  async #publish(id, { version, bodyHash }, { automatic = false, signal } = {}) {
    return this.#job(`publish:${id}`, async () => {
      const draft = required(this.store.draft(id), "草稿"), item = required(this.store.item(draft.itemId), "内容项"), source = required(this.store.source(draft.sourceId), "来源"), prepared = await this.#prepare(source);
      if(!canDraft(item.kind))throw new Error("此内容类型不支持发布");
      if (draft.contextVersion !== prepared.contextVersion) throw new Error("来源资料已变化，请重新整理并审核");
      if (draft.status !== "ready" || !draft.supervision?.approved) throw new Error("此草稿未通过监督或不处于待审核状态");
      if (this.store.hasUncertain(item.id, id)) throw new Error("此内容项有发送结果尚未确认，请先核实远端，避免重复发布");
      if (item.version !== draft.version || version !== draft.version || bodyHash !== draft.bodyHash) throw new Error("内容或草稿已变化，请重新审核");
      const connector = this.connectors[source.platform];
      if (!connector?.publish || connector.status?.().canPublish !== true) throw new Error("尚未连接可发布的已授权账号");
      const remote = await connector.getItem(source, item);
      if (!remote || fingerprint({ title: remote.title, body: remote.body, payload: remote.payload }) !== item.version) {
        this.store.updateDraft(id, { status: "stale" });
        throw new Error("原始内容有新变化，请刷新并重新分析后审核");
      }
      signal?.throwIfAborted();
      const latestSource = required(this.store.source(source.id), "来源"), latestPrepared = await this.#prepare(latestSource);
      if (latestPrepared.contextVersion !== prepared.contextVersion || latestSource.enabled === false) throw new Error("来源规则或授权已变化，请重新审核");
      if (automatic) {
        const problem = automaticReplyProblem({ source: latestSource, item, draft, run: this.store.run(draft.runId), ownId: connector.status?.().identity?.id });
        if (problem) throw new Error(problem);
      }
      this.store.claimPublication(id, { version, bodyHash, contextVersion: prepared.contextVersion, automatic }, nowISO(this.clock));
      try {
        const beforeSend = () => {
          signal?.throwIfAborted();
          const finalSource = required(this.store.source(source.id), "来源"), finalItem = required(this.store.item(item.id), "内容项"), finalDraft = required(this.store.draft(id), "草稿");
          if (finalSource.revision !== latestSource.revision || !finalSource.enabled || finalItem.version !== item.version || finalItem.analysisRevision !== item.analysisRevision || finalDraft.status !== "sending" || finalDraft.bodyHash !== bodyHash) throw new Error("排队期间来源授权、内容或分析已变化，尚未发送");
          if (automatic) {
            const problem = automaticReplyProblem({ source: finalSource, item: finalItem, draft: finalDraft, run: this.store.run(draft.runId), ownId: connectorIdentity(connector) });
            if (problem) throw new Error(problem);
          }
        };
        const receipt = await connector.publish(source, item, draft, { actionId: id, signal, beforeSend });
        if (!receipt?.remoteId) throw new Error("发布缺少可核验回执");
        this.store.finishPublication(id, { status: "sent", receipt, sentAt: nowISO(this.clock) }, "publication.sent", { remoteId: receipt.remoteId }, nowISO(this.clock));
        return receipt;
      } catch (error) {
        this.store.finishPublication(id, { status: error.definitelyNotSent ? "ready" : "unknown", error: errorText(error) }, "publication.uncertain", {}, nowISO(this.clock));
        throw error;
      }
    });
  }
  startScheduler() {
    this.#timer = setInterval(() => void this.tick().catch(() => {
    }), 6e4);
    this.#timer.unref?.();
  }
  async tick() {
    for (const source of this.store.sources().filter((s) => s.enabled)) {
      const settings = valuesOf(resolveSettings(this.store.settings(), source));
      if (source.retryAt && Date.parse(source.retryAt) > this.clock()) continue;
      const organize = !source.organizedAt || this.clock() - Date.parse(source.organizedAt) >= settings.organizeHours * 36e5;
      if (!source.fetchedAt || this.clock() - Date.parse(source.fetchedAt) >= settings.fetchHours * 36e5) await this.refresh(source.id, { organize, trigger: 'scheduled' });
      else if (organize) await this.organize(source.id, { scope: "changes", trigger: 'scheduled' });
    }
  }
  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const controller of this.#aborts) controller.abort({kind:'owner-disposed'});
    await Promise.allSettled(this.#jobs.values());
    await this.imageCache?.close();
    await this.store.close();
  }
}
export {
  ConsoleService,
  fingerprint
};
