import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { ImageCache } from '../src/image-cache.js';
import { commentImages, imageURL } from '../src/images.js';
const MB = 1048576, DAY = 864e5;
const image = id => ({ url: `https://i0.hdslb.com/bfs/new_dyn/${id}.png` });
const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: 'green' } }).png().toBuffer();
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dmc-images-')); let now = Date.now(), calls = 0;
  const settings = { imageCacheMaxMB: 256, imageOriginalDays: 7, imageThumbnailDays: 30, imageCacheReserveMB: 16 };
  let request = async () => new Response(png);
  const options = { settings: () => settings, clock: () => now, disk: async () => ({ bavail: 10 ** 8, bsize: 4096 }), request: async (...args) => { calls++; return request(...args); } };
  let cache = await new ImageCache(directory, options).start();
  t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, options, get cache() { return cache; }, get calls() { return calls; }, request: fn => { request = fn; }, advance: days => { now += days * DAY; }, async restart() { await cache.close(); cache = await new ImageCache(directory, options).start(); } };
}

test('image references normalize only known Bilibili CDN URLs and preserve missing-image payload shape', () => {
  assert.deepEqual(commentImages({ message: '文字' }), {});
  const fields = commentImages({ pictures: [{ img_src: 'http://i1.hdslb.com/bfs/new_dyn/a.jpg', img_width: 100, img_height: 20, img_size: 4 }] });
  assert.deepEqual(fields.images[0], { url: 'https://i1.hdslb.com/bfs/new_dyn/a.jpg', width: 100, height: 20, sizeKB: 4 });
  for (const url of ['https://127.0.0.1/bfs/a', 'https://i0.hdslb.com.evil.test/bfs/a', 'https://i0.hdslb.com:8080/bfs/a', 'https://user:secret@i0.hdslb.com/bfs/a', 'file:///etc/passwd', 'https://i0.hdslb.com/private']) assert.throws(() => imageURL(url));
});

test('cache is lazy, deduplicates concurrent requests, produces real thumbnail and never sends credentials', async t => {
  const f = await fixture(t); assert.equal(f.calls, 0); let headers;
  f.request(async (_url, options) => { headers = options; return new Response(png); });
  const results = await Promise.all(Array.from({ length: 8 }, () => f.cache.get(image('a'))));
  assert.equal(f.calls, 1); assert.equal(headers.redirect, 'error'); assert.equal(headers.headers.Cookie, undefined); assert.equal(headers.headers.Authorization, undefined);
  assert.equal(results[0].mime, 'image/webp'); assert.equal((await sharp(results[0].body).metadata()).format, 'webp');
  assert.equal((await f.cache.stats()).originalBytes, 0, 'thumbnail request does not retain original');
  await f.cache.get(image('a'), 'original'); const before = await f.cache.stats(); assert.equal(before.files, 2);
  await f.restart(); await f.cache.get(image('a')); assert.equal(f.calls, 2); assert.equal((await f.cache.stats()).files, 2);
  for (const name of await readdir(f.directory)) if (name.endsWith('.img')) assert.equal((await stat(join(f.directory, name))).mode & 0o077, 0);
});

test('originals expire after 7 idle days, thumbnails after 30; a thumbnail hit does not keep originals forever', async t => {
  const f = await fixture(t); await f.cache.get(image('a'), 'original'); await f.cache.get(image('a'));
  assert.equal(f.calls, 1, 'thumbnail uses cached original without another download');
  f.advance(6); await f.cache.get(image('a')); f.advance(2); await f.cache.maintain();
  assert.equal((await f.cache.stats()).originalBytes, 0); assert.ok((await f.cache.stats()).thumbnailBytes > 0);
  f.advance(29); await f.cache.maintain(); assert.equal((await f.cache.stats()).usedBytes, 0);
});

test('capacity eviction prefers originals then oldest thumbnails, includes in-progress downloads and handles reduced settings', async t => {
  const f = await fixture(t); await f.cache.get(image('a')); await f.cache.get(image('a'), 'original');
  const full = await f.cache.stats(); f.settings.imageCacheMaxMB = (full.usedBytes - 1) / MB;
  await f.cache.maintain(); assert.equal((await f.cache.stats()).originalBytes, 0); assert.ok((await f.cache.stats()).thumbnailBytes > 0);
  f.settings.imageCacheMaxMB = 1; let streamed = 0, peak = 0;
  f.request(async () => new Response(new ReadableStream({ async pull(controller) {
    if (streamed++ >= 12) { controller.close(); return; }
    let bytes = 0; for (const name of await readdir(f.directory)) if (/\.(tmp|img)$/.test(name)) bytes += (await stat(join(f.directory, name))).size;
    peak = Math.max(peak, bytes); controller.enqueue(new Uint8Array(100000));
  } })));
  await assert.rejects(f.cache.get(image('large'), 'original'), /上限/);
  assert.ok(peak <= MB); assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.tmp')));
  assert.ok((await f.cache.stats()).usedBytes <= MB);
});

