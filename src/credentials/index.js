export class PlatformCredentials {
  constructor(adapters, { assertIdle = () => {} } = {}) {
    this.adapters = new Map(Object.entries(adapters));
    this.assertIdle = assertIdle;
    this.pending = false;
  }
  busy() { return this.pending || [...this.adapters.values()].some(adapter => adapter.busy?.()); }
  list() { return { platforms: [...this.adapters].map(([id, adapter]) => ({ id, ...adapter.describe() })) }; }
  async act(platform, action, values = {}) {
    if (this.closed) throw new Error('凭据服务已关闭');
    const adapter = this.adapters.get(platform);
    if (!adapter || !adapter.describe().actions.some(entry => entry.id === action)) throw new Error('不支持此凭据操作');
    if (this.pending || this.busy() && action !== 'cancel') throw new Error('凭据操作正在进行，请稍后重试');
    this.assertIdle();
    this.pending = true;
    try { this.operation = Promise.resolve().then(() => adapter.act(action, values)); await this.operation; return this.list(); }
    catch (error) { throw new Error(error.publicMessage || '凭据操作失败；请检查登录信息、服务器权限和网络后重试'); }
    finally { this.pending = false; }
  }
  async close() { this.closed = true; await this.operation?.catch(() => {}); await Promise.all([...this.adapters.values()].map(adapter => adapter.close?.())); }
}
export function credentialError(message) { const error = new Error(message); error.publicMessage = message; return error; }
