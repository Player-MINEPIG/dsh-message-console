import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { memoryImageStore, openMemoryImageModel } from '../src/memory-image-model.js';

const data = await sharp({ create: { width: 120, height: 80, channels: 3, background: 'red' } }).jpeg().toBuffer();
const image = { data, ref: { attachmentId: 'sha256:fixture', mediaType: 'image/jpeg', bytes: data.length, width: 120, height: 80 } };
test('memory image resolver respects projection size, checks references, supports cancellation and releases its objects', async () => {
  const projections = [], store = memoryImageStore([image], (id, value) => projections.push({ id, ...value }));
  const request = await store.readImageRequest(image.ref, { width: 60, height: 60, maxBytes: 1048576 });
  assert.equal(request.width, 60); assert.equal(request.height, 40); assert.equal((await sharp(request.data).metadata()).format, 'jpeg'); assert.equal(projections[0].sha256.length, 64);
  assert.equal(store.imageHostPath(image.ref), undefined);
  await assert.rejects(store.readImageRequest({ ...image.ref, bytes: 1 }, { width: 60, height: 60, maxBytes: 1000 }), /不匹配/);
  await assert.rejects(store.readImageRequest(image.ref, { width: 0, height: 60, maxBytes: 1000 }), /规格/);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(store.readImageRequest(image.ref, { width: 60, height: 60, maxBytes: 1000 }, controller.signal), /cancelled/);
  store.clear(); await assert.rejects(store.readImage(image.ref), /不匹配/);
});

test('unsupported routes fail explicitly before any model request or persistent attachment operation', async () => {
  const ctx = { llm: { listConfigurableProviders: () => [] } };
  await assert.rejects(openMemoryImageModel(ctx, { provider: 'unknown', model: 'm', images: [image] }), /不支持内存图片转发/);
});
