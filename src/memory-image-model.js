import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function magpieAdapter(module, config, store, model, signal) {
  let page;
  try { page = JSON.parse(await readFile(join(config.dataDir, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new ImageInputError('无法读取 Magpie 已保存的生效配置，未转发图片。'); page = {}; }
  if (!page || typeof page !== 'object' || Array.isArray(page) || ['baseUrl', 'apiKey'].some(key => page[key] !== undefined && typeof page[key] !== 'string')) throw new ImageInputError('Magpie 已保存的配置无效，未转发图片。');
  const endpoint = module.resolveEffectiveEndpoint(config, page);
  if (!module.isConfigured(endpoint)) throw new ImageInputError('Magpie 图片路线未配置有效的地址和凭据。');
  signal?.throwIfAborted();
  const catalog = new module.ModelCatalog({ ...endpoint, fetchImpl: (url, options) => fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal }) });
  await catalog.refreshOnce();
  signal?.throwIfAborted();
  if (!catalog.getEntry(model)) throw new ImageInputError('未能从 Magpie 当前目录确认所选图片模型，请检查模型目录后重试。');
  if (!catalog.supportsImage(model)) throw new ImageInputError('Magpie 当前模型未声明支持图片，未调用模型。');
  return new module.MagpieAdapter(catalog, { ...config, magpieBaseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, resolveAttachments: () => store });
}

export async function openMemoryImageModel(ctx, { provider, model, images, signal }) {
  signal?.throwIfAborted();
  const route = ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider);
  const entries = ctx.get?.('configEditor')?.entries() ?? [...(ctx.root?.get('loader')?.entries() ?? [])];
  const matches = entries.flatMap(entry => {
    if (!entry.fiber) return [];
    const module = entry.moduleNamespace;
    if (module?.MagpieAdapter && module?.ModelCatalog && module?.resolveConfig && module?.resolveEffectiveEndpoint && module?.isConfigured) {
      const config = module.resolveConfig(entry.fiber.config);
      return config.providerId === provider ? [{ entry, kind: 'magpie', config }] : [];
    }
    return route && (entry.options.id === route.settingsNs || entry.id === route.settingsNs) && module?.PiAiAdapter && entry.fiber.config.providers?.get?.()?.[provider] ? [{ entry, kind: 'pi-ai' }] : [];
  });
  if (matches.length !== 1) throw new ImageInputError(matches.length > 1 ? '所选模型对应多个生效配置，无法确定图片转发路线，请检查宿主模型配置。' : '当前模型路线不支持内存图片转发，或未找到所选模型的生效配置。');
  const { entry, kind, config } = matches[0];
  const module = entry?.moduleNamespace;
  if (kind === 'pi-ai' && (!module?.apply || !module?.Config)) throw new ImageInputError('当前 pi-ai 模型路线不支持内存图片转发。');
  const projections = new Map(), store = memoryImageStore(images, (id, info) => projections.set(id, info));
  let llm, owner;
  try {
    const namespace = await entry.parent.tree.import('@deepseek-ai/dsh-llm');
    const Runtime = namespace.default;
    const scope = ctx.isolate('llm').isolate('attachments').isolate('settings').isolate('authorization');
    owner = await scope.plugin({ async apply(child) {
      child.provide('attachments', store);
      llm = new Runtime(child);
      if (kind === 'magpie') llm.registerAdapter([provider], await magpieAdapter(module, config, store, model, signal));
      else await child.plugin({ Config: module.Config, inject: module.inject, apply: module.apply }, { providers: { [provider]: structuredClone(entry.fiber.config.providers.get()[provider]) } });
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
