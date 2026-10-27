const limitText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : value;
const textLength = value => typeof value === 'string' ? value.length : 0;
const fields = (value, names, limit = 512) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, limitText(value[name], limit)]));
const rowsOf = value => Array.isArray(value) ? value : [];

function discussionInput(rows, maxRows, maxCharacters) {
  const recent = rows.slice(-maxRows), texts = new Map();
  let remaining = maxCharacters, truncated = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    const body = limitText(recent[index].body ?? '', Math.min(2000, remaining));
    texts.set(index, body);
    remaining -= textLength(body);
    if (textLength(body) < textLength(recent[index].body)) truncated++;
  }
  return {
    rows: recent.map((row, index) => ({ ...fields(row, ['id', 'author', 'parent', 'path', 'updatedAt', 'state', 'commit']), body: texts.get(index) })),
    scope: { stored: rows.length, included: recent.length, truncatedBodies: truncated, maxBodyCharacters: maxCharacters, maxPerBodyCharacters: 2000 },
  };
}

export function githubContentInput(item) {
  const payload = item.payload ?? {};
  const content = fields(item, ['id', 'sourceId', 'remoteId', 'kind', 'title', 'url', 'version', 'changedAt']);
  content.body = limitText(item.body ?? '', 16000);
  const comments = discussionInput(rowsOf(payload.comments), 20, 12000);
  const projected = {
    ...fields(payload, ['number', 'state', 'author', 'merged', 'mergedAt', 'head', 'base', 'contextComplete', 'id', 'tag', 'prerelease', 'publishedAt']),
    ...(payload.contextLimit ? { collectionLimit: limitText(payload.contextLimit, 512) } : {}),
    ...(payload.labels ? { labels: rowsOf(payload.labels).slice(0, 40).map(label => limitText(label, 100)) } : {}),
    ...(payload.comments ? { comments: comments.rows } : {}),
    ...(payload.stateEvents ? { stateEvents: rowsOf(payload.stateEvents).slice(-20).map(row => fields(row, ['id', 'event', 'actor', 'createdAt'])) } : {}),
  };
  const scope = {
    kind: 'github-summary-v1',
    bodyCharacters: textLength(item.body), includedBodyCharacters: textLength(content.body),
    comments: comments.scope,
    stateEvents: { stored: rowsOf(payload.stateEvents).length, included: Math.min(rowsOf(payload.stateEvents).length, 20) },
    note: '这是当前内容的有界阅读摘要；未提供的正文、讨论和代码不能视为已读。原始采集数据保留在内容版本中，可用 dmc_read_item 分页读取 body、comments、comment。若用户要求委派 MBP 核查，先按该要求委派，不必自行读取全部代码。',
  };
  if (item.kind === 'pr') {
    const files = rowsOf(payload.files), reviewComments = discussionInput(rowsOf(payload.reviewComments), 20, 12000), reviews = discussionInput(rowsOf(payload.reviews), 10, 6000);
    projected.files = files.slice(0, 40).map(file => ({ ...fields(file, ['status', 'additions', 'deletions', 'changes']), filename: limitText(file.path ?? file.filename ?? '', 512), ...(file.previousPath ? { previousFilename: limitText(file.previousPath, 512) } : {}), patchAvailable: typeof file.patch === 'string' }));
    projected.reviewComments = reviewComments.rows;
    projected.reviews = reviews.rows;
    scope.files = { stored: files.length, included: projected.files.length, patchesIncluded: false, diffIncluded: false, reviewCommentDiffsIncluded: false };
    scope.reviewComments = reviewComments.scope;
    scope.reviews = reviews.scope;
    scope.note += ' PR 文件仅给出前40项概要，不包含文件 patch、diff 或审查评论的 diff。需要更多文件时用 dmc_read_item({section:"files",page:1,pageSize:20})；需要某文件已采集 patch 时用 dmc_read_item({section:"file",filePath:"返回的 filename",offset:0,length:16000})。历史摘要需同时传入本摘要的 version；工具只读取已采集版本，不代替远端核验或运行测试。';
  }
  if (item.previous) {
    content.previous = fields(item.previous, ['title', 'version']);
    scope.previousBodyOmitted = textLength(item.previous.body) > 0;
  }
  content.payload = projected;
  content.modelScope = scope;
  return content;
}

export function compactOrganizationMessage(message) {
  if (message?.role !== 'user' || message.source?.kind !== 'dsh-message-console' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map(part => {
    if (part.type !== 'text' || typeof part.text !== 'string') return part;
    let document;
    try { document = JSON.parse(part.text); } catch { return part; }
    if (!Array.isArray(document?.input?.blocks)) return part;
    let projected = false;
    const blocks = document.input.blocks.map(block => {
      if (block?.key !== 'content' || !['issue', 'pr', 'release'].includes(block.value?.kind) || block.value.modelScope?.kind === 'github-summary-v1') return block;
      projected = true;
      return { ...block, value: githubContentInput(block.value) };
    });
    if (!projected) return part;
    changed = true;
    return { ...part, text: JSON.stringify({ ...document, input: { ...document.input, blocks } }, null, 2) };
  });
  return changed ? { ...message, content } : message;
}
