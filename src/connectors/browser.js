/** Browser transport is an explicit integration boundary, never an implicit cookie reader. */
export class BrowserConnector {
  constructor(platform, getBridge) { this.platform = platform; this.getBridge = getBridge; }
  status() {
    const bridge = this.getBridge();
    return bridge?.status?.(this.platform) ?? { ready: false, canPublish: false, reason: '浏览器账号尚未接入后台；不会读取 Chrome Cookie 文件或创建新凭据。' };
  }
  async fetch(source, options) {
    const bridge = this.getBridge();
    if (!bridge?.readSource) throw new Error('需要已授权的浏览器接入桥；当前只能验证本地流程，尚不能自动采集此来源。');
    return bridge.readSource(source, options);
  }
  async getItem(source, item, options) {
    const bridge = this.getBridge();
    if (!bridge?.readItem) throw new Error('浏览器接入桥不支持发布前内容校验');
    return bridge.readItem(source, item.remoteId, options);
  }
  async publish(source, item, draft, options) {
    const bridge = this.getBridge();
    if (!bridge?.publish || !this.status().canPublish) { const error = new Error('浏览器接入桥未获发布授权'); error.definitelyNotSent = true; throw error; }
    return bridge.publish(source, item, draft, options);
  }
}
