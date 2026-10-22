import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CookieTransport } from '../src/connectors/cookies.js';
import { BilibiliConnector } from '../src/connectors/bilibili.js';

const params = { oid: '100', root: '200', parent: '201', message: '由「看点什么」插件自动回复\n合成回复 + & = 中文' };
const source = { platform: 'bilibili', target: 'BV1111111111' };
const item = { remoteId: 'comment:100:200', kind: 'comment', payload: { aid: '100', bvid: source.target, root: '200', comments: [{ id: '201', parent: '200' }] } };
const data = (parent = '201') => ({ rpid_str: '90071992547409931', need_captcha: false, reply: { rpid_str: '90071992547409931', root_str: '200', parent_str: parent, oid: 100, mid: 50 } });
const success = parent => Response.json({ code: 0, data: data(parent) });
async function fixture(t, request, update = rows => rows) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cookieFile = join(directory, 'cookie.json');
  const rows = ['SESSDATA', 'bili_jct', 'UNRELATED'].map(name => ({ name, value: `PRIVATE_${name}`, domain: '.bilibili.com', path: '/', expires: 0 }));
  await writeFile(cookieFile, JSON.stringify({ platforms: { bilibili: update(rows) } }), { mode: 0o600 });
  return new CookieTransport({ cookieFile, request, intervalMs: 0 });
}
const notSent = error => error.definitelyNotSent === true;
const uncertain = error => error.definitelyNotSent !== true && /不明|未确认/.test(error.message);

test('Bilibili publishes an exact nested reply with a verifiable receipt and only scoped credentials', async t => {
  const requests = [];
  const transport = await fixture(t, async (url, options) => { requests.push({ url, options }); return success(); });
  const connector = new BilibiliConnector(transport);
  const receipt = await connector.publish(source, item, { body: params.message, replyToCommentId: '201', automatic: true }, { actionId: 'draft-id' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.bilibili.com/x/v2/reply/add');
  const { options } = requests[0];
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(options.headers.Cookie, 'SESSDATA=PRIVATE_SESSDATA; bili_jct=PRIVATE_bili_jct');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), { ...params, type: '1', plat: '1', csrf: 'PRIVATE_bili_jct' });
  assert.deepEqual(receipt, { remoteId: '90071992547409931', url: 'https://www.bilibili.com/video/BV1111111111/#reply90071992547409931', aid: '100', root: '200', parent: '201', authorId: '50', body: params.message, actionId: 'draft-id' });
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(transport.status('bilibili')), /PRIVATE_/);
  assert.equal(transport.status('bilibili').canPublish, true);
  assert.equal(transport.status('github').canPublish, false);
  assert.equal(new CookieTransport({}).status('bilibili').canPublish, false);
});

test('Bilibili manual drafts default to replying to the root and av sources match the exact aid', async t => {
  const calls = [];
  const transport = await fixture(t, async (_, options) => { calls.push(new URLSearchParams(options.body)); return success('200'); });
  const receipt = await new BilibiliConnector(transport).publish({ ...source, target: 'av100' }, item, { body: '合成根回复' });
  assert.equal(calls[0].get('parent'), '200'); assert.equal(calls[0].get('root'), '200'); assert.equal(receipt.parent, '200');
});

test('Bilibili refuses mismatched videos, roots, foreign targets and invalid drafts before the network', async t => {
  let calls = 0;
  const transport = await fixture(t, async () => { calls++; return success(); });
  const connector = new BilibiliConnector(transport);
  for (const [s, i, draft] of [
    [{ ...source, target: 'av101' }, item, { body: 'x' }],
    [{ ...source, target: 'BV2222222222' }, item, { body: 'x' }],
    [source, { ...item, remoteId: 'comment:100:202' }, { body: 'x' }],
    [source, item, { body: 'x', replyToCommentId: '999' }],
    [source, item, { body: 'x', replyToCommentId: null }],
    [source, item, { body: 'x', automatic: true }],
    [source, item, { body: ' ' }],
    [source, item, { body: '字'.repeat(1001) }],
    [source, { ...item, payload: { ...item.payload, root: '0' } }, { body: 'x' }],
  ]) await assert.rejects(connector.publish(s, i, draft), notSent);
  assert.equal(calls, 0);
});

test('Bilibili transport validates targets and never accepts caller supplied csrf or destination', async t => {
  const transport = await fixture(t, async (url, options) => {
    assert.equal(url, 'https://api.bilibili.com/x/v2/reply/add');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('csrf'), 'PRIVATE_bili_jct'); assert.equal(body.get('type'), '1');
    assert.equal(body.has('url'), false); return success();
  });
  await transport.postComment({ ...params, csrf: 'attacker', url: 'https://attacker.test', type: '17' });
  for (const invalid of [{ ...params, oid: '100&oid=999' }, { ...params, root: '' }, { ...params, message: '' }]) await assert.rejects(transport.postComment(invalid), notSent);
});