test('low disk space stops before downloading; failures, wrong file types and oversize headers leave no temporary files', async t => {
  const f = await fixture(t); f.options.disk = undefined;
  f.cache.disk = async () => ({ bavail: 1, bsize: 4096 });
  await assert.rejects(f.cache.get(image('low')), /磁盘/); assert.equal(f.calls, 0);
  f.cache.disk = async () => ({ bavail: 10 ** 8, bsize: 4096 });
  for (const response of [() => new Response('not an image'), () => new Response(png, { headers: { 'content-length': 20 * MB } }), () => new Response('', { status: 404 }), () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', { headers: { 'content-type': 'image/svg+xml' } })]) {
    f.request(async () => response()); await assert.rejects(f.cache.get(image(String(f.calls)), 'original'));
  }
  assert.equal((await f.cache.stats()).files, 0); assert.ok(!(await readdir(f.directory)).some(name => /\.(tmp|img)$/.test(name)));
});

test('cached data survives unavailable source, clear preserves ability to redownload, restart removes interrupted and orphan files', async t => {
  const f = await fixture(t); await f.cache.get(image('a'), 'original');
  f.request(async () => { throw new Error('offline'); });
  assert.equal((await f.cache.get(image('a'), 'original')).body.length, png.length);
  assert.equal((await f.cache.get(image('a'))).mime, 'image/webp', 'thumbnail derives from cached original while offline');
  await f.cache.clear(); await assert.rejects(f.cache.get(image('a'), 'original'), /下载失败/);
  await writeFile(join(f.directory, 'f'.repeat(64) + '.tmp'), png); await writeFile(join(f.directory, 'e'.repeat(64) + '.img'), png);
  await f.restart(); assert.ok(!(await readdir(f.directory)).some(name => /\.(tmp|img)$/.test(name)));
  f.request(async () => new Response(png)); await f.cache.get(image('a')); assert.equal((await f.cache.stats()).files, 1);
});

test('a settings change and clear wait for in-flight work, so active downloads keep their original budget', async t => {
  const f = await fixture(t); let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  f.request(async () => { entered(); await new Promise(resolve => { finish = resolve; }); return new Response(png); });
  const download = f.cache.get(image('inflight'), 'original'); await started;
  let changed = false;
  const configure = f.cache.updateSettings(() => { changed = true; f.settings.imageCacheMaxMB = 1; });
  const clear = f.cache.clear(); assert.equal(changed, false); finish();
  await download; await configure; await clear;
  assert.equal(changed, true); assert.equal((await f.cache.stats()).usedBytes, 0);
});

test('quota accounts for allocated disk blocks and tiny files also have a count bound', async t => {
  const f = await fixture(t); f.cache.fileLimit = 2;
  for (const id of ['one', 'two', 'three']) await f.cache.get(image(id));
  const files = (await readdir(f.directory)).filter(name => name.endsWith('.img'));
  assert.equal(files.length, 2);
  let allocated = 0; for (const file of files) { const info = await stat(join(f.directory, file)); allocated += Math.max(info.size, Number(info.blocks) * 512); }
  assert.equal((await f.cache.stats()).usedBytes, allocated);
  assert.ok(allocated <= (await f.cache.stats()).maxBytes);
});

test('model reads stream into memory without new image files or index entries; browser originals can be reused', async t => {
  const f = await fixture(t), before = await readdir(f.directory);
  const result = await f.cache.readTransient(image('model'));
  assert.deepEqual(result.body, png); assert.equal(f.calls, 1);
  assert.deepEqual(await readdir(f.directory), before); assert.equal((await f.cache.stats()).files, 0);
  await f.cache.get(image('shared'), 'original'); const calls = f.calls;
  assert.deepEqual((await f.cache.readTransient(image('shared'))).body, png); assert.equal(f.calls, calls);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(f.cache.readTransient(image('unused'), controller.signal), /cancelled/); assert.equal(f.calls, calls);
  const files = await readdir(f.directory);
  f.request(async () => new Response('not an image'));
  await assert.rejects(f.cache.readTransient(image('invalid')));
  f.request(async () => new Response(png, { headers: { 'content-length': String(11 * MB) } }));
  await assert.rejects(f.cache.readTransient(image('large')), /上限/);
  assert.deepEqual(await readdir(f.directory), files);
});
