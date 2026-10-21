import { mkdir, readdir, stat, statfs, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { imageURL } from './images.js';
const MB = 1024 * 1024, DAY = 864e5, MAX_IMAGE = 10 * MB, MAX_THUMB = 512 * 1024;
const allocated = info => Math.max(info.size, Number(info.blocks ?? 0) * 512);
const formats = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heif: 'image/heif' };
const decode = file => sharp(file, { limitInputPixels: 40e6, failOn: 'error' });
export const cachePolicy = settings => ({ maxBytes: Math.floor((settings.imageCacheMaxMB ?? 256) * MB / 4096) * 4096, originalDays: settings.imageOriginalDays ?? 7, thumbnailDays: settings.imageThumbnailDays ?? 30, reserveBytes: (settings.imageCacheReserveMB ?? 128) * MB });

export class ImageCache {
  #db; #tail = Promise.resolve(); #closed = false; #timer; #aborts = new Set();
  constructor(directory, { settings = () => ({}), request = fetch, clock = Date.now, disk = statfs, fileLimit = 4096 } = {}) { Object.assign(this, { directory, settings, request, clock, disk, fileLimit }); }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.#db = new DatabaseSync(join(this.directory, 'index.sqlite'));
    this.#db.exec('PRAGMA auto_vacuum=FULL; CREATE TABLE IF NOT EXISTS images(key TEXT PRIMARY KEY,url TEXT,variant TEXT,mime TEXT,bytes INTEGER NOT NULL,last_used INTEGER NOT NULL,evicted INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS image_lru ON images(variant,last_used);');
    await chmod(join(this.directory, 'index.sqlite'), 0o600);
    const known = new Set(this.#rows().map(row => row.key));
    for (const name of await readdir(this.directory)) if (/^[a-f0-9]{64}\.(tmp|img)$/.test(name) && (name.endsWith('.tmp') || !known.has(name.slice(0, 64)))) await unlink(join(this.directory, name));
    for (const row of this.#rows()) {
      const info = await stat(this.#file(row.key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!info || !info.isFile()) await this.#remove(row);
      else this.#db.prepare('UPDATE images SET bytes=? WHERE key=?').run(allocated(info), row.key);
    }
    await this.maintain();
    this.#timer = setInterval(() => void this.maintain().catch(() => {}), 600000); this.#timer.unref?.();
    return this;
  }
  #file(key) { return join(this.directory, `${key}.img`); }
  #rows() { return this.#db.prepare('SELECT * FROM images WHERE bytes>0 ORDER BY CASE variant WHEN \'original\' THEN 0 ELSE 1 END,last_used,key').all(); }
  #serial(work) {
    if (this.#closed) return Promise.reject(new Error('图片缓存已停止'));
    const result = this.#tail.then(() => { if (this.#closed) throw new Error('图片缓存已停止'); return work(); });
    this.#tail = result.catch(() => {}); return result;
  }
  async #remove(row) {
    await unlink(this.#file(row.key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this.#db.prepare('UPDATE images SET bytes=0,evicted=1 WHERE key=?').run(row.key);
  }
  async #sweep(reservation = 0, diskCheck = false, keepKey = null) {
    const policy = cachePolicy(this.settings()), rows = this.#rows();
    for (const row of rows) if (row.key !== keepKey && this.clock() - row.last_used >= (row.variant === 'original' ? policy.originalDays : policy.thumbnailDays) * DAY) await this.#remove(row);
    let available = Infinity;
    if (diskCheck) { const disk = await this.disk(this.directory); available = Number(disk.bavail) * Number(disk.bsize) - policy.reserveBytes; }
    const active = this.#rows(); let used = active.reduce((n, row) => n + row.bytes, 0), files = active.length;
    for (const row of this.#rows()) {
      if (row.key === keepKey) continue;
      if (used + reservation <= policy.maxBytes && available >= reservation && (files + (reservation ? 1 : 0) <= this.fileLimit)) break;
      await this.#remove(row); used -= row.bytes; available += row.bytes; files--;
    }
    if (used + reservation > policy.maxBytes || files + (reservation ? 1 : 0) > this.fileLimit) throw new Error('图片缓存容量不足，未下载图片');
    if (diskCheck) { const disk = await this.disk(this.directory); available = Number(disk.bavail) * Number(disk.bsize) - policy.reserveBytes; }
    if (available < reservation) throw new Error('磁盘剩余空间不足，已停止新增图片缓存');
    this.#db.exec('DELETE FROM images WHERE bytes=0 AND key NOT IN (SELECT key FROM images WHERE bytes=0 ORDER BY last_used DESC,key LIMIT 2048)');
  }
  maintain() { return this.#serial(async () => { await this.#sweep(); return this.#stats(); }); }
  updateSettings(save) { return this.#serial(async () => { save(); await this.#sweep(); return this.#stats(); }); }
  clear() { return this.#serial(async () => { for (const row of this.#rows()) await this.#remove(row); await this.#sweep(); return this.#stats(); }); }
  #stats() {
    const rows = this.#rows(), policy = cachePolicy(this.settings());
    return { ...policy, maxFiles: this.fileLimit, usedBytes: rows.reduce((n, row) => n + row.bytes, 0), originalBytes: rows.filter(row => row.variant === 'original').reduce((n, row) => n + row.bytes, 0), thumbnailBytes: rows.filter(row => row.variant === 'thumbnail').reduce((n, row) => n + row.bytes, 0), files: rows.length };
  }
  stats() { return this.#serial(() => this.#stats()); }
  async #download(url, file, limit) {
    const controller = new AbortController(); this.#aborts.add(controller);
    let output, reader;
    try {
      const response = await this.request(url, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), headers: { Accept: 'image/*', Referer: 'https://www.bilibili.com/' } });
      if (!response.ok || !response.body) throw new Error('原图不可用，未缓存或缓存已清理');
      if (Number(response.headers.get('content-length')) > limit) throw new Error('图片超过单张下载上限');
      output = await open(file, 'wx', 0o600); reader = response.body.getReader(); let bytes = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > limit) throw new Error('图片超过单张下载上限');
        await output.writeFile(value);
      }
      if (!bytes) throw new Error('图片内容为空');
      return bytes;
    } catch (error) {
      if (error.message?.includes('上限') || error.message?.includes('原图不可用') || error.message?.includes('为空')) throw error;
      throw new Error('图片下载失败，未缓存或缓存已清理');
    } finally { await reader?.cancel().catch(() => {}); await output?.close(); this.#aborts.delete(controller); }
  }
  get(image, variant = 'thumbnail') {
    if (!['thumbnail', 'original'].includes(variant)) return Promise.reject(new Error('图片规格无效'));
    let url; try { url = imageURL(image.url); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      await this.#sweep();
      const key = createHash('sha256').update(variant + ':' + url).digest('hex'), file = this.#file(key), temp = join(this.directory, `${key}.tmp`);
      const existing = this.#db.prepare('SELECT * FROM images WHERE key=? AND bytes>0').get(key);
      if (existing) {
        const body = await readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (body) { this.#db.prepare('UPDATE images SET last_used=? WHERE key=?').run(this.clock(), key); return { body, mime: existing.mime }; }
        await this.#remove(existing);
      }
      const thumbnail = variant === 'thumbnail', budget = cachePolicy(this.settings()).maxBytes;
      const limit = Math.min(MAX_IMAGE, budget - (thumbnail ? MAX_THUMB : 0));
      if (limit < 1) throw new Error('图片缓存容量不足，未下载图片');
      const originalKey = createHash('sha256').update('original:' + url).digest('hex');
      const original = thumbnail ? this.#db.prepare('SELECT * FROM images WHERE key=? AND bytes>0').get(originalKey) : null;
      await this.#sweep(original ? MAX_THUMB : limit + (thumbnail ? MAX_THUMB : 0), true, original?.key);
      try {
        const input = original ? this.#file(original.key) : temp;
        if (!original) await this.#download(url, temp, limit);
        const metadata = await decode(input).metadata();
        if (!formats[metadata.format] || !metadata.width || !metadata.height || metadata.width * metadata.height > 40e6) throw new Error('图片格式不支持或尺寸过大');
        let mime = metadata.format === 'heif' && metadata.compression === 'av1' ? 'image/avif' : formats[metadata.format], bytes;
        if (thumbnail) {
          const body = await decode(input).rotate().resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
          if (body.length > MAX_THUMB) throw new Error('缩略图超过容量上限');
          const thumb = await open(file, 'wx', 0o600); try { await thumb.writeFile(body); } finally { await thumb.close(); }
          bytes = body.length; mime = 'image/webp';
          if (original) this.#db.prepare('UPDATE images SET last_used=? WHERE key=?').run(this.clock(), original.key);
        } else { await rename(temp, file); bytes = (await stat(file)).size; }
        bytes = allocated(await stat(file));
        this.#db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?,0) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes,last_used=excluded.last_used,evicted=0').run(key, url, variant, mime, bytes, this.clock());
        return { body: await readFile(file), mime };
      } catch (error) {
        await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
        if (/sharp|Input|unsupported|corrupt|Vips|decode/i.test(error.message)) throw new Error('图片格式不支持或文件损坏');
        throw error;
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }
  async close() { this.#closed = true; clearInterval(this.#timer); for (const abort of this.#aborts) abort.abort(); await this.#tail; this.#db?.close(); }
}
