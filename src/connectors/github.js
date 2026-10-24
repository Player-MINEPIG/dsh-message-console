const ROOT = 'https://api.github.com';
export class GitHubConnector {
  constructor({ request = fetch, account = null, maxPages = 100, timeoutMs = 30_000 } = {}) { Object.assign(this, { request, account, maxPages, timeoutMs }); }
  status() { return { ready: true, canPublish: Boolean(this.account), access: this.account ? 'account' : 'public', reason: this.account ? '已连接授权账号' : '已明确使用匿名模式，仅公开仓库读取' }; }
  async call(path, { signal, method = 'GET', body, accept = 'application/vnd.github+json', redirect } = {}) {
    const url = new URL(path, ROOT);
    if (url.origin !== ROOT || url.username || url.password) throw new Error('拒绝跨站 GitHub API 请求');
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const response = await this.request(url.href, { method, signal, ...(redirect?{redirect}:{}), headers: { Accept: accept, 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
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
    let data;
    try { data = await response.json(); } catch { throw new Error('GitHub 响应不是有效 JSON，未推进采集基线'); }
    return { data, link: response.headers.get('link') };
  }
  async metadata(source,options={}) {
    const {data}=await this.call(`/repos/${source.target}`,{...options,redirect:'error'});
    if(data.full_name?.toLowerCase()!==source.target.toLowerCase()||typeof data.description!=='string'&&data.description!==null)throw new Error('GitHub仓库元信息结构不完整或目标不匹配');
    return {name:data.full_name,description:data.description??'',tags:[...(Array.isArray(data.topics)?data.topics:[]),...(typeof data.language==='string'?[data.language]:[])],access:'public'};
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
      for (const row of releases) items.push({ remoteId: `release:${row.id}`, kind: 'release', title: row.name || row.tag_name, body: row.body ?? '', url: row.html_url, updatedAt: row.updated_at ?? row.published_at ?? row.created_at, payload: { id: String(row.id), tag: row.tag_name, prerelease: row.prerelease, publishedAt: row.published_at } });
    }
    return { complete: true, items };
  }
  async readDiscussion(source, number, kind, { signal, issue } = {}) {
    const prefix = `/repos/${source.target}`;
    const row = issue ?? (await this.call(`${prefix}/issues/${number}`, { signal })).data;
    const comments = await this.pages(`${prefix}/issues/${number}/comments?per_page=100`, { signal });
    const payload = { number, state: String(row.state).toLowerCase(), author: row.user?.login, labels: (row.labels ?? []).map(label => typeof label === 'string' ? label : label.name).sort(), comments: comments.map(comment => ({ id: String(comment.id), author: comment.user?.login, body: comment.body, updatedAt: comment.updated_at })) };
    const events = await this.pages(`${prefix}/issues/${number}/events?per_page=100`, { signal });
    const stateEvents = events.filter(event => ['closed', 'reopened', 'merged'].includes(event.event)).map(event => ({ id: String(event.id), event: event.event, actor: event.actor?.login ?? null, createdAt: event.created_at }));
    if (stateEvents.length) payload.stateEvents = stateEvents;
    let updatedAt = row.updated_at ?? row.created_at;
    if (kind === 'pr') {
      const pr = (await this.call(`${prefix}/pulls/${number}`, { signal })).data;
      payload.state = pr.merged || pr.merged_at ? 'merged' : String(pr.state).toLowerCase();
      payload.merged = Boolean(pr.merged || pr.merged_at);
      payload.mergedAt = pr.merged_at ?? null;
      const files = await this.pages(`${prefix}/pulls/${number}/files?per_page=100`, { signal });
      payload.contextComplete = !(pr.changed_files > files.length || files.length >= 3000);
      const reviewComments = await this.pages(`${prefix}/pulls/${number}/comments?per_page=100`, { signal });
      const reviews = await this.pages(`${prefix}/pulls/${number}/reviews?per_page=100`, { signal });
      payload.head = pr.head.sha; payload.base = pr.base.sha;
      payload.files = files.map(file => ({ path: file.filename, previousPath: file.previous_filename, status: file.status, patch: file.patch ?? null, additions: file.additions, deletions: file.deletions }));
      payload.contextLimit = payload.contextComplete ? '仅提供变更patch与讨论；没有patch的文件无法审查，不代表已检查完整仓库或运行测试。' : 'PR 文件列表超出 GitHub API 上限或文件未取完整，仅保留已采集内容及状态，不执行自动审查。';
      payload.reviewComments = reviewComments.map(comment => ({ id: String(comment.id), parent: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null, author: comment.user?.login, body: comment.body, path: comment.path, diff: comment.diff_hunk, updatedAt: comment.updated_at }));
      payload.reviews = reviews.map(review => ({ id: String(review.id), author: review.user?.login, body: review.body, state: review.state, commit: review.commit_id }));
      const latest = (await this.call(`${prefix}/pulls/${number}`, { signal })).data;
      if (latest.head.sha !== payload.head || (latest.merged || latest.merged_at ? 'merged' : String(latest.state).toLowerCase()) !== payload.state) throw new Error('采集期间PR提交或状态发生变化，请重新抓取');
      updatedAt = latest.updated_at ?? pr.updated_at ?? updatedAt;
    }
    return { remoteId: `${kind}:${row.id}`, kind, title: row.title, body: row.body ?? '', url: row.html_url, updatedAt, payload };
  }
  async getItem(source, item, options) {
    if (item.kind === 'release') {
      const { data: row } = await this.call(`/repos/${source.target}/releases/tags/${encodeURIComponent(item.payload.tag)}`, options);
      return { remoteId: `release:${row.id}`, kind: 'release', title: row.name || row.tag_name, body: row.body ?? '', url: row.html_url, updatedAt: row.updated_at ?? row.published_at ?? row.created_at, payload: { id: String(row.id), tag: row.tag_name, prerelease: row.prerelease, publishedAt: row.published_at } };
    }
    return this.readDiscussion(source, item.payload.number, item.kind, options);
  }
  async publish(source, item, draft, { actionId }) {
    if (!this.account) { const error = new Error('GitHub 未连接可发布账号'); error.definitelyNotSent = true; throw error; }
    const body = `${draft.body}\n\n<!-- dsh-message-console:${actionId} -->`;
    const path = item.kind === 'pr' ? `/repos/${source.target}/pulls/${item.payload.number}/reviews` : `/repos/${source.target}/issues/${item.payload.number}/comments`;
    const { data } = await this.call(path, { method: 'POST', body: item.kind === 'pr' ? { commit_id: item.payload.head, body, event: 'COMMENT' } : { body } });
    return { remoteId: String(data.id), url: data.html_url ?? item.url };
  }
}
