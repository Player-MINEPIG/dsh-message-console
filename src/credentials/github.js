import { spawn } from 'node:child_process';
import { credentialError } from './index.js';

export class GitHubCredentials {
  constructor(connector, { launch = spawn, environment = process.env, timeoutMs = 10 * 60_000 } = {}) {
    Object.assign(this, { connector, launch, environment, timeoutMs });
    this.login = { state: 'idle' };
  }
  busy() { return Boolean(this.child); }
  describe() {
    const enabled = typeof this.connector.connect === 'function';
    const status = this.connector.status();
    return { title: 'GitHub', description: enabled ? '复用服务器 gh 登录。点击登录后，在 GitHub 输入设备验证码并授权。完成后更新 DSH 运行用户的 gh 身份；令牌由 gh 保存，页面不接收令牌。服务器无系统凭据库时 gh 使用本地文件保存。' : '当前配置为公开匿名采集；请先在宿主配置中将 githubAuth 设为 gh。',
      fields: [], status: { ready: status.ready, identity: status.identity, message: status.reason }, login: { ...this.login },
      actions: !enabled ? [] : this.child ? [{ id: 'cancel', label: '取消登录' }] : [{ id: 'login', label: '登录 GitHub' }, { id: 'verify', label: '验证登录' }] };
  }
  async act(action) {
    if (action === 'verify') { await this.connector.connect(); return; }
    if (action === 'cancel') { this.stop('cancelled'); return; }
    if (this.child) return;
    if (this.environment.GH_TOKEN || this.environment.GITHUB_TOKEN) throw credentialError('服务器正通过环境变量提供 GitHub 身份，无法用网页登录替换；请由服务器管理者调整');
    this.login = { state: 'starting', message: '正在获取设备验证码…' };
    let child;
    try { child = this.launch('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...this.environment, GH_BROWSER: '/usr/bin/true', BROWSER: '/usr/bin/true', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    }); } catch {
      this.login = { state: 'failed', message: '无法启动 gh，请检查服务器安装及权限' };
      throw credentialError(this.login.message);
    }
    this.child = child;
    let buffer = '';
    const read = chunk => {
      if (!['starting', 'waiting'].includes(this.login.state)) return;
      buffer = (buffer + chunk.toString('utf8')).slice(-4096);
      const code = buffer.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
      if (code) { this.login = { state: 'waiting', code, url: 'https://github.com/login/device', message: '在 GitHub 输入验证码并完成授权。此页会自动更新结果。' }; buffer = ''; }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    this.completion = new Promise(resolve => {
      child.once('error', () => { this.login = { state: 'failed', message: '无法启动 gh，请检查服务器安装及权限' }; });
      child.once('close', async code => {
        clearTimeout(this.timer); clearTimeout(this.killTimer); buffer = '';
        try {
          if (['starting', 'waiting'].includes(this.login.state)) {
            const status = code === 0 ? await this.connector.connect() : null;
            this.login = status?.ready ? { state: 'complete', message: 'GitHub 登录成功' } : { state: 'failed', message: '登录未完成或验证失败，请重试' };
          }
        } catch { this.login = { state: 'failed', message: '登录后验证失败，请重试' }; }
        finally { this.child = null; resolve(); }
      });
    });
    this.timer = setTimeout(() => this.stop('expired'), this.timeoutMs); this.timer.unref?.();
  }
  stop(state) {
    if (!this.child) return;
    this.login = { state, message: state === 'expired' ? '登录已超时，请重新发起' : '已取消登录；若已在 GitHub 完成授权，请验证当前登录' };
    const child = this.child; child.kill('SIGTERM');
    this.killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); this.killTimer.unref?.();
  }
  async close() { this.stop('cancelled'); await this.completion; }
}
