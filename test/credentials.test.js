import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { PlatformCredentials } from '../src/credentials/index.js';
import { BilibiliCredentials, parseBilibiliCookie } from '../src/credentials/bilibili.js';
import { GitHubCredentials } from '../src/credentials/github.js';
import { createHandler } from '../src/http.js';

const cookie = 'SESSDATA=SYNTHETIC_SECRET; bili_jct=FAKE_CSRF; unrelated=DROP_ME';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyFile = join(directory, 'legacy.json'), file = join(directory, 'credentials', 'bilibili.json');
  await writeFile(legacyFile, 'legacy untouched', { mode: 0o600 });
  const connectors = {}, sources = [];
  let account = 42, fail = false;
  const request = async (url, options) => {
    assert.equal(url, 'https://api.bilibili.com/x/web-interface/nav?'); assert.equal(options.redirect, 'manual');
    assert.match(options.headers.Cookie, /SYNTHETIC_SECRET/); assert.doesNotMatch(options.headers.Cookie, /DROP_ME/);
    if (fail) throw new Error('SYNTHETIC_SECRET network failure');
    return Response.json({ code: 0, data: { isLogin: true, mid: account, uname: 'fixture' } });
  };
  const adapter = new BilibiliCredentials({ file, legacyFile, connectors, sources: () => sources, request });
  await adapter.initialize();
  return { directory, file, legacyFile, connectors, adapter, sources, fail: () => { fail = true; }, account: value => { account = value; } };
}
test('Cookie import validates before atomic activation, protects permissions and survives restart without touching legacy', async t => {
  const f = await fixture(t); const manager = new PlatformCredentials({ bilibili: f.adapter });
  await manager.act('bilibili', 'save', { cookie });
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.equal(await readFile(f.legacyFile, 'utf8'), 'legacy untouched');
  assert.equal(f.connectors.bilibili.status().identity.id, '42');
  assert.doesNotMatch(JSON.stringify(manager.list()), /SYNTHETIC_SECRET|FAKE_CSRF|DROP_ME|legacy.json/);
  const saved = await readFile(f.file, 'utf8');
  assert.equal(JSON.parse(saved).platforms.bilibili.length, 2);
  await f.adapter.initialize(); assert.equal(f.connectors.bilibili.transport.cookieFile, f.file);
  f.fail(); await assert.rejects(manager.act('bilibili', 'save', { cookie }), /原凭据未修改/);
  assert.equal(await readFile(f.file, 'utf8'), saved);
  assert.deepEqual(await readdir(join(f.directory, 'credentials')), ['bilibili.json']);
  await assert.rejects(manager.act('bilibili', 'verify'), /登录验证失败/);
  assert.equal(manager.list().platforms[0].status.ready, false);
});
test('Cookie import rejects duplicate, injected and missing credentials and a different bound private account', async t => {
  for (const value of ['', null, 'SESSDATA=x', 'SESSDATA=x; bili_jct=y\r\nX: z', 'SESSDATA=x; SESSDATA=z; bili_jct=y', 'x'.repeat(32769)]) assert.throws(() => parseBilibiliCookie(value));
  const f = await fixture(t), manager = new PlatformCredentials({ bilibili: f.adapter });
  await manager.act('bilibili', 'save', { cookie }); const saved = await readFile(f.file, 'utf8');
  f.sources.push({ platform: 'bilibili', accountId: '42' }); f.account(43);
  await assert.rejects(manager.act('bilibili', 'save', { cookie }), /绑定的账号不同/);
  assert.equal(await readFile(f.file, 'utf8'), saved); assert.equal(f.connectors.bilibili.status().identity.id, '42');
});
function ghFixture(options = {}) {
  let connects = 0; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { child.signal = signal; };
  const connector = { status: () => ({ ready: connects > 0, identity: connects ? { name: 'fixture' } : null }), connect: async () => { connects++; return connector.status(); } };
  const adapter = new GitHubCredentials(connector, { environment: {}, launch(command, args, settings) {
    assert.equal(command, 'gh'); assert.deepEqual(args, ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https']);
    assert.equal(settings.stdio[0], 'ignore'); assert.equal(settings.env.GH_BROWSER, '/usr/bin/true'); return child;
  }, ...options });
  return { adapter, child, connects: () => connects };
}
test('GitHub device login exposes only code, fixed URL and verified identity; concurrent start is rejected', async () => {
  const f = ghFixture(), manager = new PlatformCredentials({ github: f.adapter });
  await manager.act('github', 'login'); assert.equal(manager.busy(), true);
  f.child.stderr.write('! First copy your one-time co'); f.child.stderr.write('de: ABCD-1234\nSECRET_TOKEN https://evil.invalid\n');
  const view = manager.list().platforms[0]; assert.equal(view.login.code, 'ABCD-1234'); assert.equal(view.login.url, 'https://github.com/login/device');
  assert.doesNotMatch(JSON.stringify(view), /SECRET_TOKEN|evil.invalid/);
  await assert.rejects(manager.act('github', 'login'));
  assert.equal(f.connects(), 0); f.child.emit('close', 0); await f.adapter.completion;
  assert.equal(manager.busy(), false); assert.equal(f.adapter.describe().login.state, 'complete'); assert.equal(f.connects(), 1);
});
test('GitHub cancellation, expiry, missing CLI and failure clear device codes without leaking output', async () => {
  for (const mode of ['cancel', 'expiry', 'missing', 'failure']) {
    const f = ghFixture({ timeoutMs: mode === 'expiry' ? 5 : 1000 });
    await f.adapter.act('login'); f.child.stderr.write('one-time code: ABCD-1234\n');
    if (mode === 'cancel') await f.adapter.act('cancel');
    if (mode === 'expiry') await new Promise(resolve => setTimeout(resolve, 15));
    if (mode === 'missing') f.child.emit('error', new Error('SECRET_OUTPUT'));
    f.child.emit('close', 1); await f.adapter.completion;
    assert.equal(f.adapter.describe().login.code, undefined); assert.equal(f.adapter.busy(), false); assert.equal(f.connects(), 0);
    assert.doesNotMatch(JSON.stringify(f.adapter.describe()), /SECRET_OUTPUT|ABCD/);
  }
  const f = ghFixture({ environment: { GH_TOKEN: 'SECRET' } }); await assert.rejects(f.adapter.act('login'), /环境变量/); assert.equal(f.adapter.busy(), false);
});
test('credential API requires admission and CSRF headers; unknown platform/actions never execute and errors redact secrets', async () => {
  let calls = 0;
  const manager = new PlatformCredentials({ future: { describe: () => ({ title: 'Future platform', actions: [{ id: 'save' }], fields: [] }), act: async () => { calls++; throw new Error('SECRET_VALUE'); } } });
  const handler = createHandler({ credentials: manager }, req => req.headers.owner ? {} : { rejection: 401 });
  async function call(method, path, headers = {}) {
    const req = Readable.from([Buffer.from('{}')]); Object.assign(req, { method, url: '/api/dsh-message-console/' + path, headers });
    let status, data, responseHeaders;
    await handler(req, { writeHead(code, headers) { status = code; responseHeaders = headers; }, end(value) { data = JSON.parse(value); } });
    assert.equal(responseHeaders['Cache-Control'], 'no-store'); return { status, data };
  }
  assert.equal((await call('GET', 'credentials')).status, 401);
  assert.equal((await call('GET', 'credentials', { owner: '1' })).data.platforms[0].id, 'future');
  assert.equal((await call('POST', 'credentials/future/save', { owner: '1' })).status, 403);
  const headers = { owner: '1', 'content-type': 'application/json', 'x-dsh-message-console': '1' };
  for (const path of ['credentials/__proto__/save', 'credentials/future/delete']) assert.equal((await call('POST', path, headers)).status, 400);
  const response = await call('POST', 'credentials/future/save', headers); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(response), /SECRET_VALUE/);
});
test('credential mutations refuse active work and serialize validation while preserving the old login', async () => {
  let idle = false, unblock;
  const adapter = { describe: () => ({ actions: [{ id: 'save' }] }), act: () => new Promise(resolve => { unblock = resolve; }) };
  const manager = new PlatformCredentials({ future: adapter }, { assertIdle: () => { if (!idle) throw new Error('active'); } });
  await assert.rejects(manager.act('future', 'save'), /active/); idle = true;
  const pending = manager.act('future', 'save'); await Promise.resolve(); assert.equal(manager.busy(), true);
  await assert.rejects(manager.act('future', 'save'), /正在进行/); unblock(); await pending; assert.equal(manager.busy(), false);
});

test('service blocks new work during device authorization and closes credential resources', async () => {
 const { ConsoleService } = await import('../src/core.js');
 let closed=false;
 const service=new ConsoleService({store:{close:async()=>{}},connectors:{}});
 service.credentials={busy:()=>true,close:async()=>{closed=true;}};
 await assert.rejects(service.refresh('fixture'),/凭据操作正在进行/);
 await service.close();assert.equal(closed,true);assert.throws(()=>service.assertCredentialsIdle(),/后台任务/);
});
