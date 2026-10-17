const ROOT = 'https://api.github.com';
export class GitHubConnector {
  constructor({ request = fetch, account = null, maxPages = 100, timeoutMs = 30_000 } = {}) { Object.assign(this, { request, account, maxPages, timeoutMs }); }
  status() { return { ready: true, canPublish: Boolean(this.account), reason: this.account ? '已连接授权账号' : '仅公开仓库读取；Chrome 网页登录尚未桥接到后台 API' }; }
  async call(path, { signal, method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
    const url = new URL(path, ROOT);
    if (url.origin !== ROOT) throw new Error('拒绝跨站 GitHub API 请求');
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const response = await this.request(url.href, { method, signal, headers: { Accept: accept, 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      const error = new Error(`GitHub 请求失败 (${response.status})`);
      if ([403,429].includes(response.status)) {
        const retry = Number(response.headers.get('retry-after'));
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
        error.retryMs = Math.max(60_000, retry > 0 ? retry * 1000 : response.headers.get('x-ratelimit-remaining') === '0' ? reset : 60_000);
      }
      error.definitelyNotSent = method !== 'GET' && [400,401,403,404,422,429].includes(response.status);
      throw error;
    }
    const data = await response.json();
    return { data, link: response.headers.get('link') };
  }
  async pages(path, options) {
    let next = path; const data = [];
    for (let page = 0; next; page++) {
      if (page >= this.maxPages) throw new Error('GitHub 分页超出本轮上限，未建立不完整基线');
      const response = await this.call(next, options);
      if (!Array.isArray(response.data)) throw new Error('GitHub 分页响应无效');
      data.push(...response.data);
      next = response.link?.split(',').map(part => part.match(/<([^>]+)>;\s*rel="next"/)).find(Boolean)?.[1];
    }
    return data;
  }
  async fetch(source, { signal } = {}) {
    const prefix = `/repos/${source.target}`; const items = [];
    if (source.types.some(type => ['issue','pr'].includes(type))) {
      const rows = await this.pages(`${prefix}/issues?state=all&sort=updated&direction=desc&per_page=100`, { signal });
      for (const row of rows) {
        const kind = row.pull_request ? 'pr' : 'issue';
        if (source.types.includes(kind)) items.push(await this.readDiscussion(source, row.number, kind, { signal, issue: row }));
      }
    }
    if (source.types.includes('release')) {
      const releases = await this.pages(`${prefix}/releases?per_page=100`, { signal });
      for (const row of releases) items.push({ remoteId: `release:${row.id}`, kind: 'release', title: row.name || row.tag_name, body: row.body ?? '', url: row.html_url, payload: { id: String(row.id), tag: row.tag_name, prerelease: row.prerelease, publishedAt: row.published_at } });
    }
    return { complete: true, items };
  }
  async readDiscussion(source, number, kind, { signal, issue } = {}) {
    const prefix = `/repos/${source.target}`;
    const row = issue ?? (await this.call(`${prefix}/issues/${number}`, { signal })).data;
    const comments = await this.pages(`${prefix}/issues/${number}/comments?per_page=100`, { signal });
    const payload = { number, state: row.state, author: row.user?.login, labels: (row.labels ?? []).map(label => typeof label === 'string' ? label : label.name).sort(), comments: comments.map(comment => ({ id: String(comment.id), author: comment.user?.login, body: comment.body, updatedAt: comment.updated_at })) };
    if (kind === 'pr') {
      const pr = (await this.call(`${prefix}/pulls/${number}`, { signal })).data;
      const files = await this.pages(`${prefix}/pulls/${number}/files?per_page=100`, { signal });
      if (pr.changed_files > files.length || files.length >= 3000) throw new Error('PR 文件上下文不完整，不能执行完整审查');
      const reviewComments = await this.pages(`${prefix}/pulls/${number}/comments?per_page=100`, { signal });
      const reviews = await this.pages(`${prefix}/pulls/${number}/reviews?per_page=100`, { signal });
      payload.head = pr.head.sha; payload.base = pr.base.sha;
      payload.files = files.map(file => ({ path: file.filename, previousPath: file.previous_filename, status: file.status, patch: file.patch ?? null, additions: file.additions, deletions: file.deletions }));
      payload.contextLimit = '仅提供变更patch与讨论；没有patch的文件无法审查，不代表已检查完整仓库或运行测试。';
      payload.reviewComments = reviewComments.map(comment => ({ id: String(comment.id), parent: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null, author: comment.user?.login, body: comment.body, path: comment.path, diff: comment.diff_hunk, updatedAt: comment.updated_at }));
      payload.reviews = reviews.map(review => ({ id: String(review.id), author: review.user?.login, body: review.body, state: review.state, commit: review.commit_id }));
      const latest = (await this.call(`${prefix}/pulls/${number}`, { signal })).data;
      if (latest.head.sha !== payload.head) throw new Error('采集期间PR提交发生变化，请重新抓取');
    }
    return { remoteId: `${kind}:${row.id}`, kind, title: row.title, body: row.body ?? '', url: row.html_url, payload };
  }
  getItem(source, item, options) { return this.readDiscussion(source, item.payload.number, item.kind, options); }
  async publish(source, item, draft, { actionId }) {
    if (!this.account) { const error = new Error('GitHub 未连接可发布账号'); error.definitelyNotSent = true; throw error; }
    const body = `${draft.body}\n\n<!-- dsh-message-console:${actionId} -->`;
    const path = item.kind === 'pr' ? `/repos/${source.target}/pulls/${item.payload.number}/reviews` : `/repos/${source.target}/issues/${item.payload.number}/comments`;
    const { data } = await this.call(path, { method: 'POST', body: item.kind === 'pr' ? { commit_id: item.payload.head, body, event: 'COMMENT' } : { body } });
    return { remoteId: String(data.id), url: data.html_url ?? item.url };
  }
}
