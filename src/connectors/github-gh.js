import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubConnector } from './github.js';

const execute = promisify(execFile);
export class GitHubGhConnector {
  #connection = { ready: false, canPublish: false, identity: null, access: 'gh', reason: '尚未验证服务器 gh 的 GitHub 登录身份' };
  constructor({ request = fetch, run = execute, timeoutMs = 30_000, maxPages = 100 } = {}) {
    Object.assign(this, { request, run, timeoutMs, maxPages });
  }
  status() { return { ...this.#connection }; }
  async #client(signal) {
    let token;
    try {
      const result = await this.run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: Math.min(this.timeoutMs, 10_000), maxBuffer: 8192, encoding: 'utf8', ...(signal ? { signal } : {}) });
      token = result.stdout.trim();
      if (!token || token.length > 4096 || /\s/.test(token)) throw new Error();
    } catch {
      throw new Error('无法读取服务器 gh 的 github.com 授权；请在 DSH 运行用户下检查 gh auth status --hostname github.com');
    }
    const client = new GitHubConnector({ timeoutMs: this.timeoutMs, maxPages: this.maxPages, request: async (url, options) => {
      if (new URL(url).origin !== 'https://api.github.com' || options.method !== 'GET') throw new Error('gh 连接器仅支持 GitHub API 只读请求');
      try { return await this.request(url, { ...options, redirect: 'error', headers: { ...options.headers, Authorization: `Bearer ${token}` } }); }
      catch { throw new Error('GitHub 授权请求网络失败、超时或发生跳转，请稍后重试'); }
    } });
    const { data } = await client.call('/user', { signal });
    if (typeof data.login !== 'string' || !/^[a-z\d-]{1,39}$/i.test(data.login)) throw new Error('GitHub 未返回有效的 gh 登录身份');
    this.#connection = { ready: true, canPublish: false, identity: { name: data.login }, access: 'gh', reason: `已复用服务器 gh 授权：${data.login}，仅采集` };
    client.identity = data.login;
    return client;
  }
  async #read(work, signal) {
    try { return await work(await this.#client(signal)); }
    catch (error) {
      this.#connection = { ready: false, canPublish: false, identity: null, access: 'gh', reason: error.message };
      throw error;
    }
  }
  async connect() { try { await this.#read(async () => {}); } catch {} return this.status(); }
  fetch(source, options = {}) { return this.#read(async client => ({ ...await client.fetch(source, options), metadata: { access: 'gh', identity: client.identity } }), options.signal); }
  metadata(source, options = {}) { return this.#read(async client => ({ ...await client.metadata(source, options), access: 'gh' }), options.signal); }
  getItem(source, item, options = {}) { return this.#read(client => client.getItem(source, item, options), options.signal); }
  async publish() { const error = new Error('gh 连接器仅采集，未启用 GitHub 发布'); error.definitelyNotSent = true; throw error; }
}
