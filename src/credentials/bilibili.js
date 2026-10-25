import { mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CookieTransport } from '../connectors/cookies.js';
import { BilibiliConnector } from '../connectors/bilibili.js';
import { credentialError } from './index.js';

const names = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4', 'buvid_fp', 'b_nut']);
export function parseBilibiliCookie(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 32768 || /[\x00-\x1f\x7f]/.test(input)) throw credentialError('请粘贴有效的单行 Cookie，最多 32 KiB');
  const rows = new Map();
  for (const part of input.trim().replace(/^Cookie:\s*/i, '').split(';')) {
    const index = part.indexOf('='), name = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (index < 1 || !names.has(name)) continue;
    if (!value || /[^\x21-\x7e]/.test(value) || rows.has(name)) throw credentialError('登录 Cookie 为空、重复或格式无效');
    rows.set(name, { name, value, domain: '.bilibili.com', path: '/', expires: 0, secure: true });
  }
  if (!rows.has('SESSDATA') || !rows.has('bili_jct')) throw credentialError('Cookie 必须包含 SESSDATA 和 bili_jct');
  return [...rows.values()];
}
export class BilibiliCredentials {
  constructor({ file, connectors, legacyFile, request = fetch, sources = () => [] }) {
    Object.assign(this, { file, connectors, legacyFile, request, sources });
    this.status = { ready: false, message: '尚未验证登录状态' };
  }
  async initialize() {
    let managed = false;
    try { await stat(this.file); managed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (managed || this.legacyFile) this.activate(managed ? this.file : this.legacyFile);
  }
  activate(file, identity) {
    const transport = new CookieTransport({ cookieFile: file, request: this.request });
    if (identity) transport.identities.bilibili = identity;
    this.connectors.bilibili = new BilibiliConnector(transport);
    this.status = { ready: Boolean(identity), identity: identity ?? null, message: identity ? '登录验证成功' : '已有 Cookie，点击验证登录检查有效性' };
  }
  describe() {
    return { title: 'B 站', description: '粘贴浏览器请求中的 Cookie（含 SESSDATA 和 bili_jct）。保存前验证账号，保存后立即生效；凭据不会回显。普通网页无法直接读取 B 站 Cookie。', status: this.status,
      fields: [{ id: 'cookie', label: 'Cookie', type: 'secret', required: true, placeholder: 'SESSDATA=…; bili_jct=…' }],
      actions: [{ id: 'save', label: '验证并保存', fields: true }, { id: 'verify', label: '验证登录' }] };
  }
  checkIdentity(identity) {
    if (this.sources().some(source => source.platform === 'bilibili' && source.accountId && source.accountId !== identity.id)) throw credentialError('此账号与已有私信来源绑定的账号不同，请使用原账号 Cookie');
  }
  async act(action, values) {
    if (action === 'verify') {
      try {
        const identity = await this.connectors.bilibili.identity();
        this.checkIdentity(identity);
        this.status = { ready: true, identity, message: '登录验证成功' };
      } catch (error) {
        this.status = { ready: false, identity: null, message: error.publicMessage || '登录验证失败，请更新 Cookie 或稍后重试' };
        throw credentialError(this.status.message);
      }
      return;
    }
    const rows = parseBilibiliCookie(values.cookie);
    const directory = dirname(this.file), temporary = `${this.file}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, platforms: { bilibili: rows } }), { mode: 0o600, flag: 'wx' });
      const candidate = new BilibiliConnector(new CookieTransport({ cookieFile: temporary, request: this.request, intervalMs: 0 }));
      let identity;
      try { identity = await candidate.identity(); } catch { throw credentialError('Cookie 验证失败，原凭据未修改；请检查有效期和网络'); }
      this.checkIdentity(identity);
      await rename(temporary, this.file);
      this.activate(this.file, identity);
    } finally { await rm(temporary, { force: true }); }
  }
}
