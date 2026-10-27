import test from 'node:test';
import assert from 'node:assert/strict';
import { contentInput, assembleInput, serializeInput } from '../src/input-assembly.js';
import { compactOrganizationMessage } from '../src/github-input.js';

function largePullRequest() {
  return {
    id: 'pr-item', kind: 'pr', title: 'Large change', version: 'v2', body: '正文'.repeat(100000),
    previous: { version: 'v1', title: 'Earlier change', body: 'OLD_FULL_BODY'.repeat(100000) },
    payload: {
      number: 10, state: 'open', author: 'author', head: 'head-sha', base: 'base-sha', contextComplete: true,
      files: Array.from({ length: 430 }, (_, index) => ({ path: `src/file-${index}.js`, status: 'modified', additions: 10, deletions: 2, patch: 'PATCH_NOT_IN_PROMPT'.repeat(500) })),
      diff: 'FULL_DIFF_NOT_IN_PROMPT'.repeat(100000),
      comments: Array.from({ length: 500 }, (_, index) => ({ id: String(index), author: 'reader', body: `COMMENT-${index}:` + '讨论'.repeat(10000) })),
      reviews: Array.from({ length: 100 }, (_, index) => ({ id: String(index), author: 'reviewer', body: 'REVIEW'.repeat(10000), state: 'CHANGES_REQUESTED', commit: 'head-sha' })),
      reviewComments: Array.from({ length: 100 }, (_, index) => ({ id: String(index), author: 'reviewer', path: `src/file-${index}.js`, body: 'DISCUSSION'.repeat(10000), diff: 'REVIEW_DIFF_NOT_IN_PROMPT'.repeat(10000) })),
      stateEvents: Array.from({ length: 100 }, (_, index) => ({ id: String(index), event: 'reopened', actor: 'owner', createdAt: '2026-10-27T00:00:00Z' })),
    },
  };
}

test('large PR input contains bounded summaries and on-demand references without loading patches into the model', () => {
  const item = largePullRequest();
  const snapshot = structuredClone(item);
  const input = contentInput(item), text = JSON.stringify(input);
  assert.ok(Buffer.byteLength(text) < 160000, `summary bytes: ${Buffer.byteLength(text)}`);
  assert.doesNotMatch(text, /PATCH_NOT_IN_PROMPT|FULL_DIFF_NOT_IN_PROMPT|REVIEW_DIFF_NOT_IN_PROMPT|OLD_FULL_BODY/);
  assert.equal(input.body.length, 16000);
  assert.equal(input.payload.files.length, 40);
  assert.deepEqual(input.modelScope.files, { stored: 430, included: 40, patchesIncluded: false, diffIncluded: false, reviewCommentDiffsIncluded: false });
  assert.equal(input.payload.files[0].filename, 'src/file-0.js');
  assert.equal(input.payload.files[0].patchAvailable, true);
  assert.equal(input.payload.comments.at(-1).id, '499');
  assert.match(input.payload.comments.at(-1).body, /COMMENT-499/);
  assert.equal(input.modelScope.comments.stored, 500);
  assert.equal(input.modelScope.comments.included, 20);
  assert.equal(input.modelScope.comments.truncatedBodies, 20);
  assert.equal(input.payload.reviews.length, 10);
  assert.equal(input.payload.reviewComments.length, 20);
  assert.equal(input.payload.stateEvents.length, 20);
  assert.match(input.modelScope.note, /section:"files"/);
  assert.match(input.modelScope.note, /section:"file",filePath/);
  assert.match(input.modelScope.note, /MBP/);
  assert.match(input.modelScope.note, /未提供.*不能视为已读/);
  assert.equal(input.modelScope.previousBodyOmitted, true);
  assert.deepEqual(item, snapshot);
});

test('file summaries account for unavailable patches and remain bounded for long metadata', () => {
  const input = contentInput({ kind: 'pr', title: 'x'.repeat(100000), payload: { files: [{ path: 'x'.repeat(100000), patch: null, status: 'removed' }], comments: [{ id: '1', author: 'a'.repeat(100000), body: 'short' }] } });
  assert.equal(input.title.length, 512);
  assert.equal(input.payload.files[0].filename.length, 512);
  assert.equal(input.payload.files[0].patchAvailable, false);
  assert.equal(input.payload.comments[0].author.length, 512);
  assert.equal(input.payload.comments[0].body, 'short');
});

test('issue and release bodies are bounded while Bilibili input retains existing behavior', () => {
  for (const kind of ['issue', 'release']) {
    const item = { kind, body: 'x'.repeat(100000), payload: { state: 'open', comments: [{ id: '1', body: 'reply' }] } };
    const input = contentInput(item);
    assert.equal(input.body.length, 16000);
    assert.equal(input.modelScope.bodyCharacters, 100000);
    assert.equal(input.payload.comments[0].body, 'reply');
  }
  const comment = { kind: 'comment', body: 'x'.repeat(100000), payload: { comments: [{ id: '1', body: 'reply' }] } };
  assert.deepEqual(contentInput(comment), comment);
  const privateMessage = contentInput({ kind: 'private-message', payload: { comments: [{ id: '1', body: 'x'.repeat(100000) }] } });
  assert.equal(privateMessage.messages[0].body.length, 2000);
  assert.equal(privateMessage.modelScope.maxBodyCharacters, 24000);
});

test('history projection changes only recognized DMC input copies and preserves message identity, order and original bytes', () => {
  const item = largePullRequest();
  const text = JSON.stringify({ role: 'review', input: { blocks: [{ key: 'source', value: { name: 'Project' } }, { key: 'content', value: item }], stage: 'generation' }, round: { runId: 'run' } });
  const image = { type: 'image', attachment: { attachmentId: 'external' } };
  const source = { kind: 'dsh-message-console', form: 'instructions', runId: 'run' };
  const message = { role: 'user', id: 'original-id', source, content: [{ type: 'text', text }, image] };
  const projected = compactOrganizationMessage(message);
  assert.equal(message.content[0].text, text);
  assert.equal(projected.id, message.id);
  assert.equal(projected.source, source);
  assert.equal(projected.content[1], image);
  const result = JSON.parse(projected.content[0].text);
  assert.deepEqual(result.round, { runId: 'run' });
  assert.deepEqual(result.input.blocks.map(block => block.key), ['source', 'content']);
  assert.deepEqual(result.input.blocks[0], { key: 'source', value: { name: 'Project' } });
  assert.equal(result.input.blocks[1].value.modelScope.files.stored, 430);
  assert.ok(Buffer.byteLength(projected.content[0].text) < 170000);
  assert.equal(compactOrganizationMessage(projected), projected);
  for (const unrelated of [
    { ...message, role: 'assistant' }, { ...message, source: { kind: 'human' } },
    { ...message, content: [{ type: 'text', text: 'ordinary message' }] },
    { ...message, content: [{ type: 'text', text: '{"input":null}' }] },
  ]) assert.equal(compactOrganizationMessage(unrelated), unrelated);
});

test('newly assembled GitHub messages are already compact and need no further historical projection', () => {
  const input = assembleInput({ name: 'Project', platform: 'github', target: 'owner/repo' }, largePullRequest());
  const message = { role: 'user', id: 'new', source: { kind: 'dsh-message-console' }, content: [{ type: 'text', text: serializeInput({ role: 'review', input }) }] };
  assert.equal(compactOrganizationMessage(message), message);
});
