import { mkdir, open, readFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fresh = () => ({ version: 1, settings: {}, sources: {}, items: {}, drafts: {}, runs: {}, audit: [] });

/** Single-process, serialized transactions; persist before exposing the new state. */
export class Store {
  #state; #queue = Promise.resolve(); #lock;
  constructor(directory) { this.directory = directory; }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, 'owner.lock');
    try { this.#lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recovery = join(this.directory, 'lock-recovery');
      await mkdir(recovery).catch(() => { throw new Error('另一实例正在检查数据目录锁，请稍后重试。'); });
      try {
        let owner;
        try { owner = Number((await readFile(lockPath, 'utf8')).trim()); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (owner !== undefined) {
          if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('数据锁不完整；请确认没有运行中的实例后再清理 owner.lock。');
          try { process.kill(owner, 0); throw new Error('数据目录已有运行中的实例'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
          await unlink(lockPath);
        }
        this.#lock = await open(lockPath, 'wx', 0o600);
      } finally { await rmdir(recovery); }
    }
    await this.#lock.writeFile(`${process.pid}\n`); await this.#lock.sync();
    try {
      this.#state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      if (this.#state.version !== 1) throw new Error('不支持此数据版本');
    } catch (error) {
      if (error.code !== 'ENOENT') { await this.close(); throw error; }
      this.#state = fresh();
    }
    await this.change(state => {
      for (const draft of Object.values(state.drafts)) {
        if (draft.status === 'sending') { draft.status = 'unknown'; draft.error = '上次发送被中断，需核实远端结果。'; }
      }
      for (const run of Object.values(state.runs)) {
        if (run.status === 'running') { run.status = 'interrupted'; run.error = '进程中断；已发生的会话工作可追溯。'; }
      }
    });
    return this;
  }
  read() { return structuredClone(this.#state); }
  change(update) {
    const task = this.#queue.then(async () => {
      const next = structuredClone(this.#state);
      const result = await update(next);
      const temporary = join(this.directory, `state.${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      try { await rename(temporary, join(this.directory, 'state.json')); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      this.#state = next;
      return structuredClone(result);
    });
    this.#queue = task.catch(() => {});
    return task;
  }
  async close() {
    await this.#queue;
    if (this.#lock) {
      await this.#lock.close(); this.#lock = null;
      await unlink(join(this.directory, 'owner.lock')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
