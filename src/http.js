import { fingerprint } from './core.js';
const ROOT = '/api/dsh-message-console';

async function jsonBody(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) throw new Error('请求过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function createHandler(service, admission) {
  return async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const accepted = admission(req);
      if (!accepted || 'rejection' in accepted) return send(accepted?.rejection ?? 403, { error: '宿主认证未通过' });
      const url = new URL(req.url, 'http://local');
      const path = url.pathname.slice(ROOT.length).split('/').filter(Boolean).map(decodeURIComponent);
      if (!url.pathname.startsWith(`${ROOT}/`)) return send(404, { error: '路径不存在' });
      if (req.method === 'GET' && path.join('/') === 'session-directory') return send(200, service.sessionDirectory());
      if (req.method === 'GET' && path.join('/') === 'catalog') return send(200, await service.catalog());
      if (req.method === 'GET' && path[0] === 'catalog' && path[1] === 'models' && path.length === 3) return send(200, await service.models(path[2]));
      if (req.method === 'GET' && path.join('/') === 'workspaces') return send(200, await service.workspaces.list());
      if (req.method === 'GET' && path.join('/') === 'state') {
        const view = service.view();
        for (const draft of view.drafts) draft.bodyHash = fingerprint(draft.body);
        return send(200, view);
      }
      if (req.method !== 'POST') return send(405, { error: '不支持此方法' });
      if (req.headers['x-dsh-message-console'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '请求来源校验失败' });
      const body = await jsonBody(req); let result = { ok: true };
      if (path[0] === 'settings' && path.length === 1) await service.configure(body);
      else if (path.join('/') === 'sources/suggest') result = await service.suggestSource(body);
      else if (path.join('/') === 'sources/preview') result = await service.previewInput(body);
      else if (path[0] === 'sources' && path.length === 1) result = await service.saveSource(body);
      else if (path[0] === 'sources' && path.length === 2) result = await service.saveSource(body, path[1]);
      else if (path[0] === 'sources' && path[2] === 'refresh') result = await service.refresh(path[1]);
      else if (path[0] === 'sources' && path[2] === 'organize') result = await service.organize(path[1], { scope: 'history' });
      else if (path[0] === 'items' && path[2] === 'read') await service.markRead(path[1], body.version);
      else if (path[0] === 'items' && path[2] === 'handling') await service.setHandling(path[1], body.handling);
      else if (path[0] === 'items' && path[2] === 'conversation') result = await service.openConversation(path[1]);
      else if (path[0] === 'drafts' && path[2] === 'publish') result = await service.approveAndPublish(path[1], body);
      else if (path[0] === 'drafts' && path[2] === 'dismiss') await service.dismissDraft(path[1]);
      else return send(404, { error: '操作不存在' });
      return send(200, result);
    } catch (error) { return send(400, { error: String(error.publicMessage ?? error.message).slice(0,1000) }); }
  };
}
