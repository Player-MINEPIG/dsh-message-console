import { mkdir, open, readFile, unlink, rmdir, copyFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { learningHash, proposalChanges } from "./learning.js";
import { itemPriority, currentAnalysis, needsHandling } from "./dashboard.js";
const json = (value) => JSON.stringify(value ?? null);
const parse = (value) => value ? JSON.parse(value) : null;
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const requestHash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const active = ["pending-supervision", "ready", "blocked", "stale", "sending", "unknown"];
const updatedTimeSQL = "coalesce(strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(i.data,'$.updatedAt')),strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(v.payload,'$.updatedAt')),strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(v.payload,'$.publishedAt')),strftime('%Y-%m-%dT%H:%M:%fZ',i.changed_at),i.changed_at)";
const remoteTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const required = (value, label) => {
  if (!value) throw new Error(`${label}不存在`);
  return value;
};
function pageQuery(input = {}) {
  const page = Number(input.page ?? 1), pageSize = Number(input.pageSize ?? 10);
  if (!Number.isSafeInteger(page) || page < 1 || ![10, 20, 50].includes(pageSize)) throw new Error("分页参数无效");
  const filter = input.filter ?? "all", query = String(input.q ?? input.query ?? "").trim().toLowerCase();
  if (!["all", "unread", "handling"].includes(filter) || query.length > 200) throw new Error("筛选参数无效");
  return { page, pageSize, filter, query };
}
class Store {
  #db;
  #lock;
  constructor(directory) {
    this.directory = directory;
  }
  #get(sql, ...args) {
    return this.#db.prepare(sql).get(...args);
  }
  #all(sql, ...args) {
    return this.#db.prepare(sql).all(...args);
  }
  #run(sql, ...args) {
    return this.#db.prepare(sql).run(...args);
  }
  #transaction(work) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  revision() {
    return Number(this.#get("SELECT value FROM meta WHERE key='revision'").value);
  }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    const lockPath = join(this.directory, "owner.lock");
    try {
      this.#lock = await open(lockPath, "wx", 384);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const recovery = join(this.directory, "lock-recovery");
      await mkdir(recovery).catch(() => {
        throw new Error("另一实例正在检查数据目录锁，请稍后重试。");
      });
      try {
        let owner;
        try {
          owner = Number((await readFile(lockPath, "utf8")).trim());
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (owner !== void 0) {
          if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("数据锁不完整；请确认没有运行中的实例后再清理 owner.lock。");
          try {
            process.kill(owner, 0);
            throw new Error("数据目录已有运行中的实例");
          } catch (e) {
            if (e.code !== "ESRCH") throw e;
          }
          await unlink(lockPath);
        }
        this.#lock = await open(lockPath, "wx", 384);
      } finally {
        await rmdir(recovery);
      }
    }
    await this.#lock.writeFile(`${process.pid}
`);
    await this.#lock.sync();
    try {
      const filename = join(this.directory, "console.sqlite");
      this.#db = new DatabaseSync(filename, { timeout: 5e3 });
      this.#db.function("dmc_lower", { deterministic: true }, (value) => String(value ?? "").toLowerCase());
      await chmod(filename, 384);
      const schemaVersion = this.#get("PRAGMA user_version").user_version;
      if (![0, 2, 3, 4, 5].includes(schemaVersion)) throw new Error("不支持此数据库版本");
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT OR IGNORE INTO meta VALUES('revision','0');
        INSERT OR IGNORE INTO meta VALUES('session_seq','0');
        CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,data TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,unread INTEGER NOT NULL DEFAULT 0,handling INTEGER NOT NULL DEFAULT 0,analyzed INTEGER NOT NULL DEFAULT 0,unorganized INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),remote_id TEXT NOT NULL,kind TEXT NOT NULL,version TEXT NOT NULL,previous_version TEXT,read_version TEXT,analyzed_version TEXT,context_version TEXT,handling TEXT NOT NULL,changed_at TEXT NOT NULL,analysis TEXT,analysis_revision INTEGER NOT NULL DEFAULT 0,priority INTEGER NOT NULL DEFAULT 0,needs_handling INTEGER NOT NULL DEFAULT 0,unread INTEGER NOT NULL DEFAULT 0,analyzed INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,UNIQUE(source_id,remote_id));
        CREATE INDEX IF NOT EXISTS item_order ON items(source_id,priority DESC,changed_at DESC,id);
        CREATE INDEX IF NOT EXISTS item_urgent ON items(source_id,(priority%10));
        CREATE INDEX IF NOT EXISTS item_summaries ON items(source_id,priority DESC,changed_at DESC,id) WHERE unread=1 AND analyzed=1 AND coalesce(json_extract(analysis,'$.processing'),'') NOT IN ('context-incomplete','decision-only') AND coalesce(json_extract(analysis,'$.summary'),'')<>'';
        CREATE INDEX IF NOT EXISTS item_updated ON items(source_id,changed_at DESC);
        CREATE INDEX IF NOT EXISTS item_unread ON items(source_id,unread,priority DESC,changed_at DESC,id);
        CREATE INDEX IF NOT EXISTS item_handling ON items(source_id,needs_handling,priority DESC,changed_at DESC,id);
        CREATE TABLE IF NOT EXISTS item_versions(item_id TEXT NOT NULL REFERENCES items(id),version TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,url TEXT,payload TEXT,changed_at TEXT,complete INTEGER NOT NULL,data TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(item_id,version));
        CREATE TABLE IF NOT EXISTS comments(item_id TEXT NOT NULL,version TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,author TEXT NOT NULL,body TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(item_id,version,id),FOREIGN KEY(item_id,version) REFERENCES item_versions(item_id,version));
        CREATE INDEX IF NOT EXISTS comment_order ON comments(item_id,version,ordinal,id);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),status TEXT NOT NULL,started_at TEXT NOT NULL,data TEXT NOT NULL,decision TEXT,source_snapshot TEXT);
        CREATE INDEX IF NOT EXISTS run_status ON runs(status);
        CREATE INDEX IF NOT EXISTS run_order ON runs(item_id,started_at DESC,id);
        CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),source_id TEXT NOT NULL REFERENCES sources(id),status TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS draft_item_status ON drafts(item_id,status,created_at DESC,id);
        CREATE INDEX IF NOT EXISTS draft_source_status ON drafts(source_id,status);
        CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY,run_id TEXT REFERENCES runs(id),item_id TEXT,source_id TEXT,role TEXT NOT NULL,workspace_id TEXT,cwd TEXT,data TEXT NOT NULL,eligible INTEGER NOT NULL,seq INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS session_changes ON sessions(seq);
        CREATE INDEX IF NOT EXISTS session_item ON sessions(item_id,role);
        CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(session_id,operation_key));
        CREATE TABLE IF NOT EXISTS feedback_versions(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),source_id TEXT NOT NULL REFERENCES sources(id),revision INTEGER NOT NULL,text TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(item_id,revision));
        CREATE INDEX IF NOT EXISTS feedback_source ON feedback_versions(source_id,item_id,revision DESC);
        CREATE TABLE IF NOT EXISTS learning_batches(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),status TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS learning_source ON learning_batches(source_id,created_at DESC,id);
        CREATE TABLE IF NOT EXISTS learning_cases(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES learning_batches(id),feedback_id TEXT NOT NULL REFERENCES feedback_versions(id),data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS learning_case_batch ON learning_cases(batch_id,id);
        CREATE INDEX IF NOT EXISTS learning_case_feedback ON learning_cases(feedback_id,batch_id);
        CREATE TABLE IF NOT EXISTS learning_proposals(batch_id TEXT NOT NULL REFERENCES learning_batches(id),revision INTEGER NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(batch_id,revision));
        CREATE TABLE IF NOT EXISTS learned_feedback(feedback_id TEXT PRIMARY KEY REFERENCES feedback_versions(id),batch_id TEXT NOT NULL REFERENCES learning_batches(id),proposal_revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS learning_receipts(session_id TEXT NOT NULL,operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,operation_key));
        CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at TEXT,event TEXT,data TEXT NOT NULL);
        `);
      this.#transaction(() => {
        if (!this.#all("PRAGMA table_info(item_versions)").some((column) => column.name === "metadata")) {
          this.#db.exec("ALTER TABLE item_versions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
          this.#run(`UPDATE item_versions SET metadata=json_object('contextComplete',json_extract(payload,'$.contextComplete'),'contextLimit',json_extract(payload,'$.contextLimit'),'diffLength',coalesce(length(json_extract(payload,'$.diff')),0),'video',CASE WHEN json_type(payload,'$.video')='object' THEN json_object('title',json_extract(payload,'$.video.title'),'owner',json_extract(payload,'$.video.owner'),'descriptionLength',coalesce(length(json_extract(payload,'$.video.description')),0)) ELSE NULL END)`);
        }
        if(schemaVersion===3)this.#run(`UPDATE item_versions SET metadata=CASE WHEN json_type(metadata,'$.video')='object' THEN json_set(metadata,'$.diffLength',coalesce(length(json_extract(payload,'$.diff')),0),'$.video.descriptionLength',coalesce(length(json_extract(payload,'$.video.description')),0)) ELSE json_set(metadata,'$.diffLength',coalesce(length(json_extract(payload,'$.diff')),0)) END`);
        for (const column of ["attention_version", "acknowledged_attention_version"]) if (!this.#all("PRAGMA table_info(items)").some(entry => entry.name === column)) this.#db.exec(`ALTER TABLE items ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${column === "attention_version" ? 1 : 0}`);
        this.#db.exec("PRAGMA user_version=5");
      });
      if (!this.#get("SELECT value FROM meta WHERE key='initialized'")) {
        let legacy;
        try {
          legacy = await readFile(join(this.directory, "state.json"), "utf8");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (legacy !== void 0) {
          const state = JSON.parse(legacy);
          if (state.version !== 1) throw new Error("不支持此数据版本");
          for (const key of ["settings", "sources", "items", "drafts", "runs"]) if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) throw new Error("旧数据结构无效");
          await copyFile(join(this.directory, "state.json"), join(this.directory, "state.pre-sqlite.json"));
          await chmod(join(this.directory, "state.pre-sqlite.json"), 384);
          this.#transaction(() => this.#importLegacy(state, legacy));
        } else this.#transaction(() => {
          this.#run("INSERT INTO meta VALUES('settings','{}')");
          this.#run("INSERT INTO meta VALUES('initialized','1')");
        });
      }
      this.#transaction(() => {
        let restored = 0;
        for (const row of this.#all('SELECT id,version,analysis FROM items WHERE analyzed_version IS NULL AND analysis IS NOT NULL')) {
          const evidence = this.#all("SELECT json_extract(data,'$.result') result FROM runs WHERE item_id=? AND json_extract(data,'$.resultAdopted')=1 AND json_extract(data,'$.version')=? ORDER BY started_at DESC,id", row.id, row.version).some(run => canonical(parse(run.result)) === canonical(parse(row.analysis)));
          if (!evidence) continue;
          this.#run('UPDATE items SET analyzed_version=version WHERE id=?', row.id);
          this.#project(row.id);
          restored++;
        }
        if (restored) this.#audit('analysis.restored', { count: restored });
        for (const row of this.#all("SELECT id,data FROM learning_batches WHERE status IN ('queued','running')")) this.#writeLearning({ ...parse(row.data), status: "interrupted", error: "进程中断，可重试本批评价整理。" });
        for (const row of this.#all("SELECT id FROM drafts WHERE status='sending'")) this.#updateDraft(row.id, { status: "unknown", error: "上次发送被中断，需核实远端结果。" });
        for (const row of this.#all("SELECT id FROM runs WHERE status='running'")) {
          const run = this.run(row.id);
          this.#writeRun({ ...run, status: "interrupted", error: "进程中断；已发生的会话工作可追溯。" });
          this.#eligibleRun(row.id);
        }
      });
      for (const suffix of ["-wal", "-shm"]) await chmod(filename + suffix, 384).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  #importLegacy(state, raw) {
    this.#run("INSERT INTO meta VALUES(?,?)", "settings", json(state.settings));
    for (const source of Object.values(state.sources)) this.#run("INSERT INTO sources(id,data) VALUES(?,?)", source.id, json(source));
    for (const item of Object.values(state.items)) {
      this.#writeItem({ ...item, sessions: void 0 });
      this.#countNew(item.sourceId);
      this.#version(item, true);
      if (item.previous) this.#version({ ...item.previous, id: item.id, url: null, payload: null, changedAt: null }, false);
    }
    for (const run of Object.values(state.runs)) this.#writeRun(run);
    for (const draft of Object.values(state.drafts)) this.#writeDraft(draft, false);
    const links = /* @__PURE__ */ new Map();
    for (const item of Object.values(state.items)) for (const link of item.sessions ?? []) links.set(link.sessionId, { ...link, itemId: item.id, sourceId: item.sourceId });
    for (const run of Object.values(state.runs)) for (const link of run.sessions ?? []) links.set(link.sessionId, { ...links.get(link.sessionId), ...link, runId: run.id, itemId: run.itemId, sourceId: state.items[run.itemId]?.sourceId });
    for (const link of links.values()) this.#run("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)", link.sessionId, link.runId ?? null, link.itemId ?? null, link.sourceId ?? null, link.role ?? "human", link.workspaceId ?? null, null, json({ ...link, legacy: true }), state.runs[link.runId]?.status === "running" ? 0 : 1, this.#sessionSequence());
    for (const event of state.audit ?? []) this.#run("INSERT INTO audit VALUES(?,?,?,?)", event.id, event.at ?? null, event.event ?? null, json(event));
    for (const row of this.#all("SELECT id FROM items")) this.#project(row.id);
    this.#run("INSERT INTO meta VALUES('legacyHash',?)", createHash("sha256").update(raw).digest("hex"));
    this.#run("INSERT INTO meta VALUES('legacyExtras',?)", json(Object.fromEntries(Object.entries(state).filter(([key]) => !["version", "settings", "sources", "items", "drafts", "runs", "audit"].includes(key)))));
    const checked = this.#get("PRAGMA quick_check");
    if (Object.values(checked)[0] !== "ok" || this.#all("PRAGMA foreign_key_check").length) throw new Error("迁移完整性检查失败");
    for (const [table, key] of [["sources", "sources"], ["items", "items"], ["drafts", "drafts"], ["runs", "runs"]]) if (this.#get(`SELECT count(*) n FROM ${table}`).n !== Object.keys(state[key]).length) throw new Error("迁移计数不一致");
    const equal = (actual, expected, label) => {
      if (canonical(actual) !== canonical(expected)) throw new Error(`迁移字段校验失败：${label}`);
    };
    for (const source of Object.values(state.sources)) equal(this.source(source.id), source, `source ${source.id}`);
    for (const old of Object.values(state.items)) {
      const actual = this.item(old.id);
      for (const [key, value] of Object.entries(old)) {
        if (key === "sessions") continue;
        if (key === "previous" && value) {
          for (const field of ["title", "body", "version"]) if (value[field] !== void 0) equal(actual.previous?.[field], value[field], `${old.id}.previous.${field}`);
        } else equal(actual[key], value, `${old.id}.${key}`);
      }
      for (const link of old.sessions ?? []) {
        const stored = actual.sessions.find((s) => s.sessionId === link.sessionId);
        for (const [key, value] of Object.entries(link)) equal(stored?.[key], value, `${old.id}.session.${key}`);
      }
    }
    for (const old of Object.values(state.runs)) {
      const actual = this.run(old.id);
      for (const [key, value] of Object.entries(old)) if (key !== "sessions") equal(actual[key], value, `${old.id}.${key}`);
    }
    for (const old of Object.values(state.drafts)) {
      const actual = this.draft(old.id);
      for (const [key, value] of Object.entries(old)) equal(actual[key], value, `${old.id}.${key}`);
    }
    for (const event of state.audit ?? []) equal(parse(this.#get("SELECT data FROM audit WHERE id=?", event.id).data), event, `audit ${event.id}`);
    this.#run("INSERT INTO meta VALUES('migrationReport',?)", json({ version: 1, hash: createHash("sha256").update(raw).digest("hex"), counts: Object.fromEntries(["sources", "items", "drafts", "runs"].map((key) => [key, Object.keys(state[key]).length])), verified: true }));
    this.#run("INSERT INTO meta VALUES('initialized','1')");
  }
  settings() {
    return parse(this.#get("SELECT value FROM meta WHERE key='settings'").value);
  }
  configure(settings) {
    return this.#transaction(() => {
      const old = this.settings();
      this.#run("UPDATE meta SET value=? WHERE key='settings'", json(settings));
      if ((old.learningGuidance ?? "") !== (settings.learningGuidance ?? "")) this.#invalidateGlobalGuidance(settings);
    });
  }
  source(id) {
    return parse(this.#get("SELECT data FROM sources WHERE id=?", id)?.data);
  }
  sources() {
    return this.#all("SELECT data FROM sources ORDER BY id").map((row) => parse(row.data));
  }
  saveSource(source) {
    return this.#transaction(() => {
      const old = this.source(source.id);
      if (old && source.expectedRevision !== void 0 && old.revision !== source.expectedRevision) throw new Error("来源配置已变化，请刷新后保存");
      const saved = { ...source, revision: (old?.revision ?? 0) + 1 };
      delete saved.expectedRevision;
      this.#run("INSERT INTO sources(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", saved.id, json(saved));
      if (old && old.contextVersion !== saved.contextVersion) this.#invalidateSource(saved.id);
      this.#audit("source.saved", { sourceId: saved.id });
      return saved;
    });
  }
  #invalidateGlobalGuidance(settings) {
    for (const source of this.sources()) if (!Object.hasOwn(source.settings ?? {}, "learningGuidance")) {
      this.#run("UPDATE sources SET data=? WHERE id=?", json({ ...source, revision: (source.revision ?? 0) + 1, contextVersion: learningHash({ previous: source.contextVersion, learningGuidance: settings.learningGuidance ?? "" }) }), source.id);
      this.#invalidateSource(source.id);
    }
  }
  #invalidateSource(id) {
    for (const row of this.#all("SELECT id FROM drafts WHERE source_id=? AND status IN ('pending-supervision','ready','blocked')", id)) this.#updateDraft(row.id, { status: "stale" });
  }
  updateSource(id, change) {
    return this.#transaction(() => {
      const source = required(this.source(id), "来源");
      this.#run("UPDATE sources SET data=? WHERE id=?", json({ ...source, ...change }), id);
    });
  }
  #writeItem(item) {
    const extras = { ...item };
    for (const key of ["id", "sourceId", "remoteId", "kind", "version", "previous", "readVersion", "analyzedVersion", "analyzedContextVersion", "handling", "changedAt", "analysis", "body", "payload", "title", "url", "sessions"]) delete extras[key];
    this.#run(`INSERT INTO items(id,source_id,remote_id,kind,version,previous_version,read_version,analyzed_version,context_version,handling,changed_at,analysis,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,previous_version=excluded.previous_version,read_version=excluded.read_version,analyzed_version=excluded.analyzed_version,context_version=excluded.context_version,handling=excluded.handling,changed_at=excluded.changed_at,analysis=excluded.analysis,data=excluded.data`, item.id, item.sourceId, item.remoteId, item.kind, item.version, item.previous?.version ?? null, item.readVersion ?? null, item.analyzedVersion ?? null, item.analyzedContextVersion ?? null, item.handling ?? "none", item.changedAt ?? "", item.analysis ? json(item.analysis) : null, json(extras));
  }
  #version(item, complete) {
    this.#run("INSERT OR IGNORE INTO item_versions(item_id,version,title,body,url,payload,changed_at,complete,data,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)", item.id, item.version, item.title ?? "", item.body ?? "", item.url ?? null, item.payload ? json(item.payload) : null, item.changedAt ?? null, complete ? 1 : 0, json({ ...Object.fromEntries(Object.entries(item).filter(([key]) => !["id", "version", "changedAt", "title", "body", "payload", "url", "analysis", "sessions", "previous"].includes(key))), previousVersion: item.previous?.version ?? null }), json({ state: item.payload?.state, merged: item.payload?.merged, contextComplete: item.payload?.contextComplete, contextLimit: item.payload?.contextLimit, diffLength:0, ...item.payload?.video ? { video: { title: item.payload.video.title, owner: item.payload.video.owner, descriptionLength:0 } } : {} }));
    this.#run(`UPDATE item_versions SET metadata=CASE WHEN json_type(metadata,'$.video')='object' THEN json_set(metadata,'$.diffLength',coalesce(length(json_extract(payload,'$.diff')),0),'$.video.descriptionLength',coalesce(length(json_extract(payload,'$.video.description')),0)) ELSE json_set(metadata,'$.diffLength',coalesce(length(json_extract(payload,'$.diff')),0)) END WHERE item_id=? AND version=?`,item.id,item.version);
    let ordinal = 0;
    for (const comment of [...item.payload?.comments ?? [], ...item.payload?.reviewComments ?? []]) {
      const id = String(comment.id ?? ordinal);
      this.#run("INSERT OR IGNORE INTO comments VALUES(?,?,?,?,?,?,?)", item.id, item.version, id, ordinal++, comment.author ?? "", comment.body ?? "", json({ ...comment, id: void 0, body: void 0, author: void 0 }));
    }
  }
  #itemRow(id) {
    return this.#get("SELECT * FROM items WHERE id=?", id);
  }
  #itemState(row) {
    return { ...parse(row.data), id: row.id, sourceId: row.source_id, remoteId: row.remote_id, kind: row.kind, version: row.version, readVersion: row.read_version, analyzedVersion: row.analyzed_version, analyzedContextVersion: row.context_version, handling: row.handling, changedAt: row.changed_at, analysis: parse(row.analysis), analysisRevision: row.analysis_revision, attentionVersion: row.attention_version, acknowledgedAttentionVersion: row.acknowledged_attention_version, attentionAcknowledged: row.attention_version === row.acknowledged_attention_version };
  }
  item(id, version) {
    const row = this.#itemRow(id);
    if (!row) return null;
    const snapshot = this.#get("SELECT * FROM item_versions WHERE item_id=? AND version=?", id, version ?? row.version);
    if (!snapshot) return null;
    const frozen = parse(snapshot.data), previousVersion = version === void 0 ? row.previous_version : frozen.previousVersion;
    const previous = previousVersion ? this.#get("SELECT title,body,version,complete FROM item_versions WHERE item_id=? AND version=?", id, previousVersion) : null;
    return { ...frozen, ...this.#itemState(row), changedAt: version === void 0 ? row.changed_at : snapshot.changed_at, version: snapshot.version, title: snapshot.title, body: snapshot.body, url: snapshot.url, payload: parse(snapshot.payload), complete: Boolean(snapshot.complete), previous: previous ? { title: previous.title, body: previous.body, version: previous.version, complete: Boolean(previous.complete) } : null, sessions: this.#all("SELECT data FROM sessions WHERE item_id=? ORDER BY seq", id).map((r) => parse(r.data)) };
  }
  #advanceAttention(id) {
    const item = this.#itemState(required(this.#itemRow(id), "内容项"));
    const handling = item.handling === "done" ? currentAnalysis(item)?.intervention === "human" ? "pending" : "none" : item.handling;
    this.#run("UPDATE items SET attention_version=attention_version+1,handling=? WHERE id=?", handling, id);
  }
  #project(id) {
    const row = required(this.#itemRow(id), "内容项"), item = this.#itemState(row), drafts = this.#all(`SELECT status,item_id FROM drafts WHERE item_id=? AND status IN (${active.map(() => "?").join(",")})`, id, ...active).map((d) => ({ itemId: d.item_id, status: d.status }));
    const handling = Number(needsHandling(item, drafts)), unread = Number(item.readVersion !== item.version), analyzed = Number(Boolean(currentAnalysis(item))), priority = item.attentionAcknowledged ? 0 : itemPriority(item);
    this.#run("UPDATE items SET priority=?,needs_handling=?,unread=?,analyzed=? WHERE id=?", priority, handling, unread, analyzed, id);
    this.#run("UPDATE sources SET total=total+?,unread=unread+?,handling=handling+?,analyzed=analyzed+?,unorganized=unorganized+? WHERE id=?", 0, unread - row.unread, handling - row.needs_handling, analyzed - row.analyzed, unread * (1 - analyzed) - row.unread * (1 - row.analyzed), row.source_id);
  }
  #countNew(sourceId) {
    this.#run("UPDATE sources SET total=total+1 WHERE id=?", sourceId);
  }
  applyFetch(sourceId, entries, metadata, at, fingerprint) {
    return this.#transaction(() => {
      const source = required(this.source(sourceId), "来源");
      for (const entry of entries) {
        const legacyRemoteId = source.platform === 'github' ? entry.kind === 'release' && typeof entry.payload?.tag === 'string' ? `release:web-${entry.payload.tag}` : entry.kind === 'pr' && Number.isInteger(entry.payload?.number) ? `pr:web-${entry.payload.number}` : null : null;
        let old = this.#itemRow(`${sourceId}:${entry.remoteId}`);
        if (!old && source.platform === 'github' && entry.kind === 'release' && entry.payload?.id) {
          const matches = this.#all("SELECT i.* FROM items i JOIN item_versions v ON v.item_id=i.id AND v.version=i.version WHERE i.source_id=? AND i.kind='release' AND json_extract(v.payload,'$.id')=? LIMIT 2", sourceId, String(entry.payload.id));
          if (matches.length > 1) throw new Error('GitHub Release 数字身份重复，未推进采集基线');
          old = matches[0];
        }
        old ??= legacyRemoteId ? this.#itemRow(`${sourceId}:${legacyRemoteId}`) : null;
        const id = old?.id ?? `${sourceId}:${entry.remoteId}`, version = fingerprint({ title: entry.title, body: entry.body, payload: entry.payload });
        const updatedAt = remoteTime(entry.updatedAt) ?? remoteTime(entry.payload?.updatedAt) ?? remoteTime(entry.payload?.publishedAt);
        if (old?.version === version) {
          if (updatedAt && parse(old.data).updatedAt !== updatedAt) this.#run("UPDATE items SET data=? WHERE id=?", json({ ...parse(old.data), updatedAt }), id);
          continue;
        }
        const item = { ...old ? this.#itemState(old) : {}, ...entry, updatedAt, remoteId: old?.remote_id ?? entry.remoteId, id, sourceId, version, previous: old ? { version: old.version } : null, readVersion: old?.read_version ?? (!source.initialized ? version : null), analyzedVersion: old?.analyzed_version ?? (!source.initialized ? version : null), handling: old?.handling ?? "none", changedAt: at };
        this.#writeItem(item);
        if (old) this.#advanceAttention(id);
        this.#version(item, true);
        if (!old) this.#countNew(sourceId);
        for (const d of this.#all("SELECT id FROM drafts WHERE item_id=? AND status IN ('pending-supervision','ready','blocked')", id)) this.#updateDraft(d.id, { status: "stale" });
        this.#project(id);
      }
      this.#run("UPDATE sources SET data=? WHERE id=?", json({ ...source, metadata: metadata ?? null, initialized: true, fetchedAt: at, fetchError: null, retryAt: null }), sourceId);
    });
  }
  markRead(id, version) {
    return this.#transaction(() => {
      const item = required(this.#itemRow(id), "内容项");
      if (version && item.version !== version) throw new Error("内容已更新，请刷新后再标记");
      this.#run("UPDATE items SET read_version=version WHERE id=?", id);
      this.#project(id);
    });
  }
  handling(id, handling) {
    return this.#transaction(() => {
      required(this.#itemRow(id), "内容项");
      this.#run("UPDATE items SET handling=?,acknowledged_attention_version=CASE WHEN ?='done' THEN attention_version ELSE acknowledged_attention_version END,attention_version=attention_version+? WHERE id=?", handling, handling, ["pending", "later"].includes(handling) ? 1 : 0, id);
      this.#project(id);
    });
  }
  markAllRead(sourceId) {
    return this.#transaction(() => {
      if (sourceId) required(this.source(sourceId), "来源");
      const rows = this.#all(`SELECT id FROM items ${sourceId ? "WHERE source_id=?" : ""}`, ...sourceId ? [sourceId] : []);
      for (const row of rows) {
        this.#run("UPDATE items SET read_version=version,acknowledged_attention_version=attention_version WHERE id=?", row.id);
        this.#project(row.id);
      }
      this.#audit("items.read-all", { sourceId: sourceId ?? null, count: rows.length });
      return { count: rows.length };
    });
  }
  #page(countSql, selectSql, args, input) {
    const q = pageQuery(input), total = this.#get(countSql, ...args).n, pageCount = Math.max(1, Math.ceil(total / q.pageSize)), page = Math.min(q.page, pageCount);
    return { items: this.#all(selectSql, ...args, q.pageSize, (page - 1) * q.pageSize), page, pageSize: q.pageSize, total, pageCount, revision: this.revision() };
  }
  #card(row) {
    const item = this.#itemState(row), payload = { ...parse(row.payload), ...row.remote_state ? { state: row.remote_state } : {}, ...row.remote_merged !== void 0 && row.remote_merged !== null ? { merged: Boolean(row.remote_merged) } : {} };
    return { ...item, updatedAt: row.updated_at ?? remoteTime(item.updatedAt) ?? item.changedAt, title: row.title, url: row.url, analysis: currentAnalysis(item), priority: row.priority, needsHandling: Boolean(row.needs_handling), status: row.needs_handling ? "handling" : row.unread ? "unread" : "read", excerpt: row.excerpt, payload: { ...payload?.state ? { state: payload.state } : {}, ...payload?.merged !== void 0 ? { merged: payload.merged } : {}, ...payload?.contextComplete !== void 0 ? { contextComplete: payload.contextComplete } : {}, ...payload?.contextLimit ? { contextLimit: payload.contextLimit } : {}, ...payload?.video ? { video: payload.video } : {} } };
  }
  items(sourceId, input = {}) {
    const source = required(this.source(sourceId), "来源");
    const q = pageQuery(input), args = [sourceId], where = ["i.source_id=?"];
    const order = input.order ?? 'updated-desc', showClosed = input.showClosed ?? true;
    if (!['updated-desc', 'updated-asc'].includes(order) || ![true, false, 'true', 'false'].includes(showClosed)) throw new Error('列表显示参数无效');
    if (source.platform === 'github' && showClosed !== true && showClosed !== 'true') where.push("(i.kind NOT IN ('issue','pr') OR (lower(coalesce(json_extract(v.metadata,'$.state'),json_extract(v.payload,'$.state'),'')) NOT IN ('closed','merged') AND coalesce(json_extract(v.metadata,'$.merged'),json_extract(v.payload,'$.merged'),0)<>1))");
    if (q.filter === "unread") where.push("i.unread=1");
    if (q.filter === "handling") where.push("i.needs_handling=1");
    if (q.query) {
      where.push("instr(dmc_lower(v.title||' '||v.body),?)>0");
      args.push(q.query);
    }
    const from = `FROM items i JOIN item_versions v ON v.item_id=i.id AND v.version=i.version WHERE ${where.join(" AND ")}`;
    const page = this.#page(`SELECT count(*) n ${from}`, `SELECT i.*,${updatedTimeSQL} updated_at,v.title,v.url,substr(v.body,1,600) excerpt,v.metadata payload,coalesce(json_extract(v.metadata,'$.state'),json_extract(v.payload,'$.state')) remote_state,coalesce(json_extract(v.metadata,'$.merged'),json_extract(v.payload,'$.merged')) remote_merged ${from} ORDER BY i.needs_handling DESC,i.priority DESC,updated_at ${order === 'updated-asc' ? 'ASC' : 'DESC'},i.id LIMIT ? OFFSET ?`, args, q);
    page.items = page.items.map((row) => this.#card(row));
    return page;
  }
  header(id, version) {
    const row = required(this.#itemRow(id), "内容项"), v = required(this.#get(`SELECT title,url,length(body) body_length,json_extract(metadata,'$.diffLength') diff_length,metadata payload,json_extract(payload,'$.state') remote_state,json_extract(payload,'$.merged') remote_merged,version,complete,data,changed_at FROM item_versions WHERE item_id=? AND version=?`, id, version ?? row.version), "内容版本");
    const header = this.#card({ ...row, title: v.title, url: v.url, excerpt: "", payload: v.payload, remote_state: v.remote_state, remote_merged: v.remote_merged });
    header.version = v.version;
    if (v.version !== row.version) header.analysis = null;
    const previousVersion = version === void 0 ? row.previous_version : parse(v.data).previousVersion;
    const previous = previousVersion ? this.#get("SELECT version,title,complete FROM item_versions WHERE item_id=? AND version=?", id, previousVersion) : null;
    if (version !== void 0) header.changedAt = v.changed_at;
    return { ...header, previous: previous ? { ...previous, complete: Boolean(previous.complete) } : null, commentsCount: this.#get("SELECT count(*) n FROM comments WHERE item_id=? AND version=?", id, v.version).n, bodyLength: v.body_length, diffLength: v.diff_length, contextVersion: row.context_version, complete: Boolean(v.complete) };
  }
  content(id, { version, section = "body", commentId, offset = 0, length = 16e3 } = {}) {
    const item = required(this.#itemRow(id), "内容项");
    version ??= item.version;
    offset = Number(offset);
    length = Number(length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 32e3 || !["body", "comment", "diff", "video-description"].includes(section)) throw new Error("内容区段参数无效");
    const column = section === "diff" ? "json_extract(payload,'$.diff')" : section === "video-description" ? "json_extract(payload,'$.video.description')" : "body";
    const from = section === "comment" ? "comments" : "item_versions";
    const where = section === "comment" ? "item_id=? AND version=? AND id=?" : "item_id=? AND version=?";
    const args = section === "comment" ? [id, version, String(commentId)] : [id, version];
    const row = required(this.#get(`SELECT coalesce(substr(${column},?,?),'') text,coalesce(length(${column}),0) total FROM ${from} WHERE ${where}`, offset+1, length, ...args), section === "comment" ? "评论" : "内容版本");
    const next = offset + Array.from(row.text).length;
    return { version, text: row.text, offset, nextOffset: next < row.total ? next : null, total: row.total, complete: next >= row.total };
  }
  comments(id, version, input = {}) {
    const row = required(this.#itemRow(id), "内容项");
    version ??= row.version;
    required(this.#get("SELECT 1 FROM item_versions WHERE item_id=? AND version=?", id, version), "内容版本");
    const page = this.#page("SELECT count(*) n FROM comments WHERE item_id=? AND version=?", "SELECT id,author,substr(body,1,600) excerpt,length(body) bodyLength,data FROM comments WHERE item_id=? AND version=? ORDER BY ordinal,id LIMIT ? OFFSET ?", [id, version], input);
    page.items = page.items.map(({ data, ...r }) => ({ ...r, parent: parse(data)?.parent ?? null, updatedAt: parse(data)?.updatedAt ?? null }));
    return page;
  }
  versions(id, input = {}) {
    required(this.#itemRow(id), "内容项");
    const page = this.#page("SELECT count(*) n FROM item_versions WHERE item_id=?", "SELECT version,title,changed_at changedAt,complete FROM item_versions WHERE item_id=? ORDER BY changed_at DESC,version LIMIT ? OFFSET ?", [id], input);
    page.items = page.items.map((r) => ({ ...r, complete: Boolean(r.complete) }));
    return page;
  }
  overviewSources() {
    return this.#all("SELECT * FROM sources").map((row) => {
      const s = parse(row.data), top = this.#get("SELECT priority,changed_at FROM items WHERE source_id=? ORDER BY priority DESC,changed_at DESC,id LIMIT 1", row.id), changed = this.#get("SELECT max(changed_at) at FROM items WHERE source_id=?", row.id).at;
      const summaries = this.#all("SELECT json_extract(analysis,'$.summary') summary FROM items WHERE source_id=? AND unread=1 AND analyzed=1 AND coalesce(json_extract(analysis,'$.processing'),'') NOT IN ('context-incomplete','decision-only') AND coalesce(json_extract(analysis,'$.summary'),'')<>'' ORDER BY priority DESC,changed_at DESC,id LIMIT 2", row.id).map((r) => r.summary).filter(Boolean);
      return { ...s, total: row.total, unread: row.unread, handling: row.handling, analyzed: row.analyzed, unreadUnorganized: row.unorganized, importance: Math.floor((top?.priority ?? 0) / 10), urgent: Boolean(this.#get("SELECT 1 FROM items WHERE source_id=? AND priority%10>0 LIMIT 1", row.id)), priority: top?.priority ?? 0, changedAt: changed ?? "", summaries };
    });
  }
  candidates(sourceId, scope, { includeClosed = true } = {}) {
    const total = this.#get("SELECT count(*) n FROM items WHERE source_id=?", sourceId).n;
    const rows = this.#all(`SELECT i.id,i.version${includeClosed ? '' : ",i.kind,json_extract(v.payload,'$.state') state,json_extract(v.payload,'$.merged') merged"} FROM items i ${includeClosed ? '' : 'JOIN item_versions v ON v.item_id=i.id AND v.version=i.version'} WHERE source_id=? AND (analyzed_version IS NOT i.version ${scope === "history" ? "OR analysis IS NULL" : ""}) ORDER BY i.id`, sourceId);
    const refs = rows.filter(row => includeClosed || !(['issue','pr'].includes(row.kind) && (['closed','merged'].includes(String(row.state).toLowerCase()) || row.merged === 1))).map(({id,version}) => ({id,version}));
    return { total, refs, excludedClosed: rows.length - refs.length, unanalysed: this.#get("SELECT count(*) n FROM items WHERE source_id=? AND analysis IS NULL", sourceId).n };
  }
  #writeRun(run) {
    const { decision, sourceSnapshot, ...data } = run;
    this.#run("INSERT INTO runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,decision=coalesce(excluded.decision,runs.decision),source_snapshot=coalesce(excluded.source_snapshot,runs.source_snapshot)", run.id, run.itemId, run.status ?? "running", run.startedAt ?? (/* @__PURE__ */ new Date()).toISOString(), json(data), decision ? json(decision) : null, sourceSnapshot ? json(sourceSnapshot) : null);
  }
  createRun(run) {
    return this.#transaction(() => {
      this.#writeRun(run);
      return run;
    });
  }
  #runSessions(id, data) {
    return [...(data.originSession ? [data.originSession] : []), ...this.#all("SELECT data FROM sessions WHERE run_id=? ORDER BY seq", id).map(row => parse(row.data))];
  }
  run(id) {
    const row = this.#get("SELECT * FROM runs WHERE id=?", id);
    return row ? { ...parse(row.data), decision: parse(row.decision), sourceSnapshot: parse(row.source_snapshot), sessions: this.#runSessions(id, parse(row.data)) } : null;
  }
  updateRun(id, change) {
    return this.#transaction(() => {
      this.#writeRun({ ...required(this.run(id), "运行记录"), ...change });
      if (change.status && change.status !== "running") this.#eligibleRun(id);
    });
  }
  runs(id, input = {}) {
    required(this.#itemRow(id), "内容项");
    const from = `FROM (SELECT id,json_remove(data,'$.inputSnapshot','$.settingsSnapshot','$.result') data,decision IS NOT NULL hasDecision,started_at,0 legacy FROM runs WHERE item_id=? UNION ALL SELECT session_id id,data,0 hasDecision,coalesce(json_extract(data,'$.at'),'') started_at,1 legacy FROM sessions WHERE item_id=? AND run_id IS NULL)`;
    const page = this.#page(`SELECT count(*) n ${from}`, `SELECT * ${from} ORDER BY started_at DESC,id LIMIT ? OFFSET ?`, [id, id], input);
    page.items = page.items.map((row) => row.legacy ? { id: `legacy-session:${row.id}`, legacy: true, kind: "legacy-session", status: "historical", startedAt: row.started_at, sessions: [parse(row.data)], hasDecision: false } : { ...parse(row.data), hasDecision: Boolean(row.hasDecision), sessions: this.#runSessions(row.id, parse(row.data)) });
    return page;
  }
  decision(id) {
    return parse(required(this.#get("SELECT decision FROM runs WHERE id=?", id), "运行记录").decision);
  }
  #writeDraft(draft, attentionEvent = true) {
    const old = this.#get("SELECT status FROM drafts WHERE id=?", draft.id);
    const data = { ...draft, bodyHash: createHash("sha256").update(json(draft.body)).digest("hex") };
    delete data.body;
    this.#run("INSERT INTO drafts VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", draft.id, draft.itemId, draft.sourceId, draft.status, draft.body, draft.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(), json(data));
    if (attentionEvent && (!old || old.status !== draft.status && ["pending-supervision", "ready", "blocked"].includes(draft.status))) this.#advanceAttention(draft.itemId);
  }
  draft(id) {
    const row = this.#get("SELECT * FROM drafts WHERE id=?", id);
    return row ? { ...parse(row.data), body: row.body, bodyHash: createHash("sha256").update(json(row.body)).digest("hex") } : null;
  }
  #updateDraft(id, change) {
    const draft = required(this.draft(id), "草稿");
    this.#writeDraft({ ...draft, ...change });
    this.#project(draft.itemId);
  }
  drafts(id, input = {}) {
    required(this.#itemRow(id), "内容项");
    const page = this.#page("SELECT count(*) n FROM drafts WHERE item_id=?", "SELECT data,substr(body,1,600) excerpt,length(body) bodyLength FROM drafts WHERE item_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?", [id], input);
    page.items = page.items.map((row) => ({ ...parse(row.data), excerpt: row.excerpt, bodyLength: row.bodyLength }));
    return page;
  }
  updateDraft(id, change) {
    return this.#transaction(() => this.#updateDraft(id, change));
  }
  bindSession(binding) {
    return this.#transaction(() => {
      const run = required(this.run(binding.runId), "运行记录");
      const old = this.sessionBinding(binding.sessionId);
      if (old) {
        if (old.runId !== binding.runId || old.role !== binding.role || old.cwd !== binding.cwd) throw new Error("会话绑定冲突");
        return old;
      }
      const value = { ...binding, itemId: run.itemId, sourceId: run.sourceId, version: run.version, contextVersion: run.contextVersion, at: binding.at ?? (/* @__PURE__ */ new Date()).toISOString() };
      this.#run("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)", binding.sessionId, binding.runId, run.itemId, run.sourceId, binding.role, binding.workspaceId, binding.cwd, json(value), binding.role === "human" ? 1 : 0, this.#sessionSequence());
      return value;
    });
  }
  sessionBinding(id) {
    return parse(this.#get("SELECT data FROM sessions WHERE session_id=?", id)?.data);
  }
  humanSession(itemId, workspaceId, version, contextVersion) {
    return this.#all("SELECT data FROM sessions WHERE item_id=? AND role='human' AND cwd IS NOT NULL ORDER BY seq DESC", itemId).map((r) => parse(r.data)).find((s) => s.workspaceId === workspaceId && s.version === version && s.contextVersion === contextVersion && !s.legacy);
  }
  #sessionSequence() {
    this.#run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='session_seq'");
    return Number(this.#get("SELECT value FROM meta WHERE key='session_seq'").value);
  }
  #eligibleRun(runId) {
    for (const row of this.#all("SELECT session_id FROM sessions WHERE run_id=?", runId)) this.#run("UPDATE sessions SET eligible=1,seq=? WHERE session_id=?", this.#sessionSequence(), row.session_id);
  }
  sessionDirectory({ after = 0, limit = 100 } = {}) {
    after = Number(after);
    limit = Number(limit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("目录分页参数无效");
    const rows = this.#all("SELECT session_id,eligible,seq FROM sessions WHERE seq>? ORDER BY seq,session_id LIMIT ?", after, limit + 1);
    const chosen = rows.slice(0, limit);
    const next = chosen.at(-1)?.seq ?? after;
    return { changes: chosen.map((r) => ({ sessionId: r.session_id, eligible: Boolean(r.eligible) })), next, hasMore: Boolean(this.#get("SELECT 1 FROM sessions WHERE seq>? LIMIT 1", next)) };
  }
  replaySubmission(sessionId, submission) {
    const row = this.#get("SELECT request_hash,data FROM receipts WHERE session_id=? AND operation_key=?", sessionId, submission.operationKey);
    if (!row) return null;
    if (row.request_hash !== requestHash(submission)) throw new Error("相同操作键提交了不同内容");
    return parse(row.data);
  }
  endSession(sessionId) {
    return this.#transaction(() => {
      const row = this.#get("SELECT eligible FROM sessions WHERE session_id=?", sessionId);
      if (row && !row.eligible) this.#run("UPDATE sessions SET eligible=1,seq=? WHERE session_id=?", this.#sessionSequence(), sessionId);
    });
  }
  receipt(sessionId) {
    return parse(this.#get("SELECT data FROM receipts WHERE session_id=? AND json_extract(data,'$.kind') IS NOT 'analysis-revision' ORDER BY rowid DESC LIMIT 1", sessionId)?.data);
  }
  #audit(event, detail, at = (/* @__PURE__ */ new Date()).toISOString()) {
    const value = { id: randomUUID(), at, event, ...detail };
    this.#run("INSERT INTO audit VALUES(?,?,?,?)", value.id, at, event, json(value));
  }
  adoptResult(runId, result) {
    return this.#transaction(() => {
      const run = required(this.run(runId), "运行记录"), adopted = this.#adopt(run, result);
      this.#writeRun({ ...run, result, resultAdopted: adopted });
      return adopted;
    });
  }
  #adopt(run, result) {
    const row = required(this.#itemRow(run.itemId), "内容项"), source = this.source(row.source_id);
    const valid = row.version === run.version && source.contextVersion === run.sourceContextVersion && source.workspaceId === run.workspaceId && row.analysis_revision === (run.baseAnalysisRevision ?? row.analysis_revision);
    if (valid) {
      this.#run("UPDATE items SET analysis=?,analyzed_version=?,context_version=?,analysis_revision=analysis_revision+1,handling=CASE WHEN handling='none' AND ?='human' THEN 'pending' ELSE handling END WHERE id=?", json(result), run.version, run.contextVersion, result.intervention ?? "none", run.itemId);
      this.#advanceAttention(run.itemId);
      this.#project(run.itemId);
    }
    return valid;
  }
  submitWorkspaceDraft(run, binding, callId, submission, currentContext, at) {
    return this.#transaction(() => {
      const replay = this.replaySubmission(binding.sessionId, submission);
      if (replay) return replay;
      if (this.sessionBinding(binding.sessionId)) throw new Error("受管会话必须使用原角色绑定");
      const item = required(this.#itemRow(run.itemId), "内容项"), source = required(this.source(run.sourceId), "来源");
      if (item.version !== submission.version || run.contextVersion !== submission.contextVersion || source.contextVersion !== run.sourceContextVersion || source.workspaceId !== binding.workspaceId) throw new Error("内容或来源资料已变化，请重新读取后存稿");
      this.#writeRun(run);
      return this.#submit(binding, callId, submission, currentContext, at);
    });
  }
  submit(binding, callId, submission, currentContext, at) {
    return this.#transaction(() => this.#submit(binding, callId, submission, currentContext, at));
  }
  reviseAnalysis(binding, callId, submission, run, at) {
    return this.#transaction(() => {
      const replay = this.replaySubmission(binding.sessionId, submission);
      if (replay) return replay;
      const original = required(this.run(binding.runId), "运行记录"), first = this.receipt(binding.sessionId);
      if (!first || first.kind !== "analysis") throw new Error("本会话尚未提交分析，请先使用 dmc_submit_result");
      const item = required(this.#itemRow(original.itemId), "内容项"), source = required(this.source(original.sourceId), "来源");
      if (item.version !== original.version || item.version !== submission.version || source.contextVersion !== original.sourceContextVersion || source.contextVersion !== run.sourceContextVersion || source.workspaceId !== binding.workspaceId || run.contextVersion !== original.contextVersion) throw new Error("内容或来源资料已变化，请从当前内容新开分析会话");
      if (!item.analysis || item.analysis_revision !== submission.expectedAnalysisRevision) throw new Error("分析已变化，请重新读取 analysis 后修订");
      const result = { ...submission.analysis, processing: "analysis" };
      const revision = { ...run.revision, originalReceiptId: first.id, previousAnalysisRevision: item.analysis_revision, previousAnalysis: parse(item.analysis) };
      if (!this.#adopt(run, result)) throw new Error("分析已变化，请重新读取 analysis 后修订");
      const invalidatedDraftIds = this.#all("SELECT id FROM drafts WHERE item_id=? AND status IN ('pending-supervision','ready','blocked')", original.itemId).map(row => row.id);
      for (const id of invalidatedDraftIds) this.#updateDraft(id, { status: "stale" });
      this.#writeRun({ ...run, revision, result, resultAdopted: true, processing: "analysis", status: "completed", finishedAt: at });
      const receipt = { id: randomUUID(), sessionId: binding.sessionId, runId: run.id, kind: "analysis-revision", result, adopted: true, analysisRevision: item.analysis_revision + 1, revision, invalidatedDraftIds };
      this.#run("INSERT INTO receipts VALUES(?,?,?,?,?)", receipt.id, binding.sessionId, submission.operationKey, requestHash(submission), json(receipt));
      this.#audit("tool.analysis.revised", { sessionId: binding.sessionId, callId, runId: run.id, receiptId: receipt.id, originRunId: original.id, analysisRevision: receipt.analysisRevision }, at);
      return receipt;
    });
  }
  #submit(binding, callId, submission, currentContext, at) {
    const hash = requestHash(submission), existing = this.#get("SELECT request_hash,data FROM receipts WHERE session_id=? AND operation_key=?", binding.sessionId, submission.operationKey);
    if (existing) {
      if (existing.request_hash !== hash) throw new Error("相同操作键提交了不同内容");
      return parse(existing.data);
    }
    if (binding.role !== "human" && this.receipt(binding.sessionId)) throw new Error("此阶段已有持久结果");
    const run = required(this.run(binding.runId), "运行记录"), item = required(this.#itemRow(run.itemId), "内容项"), source = required(this.source(run.sourceId), "来源");
    const fresh = item.version === run.version && currentContext === run.contextVersion && source.contextVersion === run.sourceContextVersion && source.workspaceId === binding.workspaceId;
    const receipt = { id: randomUUID(), sessionId: binding.sessionId, runId: run.id, kind: submission.kind, result: null };
    if (submission.kind === "analysis") {
      receipt.result = { ...submission.analysis, processing: "analysis" };
      receipt.adopted = fresh && this.#adopt(run, receipt.result);
      receipt.analysisId = receipt.id;
      this.#writeRun({ ...run, resultAdopted: receipt.adopted, result: receipt.result });
      if (item.kind !== "release" && submission.analysis.intervention !== "human" && submission.draftBody?.trim()) receipt.draft = this.#newDraft(run, submission.draftBody, receipt.adopted ? "pending-supervision" : "stale", at);
    } else if (submission.kind === "draft") {
      if (submission.replacesDraftId) {
        const old = required(this.draft(submission.replacesDraftId), "旧草稿");
        if (old.itemId !== run.itemId || old.bodyHash !== submission.bodyHash || !["pending-supervision", "ready", "blocked", "stale"].includes(old.status)) throw new Error("旧草稿已变化或不能改稿");
        this.#updateDraft(old.id, { status: "superseded" });
      }
      receipt.draft = this.#newDraft(run, submission.body, fresh ? "pending-supervision" : "stale", at);
      receipt.result = receipt.draft;
    } else if (submission.kind === "decision") {
      receipt.result = { choice: submission.choice, certain: submission.certain, reason: submission.reason };
    } else if (submission.kind === "supervision") {
      const draft = required(this.draft(binding.draftId), "草稿");
      if (draft.runId !== run.id || draft.bodyHash !== binding.bodyHash || !["pending-supervision", "ready", "blocked"].includes(draft.status)) throw new Error("监督目标草稿已变化");
      receipt.result = { approved: submission.approved, reason: submission.reason };
      this.#updateDraft(draft.id, { supervision: { ...receipt.result, sessionId: binding.sessionId, at }, status: fresh && draft.contextVersion === currentContext ? submission.approved ? "ready" : "blocked" : "stale" });
      receipt.draft = this.draft(draft.id);
    } else throw new Error("提交类型无效");
    if (receipt.draft) {
      receipt.draftId = receipt.draft.id;
      receipt.draft = { id: receipt.draft.id, body: receipt.draft.body, bodyHash: receipt.draft.bodyHash, status: receipt.draft.status };
    }
    this.#run("INSERT INTO receipts VALUES(?,?,?,?,?)", receipt.id, binding.sessionId, submission.operationKey, hash, json(receipt));
    this.#audit("tool.result.saved", { sessionId: binding.sessionId, callId, runId: run.id, receiptId: receipt.id, kind: submission.kind }, at);
    return receipt;
  }
  #newDraft(run, body, status, at) {
    const draft = { id: randomUUID(), itemId: run.itemId, sourceId: run.sourceId, runId: run.id, version: run.version, contextVersion: run.contextVersion, body, kind: this.#itemRow(run.itemId).kind === "pr" ? "review" : "reply", status, createdAt: at, supervision: null };
    this.#writeDraft(draft);
    this.#project(run.itemId);
    return this.draft(draft.id);
  }
  claimPublication(id, { version, bodyHash, contextVersion }, at) {
    return this.#transaction(() => {
      const draft = required(this.draft(id), "草稿"), item = required(this.#itemRow(draft.itemId), "内容项");
      if (draft.status !== "ready" || !draft.supervision?.approved || item.version !== draft.version || version !== draft.version || draft.bodyHash !== bodyHash || draft.contextVersion !== contextVersion) throw new Error("草稿状态或内容已变化，请重新审核");
      if (this.#get("SELECT 1 FROM drafts WHERE item_id=? AND id<>? AND status IN ('sending','unknown') LIMIT 1", draft.itemId, id)) throw new Error("此内容项有发送结果尚未确认");
      this.#updateDraft(id, { status: "sending", approvedAt: at });
      this.#audit("publication.approved", { draftId: id, version, bodyHash }, at);
      return this.draft(id);
    });
  }
  hasUncertain(itemId, id) {
    return Boolean(this.#get("SELECT 1 FROM drafts WHERE item_id=? AND id<>? AND status IN ('sending','unknown') LIMIT 1", itemId, id));
  }
  finishPublication(id, change, event, detail, at) {
    return this.#transaction(() => {
      this.#updateDraft(id, change);
      this.#audit(event, { draftId: id, ...detail }, at);
    });
  }
  feedback(itemId) {
    required(this.#itemRow(itemId), "内容项");
    const row = this.#get("SELECT f.*,l.feedback_id learned FROM feedback_versions f LEFT JOIN learned_feedback l ON l.feedback_id=f.id WHERE f.item_id=? ORDER BY revision DESC LIMIT 1", itemId);
    if (!row) return { itemId, revision: 0, text: "", learned: false };
    const { decisionSnapshot, ...data } = parse(row.data);
    return { ...data, learned: Boolean(row.learned) };
  }
  saveFeedback(itemId, input, at) {
    return this.#transaction(() => {
      const item = required(this.#itemRow(itemId), "内容项"), old = this.feedback(itemId);
      if (old.revision !== input.expectedRevision) throw new Error("评价已变化，请刷新后保存");
      if (item.version !== input.itemVersion || item.analysis_revision !== input.analysisRevision) throw new Error("内容或分析已更新，请刷新后评价");
      const visibleAnalysis = currentAnalysis(this.#itemState(item));
      const run = visibleAnalysis ? this.#get("SELECT id,decision FROM runs WHERE item_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.resultAdopted')=1 AND json_extract(data,'$.baseAnalysisRevision')=? ORDER BY started_at DESC,id DESC LIMIT 1", itemId, item.version, item.analysis_revision - 1) : null;
      const feedback = { id: randomUUID(), itemId, sourceId: item.source_id, revision: old.revision + 1, text: input.text, itemVersion: item.version, analysisRevision: item.analysis_revision, analysisSnapshot: visibleAnalysis, runId: run?.id ?? null, decisionSnapshot: parse(run?.decision), updatedAt: at };
      this.#run("INSERT INTO feedback_versions VALUES(?,?,?,?,?,?)", feedback.id, itemId, item.source_id, feedback.revision, feedback.text, json(feedback));
      if (feedback.text.trim()) {
        this.#run("UPDATE items SET handling='done',read_version=version,acknowledged_attention_version=attention_version WHERE id=?", itemId);
        this.#project(itemId);
      }
      this.#audit("feedback.saved", { feedbackId: feedback.id, itemId, revision: feedback.revision }, at);
      return this.feedback(itemId);
    });
  }
  #unlearned(sourceId, limit) {
    const where = `f.text<>'' AND f.revision=(SELECT max(current.revision) FROM feedback_versions current WHERE current.item_id=f.item_id) AND NOT EXISTS(SELECT 1 FROM learned_feedback l WHERE l.feedback_id=f.id) ${sourceId ? "AND f.source_id=?" : ""}`;
    const args = sourceId ? [sourceId] : [];
    if (limit) return this.#all(`SELECT f.* FROM feedback_versions f WHERE ${where} ORDER BY EXISTS(SELECT 1 FROM learning_cases c WHERE c.feedback_id=f.id),coalesce((SELECT max(b.created_at) FROM learning_cases c JOIN learning_batches b ON b.id=c.batch_id WHERE c.feedback_id=f.id),''),f.rowid DESC LIMIT ?`, ...args, limit);
    return this.#get(`SELECT count(*) n FROM feedback_versions f WHERE ${where}`, ...args).n;
  }
  #writeLearning(batch) {
    const { cases, proposal, ...data } = batch;
    this.#run("INSERT INTO learning_batches VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", batch.id, batch.sourceId, batch.status, batch.createdAt, json(data));
  }
  createLearning(batch) {
    return this.#transaction(() => {
      const current = required(this.source(batch.sourceId), "来源");
      if (current.revision !== batch.baseSourceRevision || learningHash(this.settings()) !== batch.baseSettingsHash) throw new Error("来源或全局配置已变化，请重试");
      const existing = this.#get("SELECT id FROM learning_batches WHERE source_id=? AND status IN ('queued','running','pending') ORDER BY created_at DESC LIMIT 1", batch.sourceId);
      if (existing) return this.learning(existing.id);
      const rows = this.#unlearned(batch.sourceId, 50), remainingCount = Math.max(0, this.#unlearned(batch.sourceId) - rows.length);
      if (!rows.length) throw new Error("此来源没有尚未学习的用户评价");
      const saved = { ...batch, status: "queued", caseCount: rows.length, remainingCount, sessionId: null };
      this.#writeLearning(saved);
      for (const row of rows) {
        const feedback = parse(row.data), item = this.header(feedback.itemId, feedback.itemVersion), entry = { id: randomUUID(), feedbackId: row.id, feedbackRevision: row.revision, itemId: feedback.itemId, itemVersion: feedback.itemVersion, analysisRevision: feedback.analysisRevision, title: item.title, url: item.url, text: feedback.text, analysisSnapshot: feedback.analysisSnapshot, runId: feedback.runId, decisionSnapshot: feedback.decisionSnapshot, updatedAt: feedback.updatedAt };
        this.#run("INSERT INTO learning_cases VALUES(?,?,?,?)", entry.id, saved.id, row.id, json(entry));
      }
      this.#audit("learning.created", { batchId: saved.id, sourceId: saved.sourceId, caseCount: rows.length }, saved.createdAt);
      return this.learning(saved.id);
    });
  }
  learning(id) {
    const row = this.#get("SELECT data FROM learning_batches WHERE id=?", id);
    if (!row) return null;
    const cases = this.#all("SELECT data FROM learning_cases WHERE batch_id=? ORDER BY rowid", id).map(row => { const { decisionSnapshot, ...data } = parse(row.data); return { ...data, hasDecision: Boolean(decisionSnapshot) }; });
    const proposal = parse(this.#get("SELECT data FROM learning_proposals WHERE batch_id=? ORDER BY revision DESC LIMIT 1", id)?.data);
    return { ...parse(row.data), batchId: id, cases, proposal };
  }
  learningDecision(id, caseId) {
    const entry = parse(required(this.#get("SELECT data FROM learning_cases WHERE batch_id=? AND id=?", id, caseId), "批次案例").data);
    return entry.decisionSnapshot;
  }
  learningList(sourceId, input = {}) {
    if (sourceId) required(this.source(sourceId), "来源");
    const where = sourceId ? "WHERE source_id=?" : "", args = sourceId ? [sourceId] : [];
    const page = this.#page(`SELECT count(*) n FROM learning_batches ${where}`, `SELECT data FROM learning_batches ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, args, input);
    page.items = page.items.map(row => { const { sourceSnapshot, preparedSource, settingsSnapshot, effectiveSettings, ...value } = parse(row.data); return { ...value, batchId: value.id }; });
    return { ...page, unlearnedCount: this.#unlearned(sourceId) };
  }
  updateLearning(id, change) {
    return this.#transaction(() => {
      const batch = required(this.learning(id), "学习批次");
      this.#writeLearning({ ...batch, ...change });
      return this.learning(id);
    });
  }
  bindLearningSession(binding) {
    return this.#transaction(() => {
      const batch = required(this.learning(binding.batchId), "学习批次"), old = this.sessionBinding(binding.sessionId);
      if (old) {
        if (old.batchId !== batch.id || old.role !== "learning" || old.cwd !== binding.cwd) throw new Error("学习会话绑定冲突");
        return old;
      }
      if (batch.workspaceId !== binding.workspaceId || !["queued", "running"].includes(batch.status)) throw new Error("学习批次不能建立会话");
      const value = { ...binding, role: "learning", sourceId: batch.sourceId, learningBatchId: batch.id, at: new Date().toISOString() };
      this.#run("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)", binding.sessionId, null, null, batch.sourceId, "learning", binding.workspaceId, binding.cwd, json(value), 1, this.#sessionSequence());
      this.#writeLearning({ ...batch, sessionId: binding.sessionId, status: "running" });
      return value;
    });
  }
  learningSubmission(sessionId) {
    return parse(this.#get("SELECT data FROM learning_receipts WHERE session_id=? ORDER BY rowid DESC LIMIT 1", sessionId)?.data);
  }
  proposeLearning(binding, submission, callId, at) {
    return this.#transaction(() => {
      const old = this.#get("SELECT request_hash,data FROM learning_receipts WHERE session_id=? AND operation_key=?", binding.sessionId, submission.operationKey);
      if (old) {
        if (old.request_hash !== learningHash(submission)) throw new Error("相同操作键提交了不同建议");
        return parse(old.data);
      }
      const batch = required(this.learning(binding.batchId), "学习批次");
      if (batch.sessionId !== binding.sessionId || !["queued", "running", "pending", "no-suggestions"].includes(batch.status)) throw new Error("此批次不能提交学习建议");
      const changes = proposalChanges(submission, batch), revision = (batch.proposal?.revision ?? 0) + 1;
      const proposal = { revision, summary: submission.summary.trim(), changes, caseIds: [...new Set(changes.flatMap(change => change.caseIds))], status: changes.length ? "pending" : "no-suggestions", createdAt: at };
      proposal.hash = learningHash(proposal);
      this.#run("INSERT INTO learning_proposals VALUES(?,?,?,?,?)", batch.id, revision, proposal.hash, proposal.status, json(proposal));
      this.#writeLearning({ ...batch, status: proposal.status, error: null });
      const receipt = { batchId: batch.id, sessionId: binding.sessionId, proposalRevision: revision, proposalHash: proposal.hash, proposal };
      this.#run("INSERT INTO learning_receipts VALUES(?,?,?,?)", binding.sessionId, submission.operationKey, learningHash(submission), json(receipt));
      this.#audit("learning.proposed", { batchId: batch.id, sessionId: binding.sessionId, callId, revision }, at);
      return receipt;
    });
  }
  applyLearning(id, expected, { source, settings }, at) {
    return this.#transaction(() => {
      const batch = required(this.learning(id), "学习批次"), proposal = required(batch.proposal, "学习建议");
      if (proposal.revision !== expected.proposalRevision || proposal.hash !== expected.proposalHash) throw new Error("学习建议已变化，请重新查看");
      if (proposal.status === "applied") return proposal.receipt;
      if (proposal.status !== "pending" || !proposal.changes.length) throw new Error("此建议不能应用");
      const current = required(this.source(batch.sourceId), "来源");
      if (current.revision !== batch.baseSourceRevision || learningHash(this.settings()) !== batch.baseSettingsHash) throw new Error("来源或全局配置已变化，请重新整理建议");
      for (const entry of batch.cases.filter(entry => proposal.caseIds.includes(entry.id))) {
        const latest = this.#get("SELECT id,text FROM feedback_versions WHERE item_id=? ORDER BY revision DESC LIMIT 1", entry.itemId);
        if (latest?.id !== entry.feedbackId || !latest.text.trim() || this.#get("SELECT 1 FROM learned_feedback WHERE feedback_id=?", entry.feedbackId)) throw new Error("案例评价已修改或撤回，请重新整理建议");
      }
      const sourceChanged = proposal.changes.some(change => change.target === "source"), globalChanged = proposal.changes.some(change => change.target === "global");
      if (sourceChanged) {
        const saved = { ...current, ...source, revision: (current.revision ?? 0) + 1 };
        this.#run("UPDATE sources SET data=? WHERE id=?", json(saved), batch.sourceId);
        this.#invalidateSource(batch.sourceId);
      }
      if (globalChanged) {
        this.#run("UPDATE meta SET value=? WHERE key='settings'", json(settings));
        this.#invalidateGlobalGuidance(settings);
      }
      const covered = batch.cases.filter(entry => proposal.caseIds.includes(entry.id));
      for (const entry of covered) this.#run("INSERT OR IGNORE INTO learned_feedback VALUES(?,?,?)", entry.feedbackId, batch.id, proposal.revision);
      const receipt = { batchId: id, proposalRevision: proposal.revision, proposalHash: proposal.hash, learnedCount: covered.length, appliedAt: at };
      const applied = { ...proposal, status: "applied", receipt };
      this.#run("UPDATE learning_proposals SET status='applied',data=? WHERE batch_id=? AND revision=?", json(applied), id, proposal.revision);
      this.#writeLearning({ ...batch, status: "applied", appliedAt: at });
      this.#audit("learning.applied", receipt, at);
      return receipt;
    });
  }
  rejectLearning(id, expected, at) {
    return this.#transaction(() => {
      const batch = required(this.learning(id), "学习批次"), proposal = required(batch.proposal, "学习建议");
      if (proposal.revision !== expected.proposalRevision || proposal.hash !== expected.proposalHash) throw new Error("学习建议已变化，请重新查看");
      if (proposal.status === "rejected") return { ok: true };
      if (proposal.status !== "pending") throw new Error("此建议不能拒绝");
      this.#run("UPDATE learning_proposals SET status='rejected',data=? WHERE batch_id=? AND revision=?", json({ ...proposal, status: "rejected" }), id, proposal.revision);
      this.#writeLearning({ ...batch, status: "rejected" });
      this.#audit("learning.rejected", { batchId: id, revision: proposal.revision }, at);
      return { ok: true };
    });
  }
  async close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
    if (this.#lock) {
      await this.#lock.close();
      this.#lock = null;
      await unlink(join(this.directory, "owner.lock")).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
}
export {
  Store,
  pageQuery
};
