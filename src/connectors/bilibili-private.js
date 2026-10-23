const positiveId = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  throw new Error('B站私信标识或序号无效');
};
const timestamp = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('B站私信时间无效');
  return new Date(number * 1000).toISOString();
};
function message(row, accountId, talkerId, name) {
  const id = positiveId(row.msg_seqno), sender = positiveId(row.sender_uid);
  const receiver=positiveId(row.receiver_id);
  if(Number(row.receiver_type)!==1||!(sender===talkerId&&receiver===accountId||sender===accountId&&receiver===talkerId))throw new Error('B站私信收发账号与会话不匹配');
  const withdrawn = Number(row.msg_status) === 1;
  let content;
  if(!withdrawn)try { content = JSON.parse(row.content); } catch { throw new Error('B站私信正文结构无效'); }
  const type = Number(row.msg_type);
  if (!Number.isSafeInteger(type)) throw new Error('B站私信类型无效');
  const text = typeof content?.content === 'string' ? content.content : '';
  const cardText = [content?.title, content?.text].filter(value => typeof value === 'string').join('\n');
  const body = withdrawn ? '[消息已撤回]' : type === 1 ? text : `${cardText}${cardText ? '\n' : ''}[${type === 2 ? '图片' : '非文字消息'}，仅保存平台原文与元信息，模型未查看媒体]`;
  return { id, authorId: sender, author: sender === accountId ? '我' : name, direction: sender === accountId ? 'outgoing' : 'incoming', createdAt: timestamp(row.timestamp), type, messageType:withdrawn?'withdrawn':type===1?'text':type===2?'image':type===10?'card':'other', withdrawn, body, ...(!withdrawn ? { rawContent: row.content } : {}) };
}
const hasMore = data => {
  if (![0,1,false,true].includes(data?.has_more)) throw new Error('B站私信分页缺少结束标识');
  return Boolean(data.has_more);
};
export async function fetchPrivateMessages(connector, source, options) {
  if (!source.accountId) throw new Error('私信来源尚未绑定账号，请重新保存来源');
  const identity = await connector.identity(options);
  if (identity.id !== source.accountId) throw new Error('B站登录账号与私信来源绑定账号不一致，请恢复原账号Cookie');
  const call = (path, params) => connector.transport.json('bilibili', `https://api.vc.bilibili.com${path}?${new URLSearchParams({ ...params, mobi_app: 'web' })}`, options);
  const sessions = new Map();
  let cursor, complete = false;
  for (let page = 0; page < connector.maxPages; page++) {
    const data = await call('/session_svr/v1/session_svr/get_sessions', { session_type: '1', group_fold: '1', unfollow_fold: '0', sort_rule: '2', size: '100', ...(cursor ? { end_ts: cursor } : {}) });
    if (!Array.isArray(data?.session_list) && data?.session_list !== null) throw new Error('B站私信会话分页结构无效');
    const rows = data.session_list ?? [];
    for (const row of rows) {
      if (Number(row.session_type) !== 1) throw new Error('B站私信会话类型无效');
      const id = positiveId(row.talker_id);
      if (!sessions.has(id)) sessions.set(id, row);
    }
    if (!hasMore(data)) { complete = true; break; }
    const next = Math.min(...rows.map(row => Number(row.session_ts)));
    if (!Number.isSafeInteger(next) || next <= 0 || cursor && next >= Number(cursor)) throw new Error('B站私信会话分页没有推进');
    cursor = String(next);
  }
  if (!complete) throw new Error('B站私信会话超过分页上限，本轮未完成');
  const items = [];
  for (const [talkerId, session] of sessions) {
    const remoteId = `private-message:${talkerId}`;
    const previous = await options.readPreviousItem?.(remoteId);
    const oldMessages = previous?.payload?.comments ?? [];
    const known = oldMessages.reduce((max,row)=>Math.max(max,Number(row.id)),0);
    const knownIds=new Set(oldMessages.map(row=>row.id));
    let name = session.account_info?.name || previous?.payload?.contact?.name;
    if (!name) {
      try { const card = await connector.call('/x/web-interface/card', { mid: talkerId }, options); name = card?.card?.name; }
      catch (error) { if (options.signal?.aborted) throw error; }
    }
    name = typeof name === 'string' && name.trim() ? name : `UID ${talkerId}`;
    const messages = new Map(oldMessages.map(row => [row.id, row]));
    let end, done = false, reachedKnown = false;
    for (let page = 0; page < connector.maxPages; page++) {
      const data = await call('/svr_sync/v1/svr_sync/fetch_session_msgs', { talker_id: talkerId, session_type: '1', size: '100', ...(end ? { end_seqno: end } : {}) });
      if (!Array.isArray(data?.messages) && data?.messages !== null) throw new Error('B站私信消息分页结构无效');
      const more=hasMore(data);
      if(more&&!(data.messages?.length))throw new Error('B站私信分页为空但尚未结束');
      const rows = (data.messages ?? []).map(row => message(row, source.accountId, talkerId, name));
      for (const row of rows) messages.set(row.id, row);
      if(new Set(rows.map(row=>row.id)).size!==rows.length||end&&rows.some(row=>Number(row.id)>=Number(end)))throw new Error('B站私信消息分页重复或游标方向无效');
      reachedKnown = rows.some(row => knownIds.has(row.id));
      const crossedKnown=rows.some(row=>Number(row.id)<=known);
      if (!known || reachedKnown || crossedKnown || !more) { done = true; break; }
      const next = Math.min(...rows.map(row => Number(row.id)));
      if (!Number.isSafeInteger(next) || next <= 0 || end && next >= Number(end)) throw new Error('B站私信消息分页没有推进');
      end = String(next);
    }
    if (!done) throw new Error('B站私信增量超过分页上限，本轮未推进基线');
    const comments = [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id));
    if (!comments.length) continue;
    const collection = previous?.payload?.collection ?? { initialLimit: 100, note: '首见仅采集最近100条，后续累积新增消息；不代表平台完整历史。' };
    items.push({ remoteId, kind: 'private-message', title: `与 ${name} 的私信`, body: `${comments.at(-1).author}：${comments.at(-1).body}`, url: `https://message.bilibili.com/#/whisper/mid${talkerId}`, updatedAt: comments.at(-1).createdAt, payload: { accountId: source.accountId, contact: { id: talkerId, name }, collection, comments, ...((known && !reachedKnown) || previous?.payload?.visibilityLimit ? { visibilityLimit: '曾有已知水位在平台当前可见消息中不可见；本地旧消息保留，不能证明跨缺口完整。' } : {}) } });
  }
  return { complete: true, items, metadata: { accountId: source.accountId, conversations: sessions.size, collection: '初次最近100条，后续增量累积；未调用已读接口。' } };
}
