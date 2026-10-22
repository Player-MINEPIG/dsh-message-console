import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { ImageInputError } from './escalation-images.js';

const digest = data => createHash('sha256').update(data).digest('hex');

export function memoryImageStore(images, onProjection = () => {}) {
  const objects = new Map(images.map(image => [image.ref.attachmentId, image]));
  const find = ref => {
    const image = objects.get(ref.attachmentId);
    if (!image || image.ref.bytes !== ref.bytes || image.ref.width !== ref.width || image.ref.height !== ref.height || image.ref.mediaType !== ref.mediaType) throw new Error('临时图片引用不匹配');
    return image;
  };
  return {
    imageHostPath: () => undefined,
    async readImage(ref, signal) { signal?.throwIfAborted(); return { ref, data: find(ref).data }; },
    async readImageRequest(ref, target, signal) {
      signal?.throwIfAborted();
      const source = find(ref);
      if (![target.width, target.height, target.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('临时图片请求规格无效');
      let data = source.data;
      if (target.width < ref.width || target.height < ref.height || data.length > target.maxBytes) {
        for (const quality of [85, 70, 50, 30]) {
          signal?.throwIfAborted();
          data = await sharp(source.data).resize({ width: Math.min(target.width, ref.width), height: Math.min(target.height, ref.height), fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').jpeg({ quality }).toBuffer();
          if (data.length <= target.maxBytes) break;
        }
      }
      const metadata = await sharp(data).metadata();
      signal?.throwIfAborted();
      onProjection(ref.attachmentId, { sha256: digest(data), bytes: data.length, width: metadata.width, height: metadata.height, mediaType: 'image/jpeg' });
      return { variantId: `sha256:${digest(data)}`, attachment: ref, data, mediaType: 'image/jpeg', bytes: data.length, width: metadata.width, height: metadata.height, depth: 'uchar', space: 'srgb', hasAlpha: false };
    },
    clear() { objects.clear(); },
  };
}

export async function openMemoryImageModel(ctx, { provider, model, images, signal }) {
  signal?.throwIfAborted();
  const route = ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider);
  const entry = route && ctx.loader?.resolve(route.settingsNs);
  const module = entry?.moduleNamespace;
  if (!entry?.fiber || !module?.PiAiAdapter || !module?.apply || !module?.Config) throw new ImageInputError('当前模型路线不支持内存图片转发，请使用宿主 pi-ai 模型路线。');
  const configured = entry.fiber.config.providers.get()[provider];
  if (!configured) throw new ImageInputError('未找到当前模型路线的生效配置，未转发图片。');
  const projections = new Map(), profile = structuredClone(configured), store = memoryImageStore(images, (id, info) => projections.set(id, info));
  let llm, owner;
  try {
    const namespace = await ctx.loader.import('@deepseek-ai/dsh-llm');
    const Runtime = namespace.default;
    const scope = ctx.isolate('llm').isolate('attachments').isolate('settings').isolate('authorization');
    owner = await scope.plugin({ async apply(child) {
      child.provide('attachments', store);
      llm = new Runtime(child);
      await child.plugin({ Config: module.Config, inject: module.inject, apply: module.apply }, { providers: { [provider]: profile } });
    } });
    const info = await llm.resolveModelInfo(provider, model, signal);
    if (!info.inputModalities?.includes('image')) throw new ImageInputError('内存转发路线未声明支持图片，未调用模型。');
    const dispatches = new WeakSet();
    return {
      isDispatch: request => dispatches.has(request),
      summary: () => ({ transport: 'memory', images: images.map(image => ({ ...image.metadata, sourceSha256: image.metadata.sha256, ...projections.get(image.ref.attachmentId) })) }),
      stream(request, messageId) {
        if (request.provider !== provider || request.model !== model) throw new Error('升级模型路线已变化，未转发图片');
        let found = false;
        const messages = request.messages.map(message => {
          if (message.id !== messageId) return message;
          found = true;
          return { ...message, content: [...message.content, ...images.flatMap(image => [{ type: 'text', text: image.label }, { type: 'image', attachment: image.ref }])] };
        });
        if (!found) throw new Error('升级输入已不在请求历史中，不能省略图片后继续判断');
        const outgoing = { ...request, messages };
        dispatches.add(outgoing);
        return llm.stream(outgoing);
      },
      async close() { try { await owner.dispose(); } finally { store.clear(); images.length = 0; } },
    };
  } catch (error) {
    await owner?.dispose(); store.clear(); images.length = 0;
    signal?.throwIfAborted();
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError(`内存图片转发未能初始化：${error.message}`);
  }
}