test('Bilibili rejects missing, expired, wrong-domain and exposed Cookie credentials before sending', async t => {
  let calls = 0;
  const request = async () => { calls++; return success(); };
  for (const update of [rows => rows.filter(row => row.name !== 'bili_jct'), rows => rows.map(row => ({ ...row, expires: 1 })), rows => rows.map(row => ({ ...row, domain: '.evil.bilibili.com' })), rows => rows.map(row => ({ ...row, path: '/not-reply' })), rows => [...rows, rows[0]]]) {
    const transport = await fixture(t, request, update);
    await assert.rejects(transport.postComment(params), error => notSent(error) && !/PRIVATE_/.test(error.message));
  }
  const transport = await fixture(t, request);
  await chmod(transport.cookieFile, 0o644);
  await assert.rejects(transport.postComment(params), notSent);
  assert.equal(calls, 0);
});

test('Bilibili cancellation before sending is definite and cancellation after sending is uncertain', async t => {
  let calls = 0;
  const before = new AbortController(); before.abort(new Error('PRIVATE_cancel'));
  const transport = await fixture(t, async () => { calls++; throw new Error('PRIVATE_request'); });
  await assert.rejects(transport.postComment(params, { signal: before.signal }), error => notSent(error) && !/PRIVATE_/.test(error.message));
  assert.equal(calls, 0);
  await assert.rejects(transport.postComment(params), error => uncertain(error) && !/PRIVATE_/.test(error.message));
  assert.equal(calls, 1);
});

test('Bilibili HTTP errors, redirects, malformed JSON and absent status codes remain uncertain without retry', async t => {
  for (const response of [new Response('', { status: 302, headers: { Location: 'https://attacker.test' } }), new Response('', { status: 403 }), new Response('', { status: 500 }), new Response('not json'), Response.json({ message: 'PRIVATE_response' })]) {
    let calls = 0;
    const transport = await fixture(t, async () => { calls++; return response; });
    await assert.rejects(transport.postComment(params), error => uncertain(error) && !/PRIVATE_/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('Bilibili explicit platform rejections including captcha are definitely not sent and never retried', async t => {
  for (const code of [-101, -111, -509, 12015, 12051]) {
    let calls = 0;
    const transport = await fixture(t, async () => { calls++; return Response.json({ code, message: 'PRIVATE_response' }); });
    await assert.rejects(transport.postComment(params), error => notSent(error) && error.message.includes(String(code)) && !/PRIVATE_/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('Bilibili successful status without exact reply receipt stays uncertain', async t => {
  const base = data();
  for (const value of [null, {}, { ...base, need_captcha: true }, { ...base, success: false }, { ...base, reply: { ...base.reply, need_captcha: 1 } }, { ...base, reply: { ...base.reply, root_str: '999' } }, { ...base, reply: { ...base.reply, parent_str: '999' } }, { ...base, reply: { ...base.reply, rpid_str: '777' } }, { ...base, reply: { ...base.reply, oid: 999 } }, { ...base, rpid_str: undefined, rpid: Number.MAX_SAFE_INTEGER + 1 }]) {
    const transport = await fixture(t, async () => Response.json({ code: 0, data: value }));
    await assert.rejects(new BilibiliConnector(transport).publish(source, item, { body: '合成回复', replyToCommentId: '201' }), uncertain);
  }
});

test('Bilibili preserves root author IDs for self-reply exclusion', async () => {
  const transport = { identities: {}, json: async (_, url) => url.includes('/nav') ? { isLogin: true, mid: 50, uname: 'self' } : url.includes('/view') ? { aid: 100, bvid: source.target } : { page: { size: 20, count: 1 }, replies: [{ rpid_str: '200', mid: 51, rcount: 0, content: { message: '合成' }, member: { uname: 'user' } }] } };
  const fetched = await new BilibiliConnector(transport).fetch(source);
  assert.equal(fetched.items[0].rootAuthorId, '51');
  assert.equal(transport.identities.bilibili.id, '50');
});

test('Bilibili sends serialize with collection through the shared Cookie transport queue', async t => {
  let release, started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const requests = [];
  const transport = await fixture(t, async (url, options) => {
    requests.push(options.method ?? 'GET');
    if (requests.length === 1) { started(); await wait; }
    return options.method === 'POST' ? success() : Response.json({ code: 0, data: {} });
  });
  const first = transport.postComment(params);
  await firstStarted;
  const read = transport.get('bilibili', 'https://api.bilibili.com/x/web-interface/nav');
  const second = transport.postComment(params);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['POST']);
  release();
  await Promise.all([first, read, second]);
  assert.deepEqual(requests, ['POST', 'GET', 'POST']);
});
